// 安智連 LPush 封包：解析 + 驗簽 + 正規化
//
// 文件重點（open.azliot.com / LPush位置）：
//   Content-Type: application/x-www-form-urlencoded 或 application/json，UTF-8
//   body: LPushType, time, token, data
//   token = md5(key + time + data)
//   坐標系 wgs84（不是 GCJ-02，不用做偏移修正）
//
// LPushType 對照（文件分散在多頁，這裡整合）：
//   1 心跳包   3m（停止）/ 5m（休眠）
//   2 定位包   行駛中 10-20 秒一次
//   3 OBD 資料
//   4 告警     點火/副引擎/超速/斷電/停留/圍欄/疲勞駕駛
//   5 工牌簽到 上下班打卡（特定設備）
//   6 里程包   里程變化時送，可能延遲 5-10 分鐘

const { md5 } = require('./md5');

const PACKET_TYPES = {
  1: 'heartbeat',
  2: 'location',
  3: 'obd',
  4: 'alarm',
  5: 'badge',
  6: 'mileage',
};

// 平台時間字串沒有時區。安智連在中國，送的是 UTC+8；台灣同為 UTC+8，
// 所以預設 8 就等於台灣本地時間。真的對不上時用 AZLIOT_TZ_OFFSET 調。
const DEFAULT_TZ_OFFSET = 8;

class LPushError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LPushError';
    this.code = code || 'bad_request';
  }
}

/**
 * 從原始 JSON body 文字中，抓出 "data" 欄位「未經重新序列化」的原始子字串。
 *
 * 這是整份整合最容易踩的雷：token 是對「收到的那串 data」做 md5。
 * 把 JSON parse 完再 JSON.stringify 回去，空白、跳脫字元、數字表示法
 * 都可能跟原文差一個 byte，md5 就全錯，看起來像金鑰錯誤。
 */
function extractRawJsonField(bodyText, fieldName) {
  const needle = new RegExp(`"${fieldName}"\\s*:\\s*`);
  const m = needle.exec(bodyText);
  if (!m) return null;

  let i = m.index + m[0].length;
  const first = bodyText[i];

  if (first === '{' || first === '[') {
    const open = first;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < bodyText.length; j += 1) {
      const ch = bodyText[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return bodyText.slice(i, j + 1);
      }
    }
    return null;
  }

  if (first === '"') {
    let esc = false;
    for (let j = i + 1; j < bodyText.length; j += 1) {
      const ch = bodyText[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') return bodyText.slice(i, j + 1);
    }
    return null;
  }

  // 數字 / true / false / null
  const rest = bodyText.slice(i);
  const scalar = /^[^,}\]\s]+/.exec(rest);
  return scalar ? scalar[0] : null;
}

function stripQuotes(s) {
  if (typeof s !== 'string') return s;
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try { return JSON.parse(s); } catch (_) { return s.slice(1, -1); }
  }
  return s;
}

/**
 * 解析原始 body（form-urlencoded 或 JSON），取出四個欄位，
 * 同時保留 time / data 的原始字串形式供驗簽使用。
 */
function parseEnvelope(bodyText, contentType) {
  const ct = String(contentType || '').toLowerCase();
  const text = String(bodyText == null ? '' : bodyText);

  if (ct.includes('application/json') || (!ct.includes('urlencoded') && text.trim().startsWith('{'))) {
    let outer;
    try {
      outer = JSON.parse(text);
    } catch (e) {
      throw new LPushError(`JSON body 解析失敗: ${e.message}`, 'bad_json');
    }
    const rawData = extractRawJsonField(text, 'data');
    const rawTime = extractRawJsonField(text, 'time');
    let data = outer.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { /* 維持字串 */ }
    }
    return {
      lpushType: Number(outer.LPushType),
      token: String(outer.token || ''),
      time: outer.time,
      data,
      rawTime: rawTime != null ? stripQuotes(rawTime) : String(outer.time),
      rawData: rawData != null ? stripQuotes(rawData) : null,
      transport: 'json',
    };
  }

  const params = new URLSearchParams(text);
  const rawData = params.get('data');
  let data = rawData;
  if (typeof rawData === 'string') {
    try { data = JSON.parse(rawData); } catch (_) { data = rawData; }
  }
  return {
    lpushType: Number(params.get('LPushType')),
    token: String(params.get('token') || ''),
    time: params.get('time'),
    data,
    rawTime: params.get('time'),
    rawData,
    transport: 'form',
  };
}

/**
 * 驗簽：token = md5(key + time + data)
 *
 * 平台送來的 time 在文件裡同時出現 10 位（秒）和 13 位（毫秒）兩種寫法，
 * data 又有 raw / 重新序列化兩種可能，所以列出幾個候選組合逐一比對。
 * 候選全部由「實際收到的位元組」推導而來，多試幾種不會降低安全性——
 * 沒有金鑰就算不出任何一個 md5。
 */
function verifySignature(envelope, key) {
  const token = String(envelope.token || '').toLowerCase();
  if (!token) return { ok: false, reason: 'token 欄位是空的' };
  if (!key) return { ok: false, reason: '沒有設定 AZLIOT_TF_KEY' };

  const times = [];
  if (envelope.rawTime != null) times.push(String(envelope.rawTime));
  if (envelope.time != null && !times.includes(String(envelope.time))) times.push(String(envelope.time));

  const datas = [];
  if (envelope.rawData != null) datas.push(String(envelope.rawData));
  if (envelope.data != null && typeof envelope.data === 'object') {
    const serialized = JSON.stringify(envelope.data);
    if (!datas.includes(serialized)) datas.push(serialized);
  } else if (typeof envelope.data === 'string' && !datas.includes(envelope.data)) {
    datas.push(envelope.data);
  }

  const tried = [];
  for (const t of times) {
    for (const d of datas) {
      const got = md5(`${key}${t}${d}`).toLowerCase();
      tried.push(got);
      if (got === token) return { ok: true, matchedTime: t };
    }
  }
  return {
    ok: false,
    reason: '驗簽不符',
    expectedAnyOf: tried,
    got: token,
  };
}

function toNum(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** "2019-07-05 19:24:58" → epoch 毫秒（把字串當成 UTC+offset 解讀） */
function parsePlatformTime(s, tzOffsetHours) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s).trim());
  if (!m) {
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n;
    return null;
  }
  const off = tzOffsetHours === undefined ? DEFAULT_TZ_OFFSET : tzOffsetHours;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - off, +m[5], +m[6]);
}

/**
 * 把六種封包攤平成同一個形狀，後面的判斷邏輯就只需要認識這一種物件。
 * 沒有的欄位一律 null，不要用 0 頂替——0 在 acc / speed 都是有意義的值。
 */
function normalize(envelope, options) {
  const opts = options || {};
  const tz = opts.tzOffsetHours === undefined ? DEFAULT_TZ_OFFSET : opts.tzOffsetHours;
  const d = (envelope.data && typeof envelope.data === 'object') ? envelope.data : {};
  const kind = PACKET_TYPES[envelope.lpushType] || `unknown_${envelope.lpushType}`;

  const timeFieldRaw = d.gtm || d.ctm || d.alarmTime || d.signTime || null;
  const envelopeMs = (() => {
    const n = Number(envelope.time);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e11 ? n * 1000 : n; // 10 位=秒，13 位=毫秒
  })();

  const out = {
    kind,
    lpushType: envelope.lpushType,
    imei: d.imei != null ? String(d.imei) : null,
    plateNum: d.plateNum != null ? String(d.plateNum) : null,
    // 封包自帶的時間優先；沒有才退回外層 time
    at: parsePlatformTime(timeFieldRaw, tz) || envelopeMs,
    atText: timeFieldRaw ? String(timeFieldRaw) : null,
    receivedAt: Date.now(),
    lat: null,
    lng: null,
    // gType 1=衛星定位、2=基站定位。基站定位誤差可達數百公尺到數公里，
    // 拿去比對客戶座標會產生假的到點記錄，所以標成不可信。
    fixType: null,
    trustedFix: false,
    speed: null,
    dir: toNum(d.dir, null),
    acc: d.acc === undefined || d.acc === null || d.acc === '' ? null : toNum(d.acc, null),
    ups: d.ups === undefined || d.ups === null || d.ups === '' ? null : toNum(d.ups, null),
    bat: toNum(d.bat, null),
    vol: toNum(d.vol, null),
    gsm: toNum(d.gsm, null),
    gNum: toNum(d.gNum, null),
    alarmType: null,
    badge: null,
    mileage: null,
    raw: d,
  };

  if (d.lat !== undefined && d.lng !== undefined) {
    const lat = toNum(d.lat, null);
    const lng = toNum(d.lng, null);
    // 0,0 是幾內亞灣的海面，實務上等於「還沒定到位」，不要當成有效座標
    if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        && !(lat === 0 && lng === 0)) {
      out.lat = lat;
      out.lng = lng;
    }
  }

  if (kind === 'location') {
    out.fixType = toNum(d.gType, null);
    out.speed = toNum(d.speed, null);
    out.trustedFix = out.fixType === 1 && out.lat !== null;
  } else if (kind === 'alarm') {
    out.alarmType = d.alarmType ? String(d.alarmType) : null;
    // 告警包沒有 gType。座標來源不明，同樣不拿來當地理判斷的依據。
    out.trustedFix = false;
  } else if (kind === 'badge') {
    const rawSign = d.signType;
    const signNum = toNum(rawSign, null);
    out.badge = {
      signType: signNum,
      direction: signNum === 1 ? 'in' : signNum === 2 ? 'out' : 'unknown',
      signTime: d.signTime ? String(d.signTime) : null,
      signTimeMs: parsePlatformTime(d.signTime, tz),
      mileageMeters: toNum(d.mil, null),
    };
    out.trustedFix = out.lat !== null;
  } else if (kind === 'mileage') {
    out.mileage = {
      date: d.date ? String(d.date) : null,
      dayMeters: toNum(d.mil, null),
      dayAccSeconds: toNum(d.accWorkTime, null),
      totalMeters: toNum(d.allTotalMil, null),
      totalAccSeconds: toNum(d.allAccWorkTime, null),
    };
  }

  return out;
}

/** 一步到位：原始 body → 驗簽 → 正規化封包 */
function receive(bodyText, contentType, options) {
  const opts = options || {};
  const envelope = parseEnvelope(bodyText, contentType);

  if (!Number.isFinite(envelope.lpushType)) {
    throw new LPushError('body 裡沒有有效的 LPushType', 'bad_request');
  }

  const sig = verifySignature(envelope, opts.tfKey);
  if (!sig.ok && !opts.allowUnsigned) {
    throw new LPushError(`驗簽失敗: ${sig.reason}`, 'bad_signature');
  }

  const packet = normalize(envelope, opts);
  packet.signatureVerified = sig.ok;
  return packet;
}

module.exports = {
  receive,
  parseEnvelope,
  verifySignature,
  normalize,
  parsePlatformTime,
  extractRawJsonField,
  PACKET_TYPES,
  LPushError,
};
