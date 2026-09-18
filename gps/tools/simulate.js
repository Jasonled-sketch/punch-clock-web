#!/usr/bin/env node
// 裝機前先驗證整條路：模擬一台車出門、到客戶、停留、離開。
//
//   AZLIOT_TF_KEY=你的key node tools/simulate.js http://localhost:3000/azliot/lpush
//
// 選項（環境變數）：
//   SIM_IMEI      預設 868120214425578
//   SIM_PLATE     預設 ABC-1234
//   SIM_LAT/LNG   客戶座標，預設台中市政府
//   SIM_SPEEDUP   時間加速倍率，預設 600（1 秒模擬 10 分鐘）

const { md5 } = require('../src/md5');

// SIM_MODE=azliot（預設）走安智連 LPush；SIM_MODE=traccar 走自架 Traccar 轉發
const MODE = (process.env.SIM_MODE || 'azliot').toLowerCase();
const endpoint = process.argv[2]
  || (MODE === 'traccar' ? 'http://localhost:3000/traccar/position' : 'http://localhost:3000/azliot/lpush');

const KEY = process.env.AZLIOT_TF_KEY;
const TRACCAR_TOKEN = process.env.TRACCAR_INGEST_TOKEN;
if (MODE === 'azliot' && !KEY) {
  console.error('請設定 AZLIOT_TF_KEY（個人中心拿到的 tfKey）');
  process.exit(1);
}
if (MODE === 'traccar' && !TRACCAR_TOKEN) {
  console.error('請設定 TRACCAR_INGEST_TOKEN（跟 Traccar forward.header 同一組）');
  process.exit(1);
}
const KNOTS = 1.852;

const IMEI = process.env.SIM_IMEI || '868120214425578';
const PLATE = process.env.SIM_PLATE || 'ABC-1234';
const DEST_LAT = Number(process.env.SIM_LAT || 24.1477);
const DEST_LNG = Number(process.env.SIM_LNG || 120.6736);
const SPEEDUP = Number(process.env.SIM_SPEEDUP || 600);

const start = Date.now();
const fmt = (ms) => {
  const d = new Date(ms + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

async function sendTraccar(data) {
  // 模擬 Traccar 的轉發格式。speed 送「節」，跟 Traccar 預設一致。
  const payload = {
    device: { uniqueId: IMEI, name: PLATE, status: 'online' },
    position: {
      deviceId: 1,
      protocol: 'gt06',
      valid: true,
      outdated: false,
      fixTime: new Date(data.__at).toISOString(),
      deviceTime: new Date(data.__at).toISOString(),
      latitude: data.lat,
      longitude: data.lng,
      altitude: 0,
      speed: data.speed / KNOTS,
      course: data.dir,
      attributes: { ignition: data.acc === 1, motion: data.speed > 0, sat: data.gNum, power: data.vol, charge: true },
    },
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': TRACCAR_TOKEN },
    body: JSON.stringify(payload),
  });
  return { status: res.status, text: (await res.text()).slice(0, 120) };
}

async function send(lpushType, data) {
  if (MODE === 'traccar') {
    // 心跳包在 Traccar 那邊沒有對應，直接跳過
    if (lpushType !== 2) return { status: 200, text: '(traccar 模式略過非定位包)' };
    return sendTraccar(data);
  }
  const ds = JSON.stringify(data);
  const time = String(Math.floor(Date.now() / 1000));
  const body = new URLSearchParams({
    LPushType: String(lpushType),
    time,
    token: md5(KEY + time + ds),
    data: ds,
  }).toString();

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 120) };
}

const location = (atMs, lat, lng, speed, acc) => ({
  gType: 1, imei: IMEI, plateNum: PLATE, lat, lng, speed, dir: 90,
  vol: 12.6, gtm: fmt(atMs), ctm: fmt(atMs), acc, ups: 1, bat: 95, gsm: 26, gNum: 14,
  __at: atMs, // 只給 traccar 模式用
});

const sleep = (realMs) => new Promise((r) => setTimeout(r, Math.max(30, realMs / SPEEDUP)));

async function main() {
  console.log(`模擬送往 ${endpoint}（模式：${MODE}）`);
  console.log(`車輛 ${PLATE}（${IMEI}）目的地 ${DEST_LAT},${DEST_LNG}\n`);

  let t = start;
  const step = 60000; // 模擬時間每步 1 分鐘

  console.log('階段 1／4：出發行駛 10 分鐘');
  for (let i = 10; i > 0; i -= 1) {
    const lat = DEST_LAT + 0.004 * i;
    const lng = DEST_LNG + 0.004 * i;
    const r = await send(2, location(t, lat, lng, 45, 1));
    process.stdout.write(`  行駛中 ${r.status} `);
    t += step;
    await sleep(step);
  }

  console.log('\n\n階段 2／4：抵達並熄火');
  const r1 = await send(2, location(t, DEST_LAT + 0.0001, DEST_LNG + 0.0001, 0, 0));
  console.log(`  到達 ${r1.status} ${r1.text}`);
  t += step;

  console.log('\n階段 3／4：停留 35 分鐘（含心跳包）');
  for (let i = 0; i < 35; i += 1) {
    const jitter = (i % 3) * 0.00008; // 模擬停車時的 GPS 漂移
    if (i % 3 === 0) {
      await send(1, { imei: IMEI, plateNum: PLATE, vol: 12.6, ctm: fmt(t), acc: 0, ups: 1, bat: 95, gsm: 26 });
      process.stdout.write('♥');
    } else {
      await send(2, location(t, DEST_LAT + jitter, DEST_LNG + jitter, 0, 0));
      process.stdout.write('.');
    }
    t += step;
    await sleep(step);
  }

  console.log('\n\n階段 4／4：發動離開');
  for (let i = 1; i <= 4; i += 1) {
    const r = await send(2, location(t, DEST_LAT + 0.006 * i, DEST_LNG + 0.006 * i, 40, 1));
    console.log(`  離開中 ${r.status} ${r.text}`);
    t += step;
    await sleep(step);
  }

  console.log('\n完成。去 Ragic 看有沒有長出一筆約 35 分鐘的拜訪記錄。');
  console.log('沒有的話看服務的 log：驗簽失敗會寫「封包被拒」，客戶比對不到會寫「未建檔地點」。');
}

main().catch((err) => {
  console.error('\n模擬失敗:', err.message);
  console.error('確認服務有起來，而且網址和 AZLIOT_TF_KEY 都對。');
  process.exit(1);
});
