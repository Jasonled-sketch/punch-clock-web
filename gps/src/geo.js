// 座標工具。安智連送的是 WGS84，跟 Google 地圖同一套，不需要做 GCJ-02 偏移修正。

const EARTH_RADIUS_M = 6371008.8;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** 兩點距離（公尺）。Haversine，幾百公尺的尺度誤差可忽略。 */
function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return Infinity;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 從客戶清單中找出半徑內最近的一個。
 * points 每筆需有 lat / lng，其餘欄位原樣帶回。
 */
function nearestWithin(point, points, radiusMeters) {
  let best = null;
  let bestDist = Infinity;
  for (const p of points || []) {
    if (p.lat == null || p.lng == null) continue;
    const d = distanceMeters(point, p);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (best && bestDist <= radiusMeters) {
    return { match: best, distanceMeters: Math.round(bestDist) };
  }
  return null;
}

module.exports = { distanceMeters, nearestWithin, EARTH_RADIUS_M };
