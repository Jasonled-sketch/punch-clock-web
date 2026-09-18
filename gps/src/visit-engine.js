// 到點 / 離開判斷引擎
//
// 為什麼不直接用平台的「停留告警」：STAY_ALARM 只告訴你「停很久」，
// 不告訴你停在誰那裡，而且門檻是平台端設定的。自己算才能把「停在哪個客戶」
// 和「停多久」綁在一起，一次寫成一筆拜訪記錄。
//
// 設計原則：
//   1. 只有衛星定位（gType=1）能用來做地理判斷。基站定位誤差數百公尺到數公里，
//      拿去比對客戶座標會生出假的到點記錄。
//   2. 進出要有遲滯（leaveRadius > matchRadius），否則車停在邊界會不停進出跳動。
//   3. 熄火（acc=0）是很強的「真的停下來了」訊號，可以縮短等待時間。
//   4. 車子可能在拜訪途中離線（地下室、沒訊號），要有 sweep 收尾，否則拜訪永遠不結束。

const { distanceMeters, nearestWithin } = require('./geo');

const DEFAULTS = {
  movingSpeedKmh: 5,        // 高於此速度視為移動中
  stopJitterMeters: 80,     // 停車時 GPS 漂移容許範圍，超過視為換了地點
  dwellMinutes: 3,          // 靜止多久才算「到點」（引擎還開著時）
  dwellMinutesAccOff: 1,    // 熄火時縮短，熄火本身就代表停妥了
  matchRadiusMeters: 200,   // 距客戶座標多近算到達
  leaveRadiusMeters: 350,   // 離開多遠算走了（要大於 matchRadius，做遲滯）
  minVisitMinutes: 5,       // 短於此不成案，過濾等紅燈、路邊臨停
  offlineCloseMinutes: 45,  // 離線多久就把未結束的拜訪收掉
};

/**
 * 合併設定。不能直接用 Object.assign：它會把值為 undefined 的鍵覆蓋上去，
 * 讓預設值變成 undefined，之後所有數值比較（speed > undefined）都會是 false，
 * 到點和離開就永遠不會觸發。NaN 同理（Number('') 會是 NaN）。
 */
function mergeConfig(config) {
  const out = Object.assign({}, DEFAULTS);
  for (const [k, v] of Object.entries(config || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

function createState(imei) {
  return {
    imei,
    plateNum: null,
    lastSeenAt: null,
    lastTrustedFix: null,   // {lat, lng, at}
    lastAcc: null,
    stopAnchor: null,       // {lat, lng}
    stopSince: null,
    visit: null,            // 進行中的拜訪
  };
}

function minutesBetween(a, b) {
  return Math.abs(b - a) / 60000;
}

/**
 * 吃一個正規化封包，回傳 { state, events }。
 * state 會被就地更新（呼叫端負責存回去）。
 */
function onPacket(state, packet, customers, config) {
  const cfg = mergeConfig(config);
  const events = [];
  const now = packet.at || packet.receivedAt || Date.now();

  if (packet.plateNum) state.plateNum = packet.plateNum;
  if (packet.at) state.lastSeenAt = Math.max(state.lastSeenAt || 0, packet.at);

  // ── 告警：原樣轉出去，交給上層決定要不要通知 ──
  if (packet.kind === 'alarm') {
    events.push({
      type: 'alarm',
      imei: state.imei,
      plateNum: state.plateNum,
      alarmType: packet.alarmType,
      at: now,
      lat: packet.lat,
      lng: packet.lng,
    });
    return { state, events };
  }

  // ── 工牌簽到：本身就是一筆完整的上下班打卡，不走停留判斷 ──
  if (packet.kind === 'badge') {
    const near = packet.lat != null
      ? nearestWithin({ lat: packet.lat, lng: packet.lng }, customers, cfg.matchRadiusMeters)
      : null;
    events.push({
      type: 'badge',
      imei: state.imei,
      badgeName: packet.plateNum,
      direction: packet.badge.direction,
      at: packet.badge.signTimeMs || now,
      lat: packet.lat,
      lng: packet.lng,
      mileageMeters: packet.badge.mileageMeters,
      nearCustomer: near ? near.match : null,
      nearDistanceMeters: near ? near.distanceMeters : null,
    });
    return { state, events };
  }

  if (packet.kind === 'mileage') {
    events.push({ type: 'mileage', imei: state.imei, plateNum: state.plateNum, at: now, mileage: packet.mileage });
    return { state, events };
  }

  // ── 心跳包：沒有座標，但 acc 有用。熄火代表停妥了 ──
  if (packet.kind === 'heartbeat') {
    if (packet.acc !== null) state.lastAcc = packet.acc;
    return { state, events };
  }

  if (packet.kind !== 'location') return { state, events };

  if (packet.acc !== null) state.lastAcc = packet.acc;

  // 基站定位不參與地理判斷，但可以更新「還活著」的時間
  if (!packet.trustedFix) return { state, events };

  const fix = { lat: packet.lat, lng: packet.lng, at: now };
  state.lastTrustedFix = fix;

  const speed = packet.speed == null ? 0 : packet.speed;
  const isMoving = speed > cfg.movingSpeedKmh;

  if (isMoving) {
    // 移動中：先看看是不是離開了進行中的拜訪
    if (state.visit) {
      const away = distanceMeters(fix, { lat: state.visit.lat, lng: state.visit.lng });
      if (away > cfg.leaveRadiusMeters) {
        events.push(closeVisit(state, now, 'moved_away', cfg));
      }
    }
    state.stopAnchor = null;
    state.stopSince = null;
    return { state, events: events.filter(Boolean) };
  }

  // ── 靜止中 ──
  if (!state.stopAnchor || distanceMeters(fix, state.stopAnchor) > cfg.stopJitterMeters) {
    // 換地方停了：先結束舊的拜訪，再開始計時新的停留
    if (state.visit) {
      const away = distanceMeters(fix, { lat: state.visit.lat, lng: state.visit.lng });
      if (away > cfg.leaveRadiusMeters) {
        events.push(closeVisit(state, now, 'moved_away', cfg));
      }
    }
    state.stopAnchor = { lat: fix.lat, lng: fix.lng };
    state.stopSince = now;
    return { state, events: events.filter(Boolean) };
  }

  if (state.visit) {
    state.visit.lastConfirmedAt = now;
    return { state, events: events.filter(Boolean) };
  }

  const dwellNeeded = state.lastAcc === 0 ? cfg.dwellMinutesAccOff : cfg.dwellMinutes;
  if (minutesBetween(state.stopSince, now) < dwellNeeded) {
    return { state, events: events.filter(Boolean) };
  }

  // 停夠久了 → 找最近的客戶
  const near = nearestWithin(state.stopAnchor, customers, cfg.matchRadiusMeters);
  state.visit = {
    customerId: near ? near.match.id : null,
    customerName: near ? near.match.name : null,
    customerDistanceMeters: near ? near.distanceMeters : null,
    lat: state.stopAnchor.lat,
    lng: state.stopAnchor.lng,
    arrivedAt: state.stopSince,
    lastConfirmedAt: now,
  };

  events.push({
    type: 'arrival',
    imei: state.imei,
    plateNum: state.plateNum,
    at: state.stopSince,
    lat: state.visit.lat,
    lng: state.visit.lng,
    customer: near ? near.match : null,
    customerDistanceMeters: near ? near.distanceMeters : null,
    accOff: state.lastAcc === 0,
  });

  return { state, events: events.filter(Boolean) };
}

function closeVisit(state, departedAt, reason, config) {
  const cfg = mergeConfig(config);
  const visit = state.visit;
  state.visit = null;
  if (!visit) return null;

  const durationMinutes = minutesBetween(visit.arrivedAt, departedAt);
  if (durationMinutes < cfg.minVisitMinutes) {
    return { type: 'visit_discarded', imei: state.imei, reason: 'too_short', durationMinutes };
  }

  return {
    type: 'departure',
    imei: state.imei,
    plateNum: state.plateNum,
    customerId: visit.customerId,
    customerName: visit.customerName,
    customerDistanceMeters: visit.customerDistanceMeters,
    lat: visit.lat,
    lng: visit.lng,
    arrivedAt: visit.arrivedAt,
    departedAt,
    durationMinutes: Math.round(durationMinutes),
    reason,
  };
}

/**
 * 掃描所有裝置，把離線太久而卡住的拜訪收掉。
 * 沒有這個，車子開進地下停車場沒訊號，拜訪就永遠不會結束。
 */
function sweep(states, now, config) {
  const cfg = mergeConfig(config);
  const events = [];
  for (const state of states) {
    if (!state.visit) continue;
    const silentFor = minutesBetween(state.lastSeenAt || state.visit.lastConfirmedAt, now);
    if (silentFor >= cfg.offlineCloseMinutes) {
      const ev = closeVisit(state, state.visit.lastConfirmedAt, 'offline_timeout', cfg);
      if (ev) events.push(ev);
    }
  }
  return events;
}

module.exports = { createState, onPacket, sweep, closeVisit, mergeConfig, DEFAULTS };
