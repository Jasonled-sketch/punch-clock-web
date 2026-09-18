// Traccar 轉接層
//
// 走「蝦皮買 GT06 定位器 + 自架 Traccar」這條路時用這個，
// 取代 lpush.js。後面的判斷、Ragic 寫入、AI 摘要完全不用改。
//
// Traccar 設定（conf/traccar.xml）：
//   <entry key='forward.enable'>true</entry>
//   <entry key='forward.url'>https://你的網址/traccar/position</entry>
//   <entry key='forward.type'>json</entry>
//   <entry key='forward.header'>X-Ingest-Token: 你設的密碼</entry>
//
// Traccar 送來的形狀：
//   { "position": {...}, "device": {...}, "event": {...} }
//   event 只有在事件轉發時才有。

// ⚠ Traccar 的 speed 預設單位是「節」，不是公里。
// 1 節 = 1.852 公里。不換算的話，時速 15 公里的車會被讀成 8，
// 低於移動門檻，變成「靜止」，於是路上塞車都會被記成拜訪客戶。
const KNOTS_TO_KMH = 1.852;

const SPEED_UNITS = {
  kn: KNOTS_TO_KMH,
  knots: KNOTS_TO_KMH,
  kmh: 1,
  mps: 3.6,
  mph: 1.609344,
};

// 把 Traccar 的告警名稱對到安智連那套，讓下游只需要認得一種詞彙。
const ALARM_MAP = {
  powerCut: 'POWER_OFF',
  powerOff: 'POWER_OFF',
  lowPower: 'POWER_OFF',
  ignitionOn: 'ACC_ON',
  overspeed: 'OVER_SPEED',
  geofence: 'FENCE',
  geofenceEnter: 'FENCE',
  geofenceExit: 'FENCE',
  parking: 'STAY_ALARM',
  idle: 'STAY_ALARM',
};

class TraccarError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TraccarError';
    this.code = code || 'bad_request';
  }
}

/** 不隨長度提早結束的字串比較，避免用回應時間猜出 token。 */
function safeEqual(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function toMs(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function num(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Traccar 的 payload → 跟 lpush.normalize 一樣的形狀。
 * 下游的 visit-engine / handler 分不出資料是哪裡來的。
 */
function normalizeTraccar(payload, options) {
  const opts = options || {};
  const body = payload || {};
  const pos = body.position || {};
  const dev = body.device || {};
  const attrs = pos.attributes || {};

  const imei = dev.uniqueId != null ? String(dev.uniqueId)
    : (pos.deviceId != null ? String(pos.deviceId) : null);
  if (!imei) throw new TraccarError('payload 裡找不到 device.uniqueId', 'bad_request');

  const factor = SPEED_UNITS[String(opts.speedUnit || 'kn').toLowerCase()] || KNOTS_TO_KMH;
  const speedRaw = num(pos.speed, null);
  const speedKmh = speedRaw === null ? null : speedRaw * factor;

  const lat = num(pos.latitude, null);
  const lng = num(pos.longitude, null);
  const hasCoords = lat !== null && lng !== null
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

  // valid=false 多半是基站定位或沒定到位，outdated=true 是補傳的舊點。
  // 兩者都不該拿來判斷「現在停在哪個客戶」——這對應 LPush 的 gType 檢查。
  const trustedFix = hasCoords && pos.valid === true && pos.outdated !== true;

  const at = toMs(pos.fixTime) || toMs(pos.deviceTime) || toMs(pos.serverTime) || Date.now();

  const rawAlarm = attrs.alarm ? String(attrs.alarm) : null;
  const isEvent = !!(body.event && body.event.type);
  const eventAlarm = isEvent && body.event.type === 'alarm' ? (body.event.attributes && body.event.attributes.alarm) : null;
  const alarm = rawAlarm || (eventAlarm ? String(eventAlarm) : null);

  const packet = {
    kind: alarm ? 'alarm' : 'location',
    lpushType: alarm ? 4 : 2,
    imei,
    plateNum: dev.name ? String(dev.name) : null,
    at,
    atText: pos.fixTime || pos.deviceTime || null,
    receivedAt: Date.now(),
    lat: hasCoords ? lat : null,
    lng: hasCoords ? lng : null,
    fixType: pos.valid === true ? 1 : 2,
    trustedFix,
    speed: speedKmh === null ? null : Math.round(speedKmh * 10) / 10,
    dir: num(pos.course, null),
    acc: attrs.ignition === undefined ? null : (attrs.ignition ? 1 : 0),
    ups: attrs.charge === undefined ? null : (attrs.charge ? 1 : 0),
    bat: num(attrs.batteryLevel, null),
    vol: num(attrs.power, null),
    gsm: num(attrs.rssi, null),
    gNum: num(attrs.sat, null),
    alarmType: alarm ? (ALARM_MAP[alarm] || alarm.toUpperCase()) : null,
    badge: null,
    mileage: null,
    signatureVerified: true, // 驗證是在 HTTP 層用 token header 做的
    source: 'traccar',
    raw: body,
  };

  // 告警包的座標不拿來做地理判斷，跟 LPush 那邊保持一致
  if (packet.kind === 'alarm') packet.trustedFix = false;

  return packet;
}

/**
 * 收一包 Traccar 轉發。Traccar 不簽章，所以靠 forward.header 帶共享密碼。
 * @param {string} bodyText 原始 body
 * @param {object} headers  請求標頭（小寫 key）
 */
function receiveTraccar(bodyText, headers, options) {
  const opts = options || {};
  const h = headers || {};

  if (opts.ingestToken) {
    const provided = h['x-ingest-token'] || h['X-Ingest-Token'];
    if (!safeEqual(provided, opts.ingestToken)) {
      throw new TraccarError('X-Ingest-Token 不符', 'bad_signature');
    }
  } else if (!opts.allowUnsigned) {
    throw new TraccarError('沒有設定 TRACCAR_INGEST_TOKEN，拒收', 'bad_signature');
  }

  let payload;
  try {
    payload = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
  } catch (e) {
    throw new TraccarError(`JSON 解析失敗: ${e.message}`, 'bad_json');
  }

  return normalizeTraccar(payload, opts);
}

module.exports = {
  receiveTraccar,
  normalizeTraccar,
  safeEqual,
  ALARM_MAP,
  KNOTS_TO_KMH,
  TraccarError,
};
