// 假裝成一台 GT06 定位器，直接連 Traccar 的 TCP 埠，模擬一趟拜訪：
// 行駛 10 分鐘 → 停 35 分鐘 → 開走。時間戳全部落在過去一小時內。
// 硬體還沒到就能驗證「定位器 → Traccar → 接收服務 → Ragic」整條線。
// 前提：Traccar 要先登記這個 IMEI，或暫時設 DATABASE_REGISTER_UNKNOWN=true（測完關掉）。
// 用法: node tools/gt06-sim.js <Traccar主機> <埠> <imei15> [--dry]
const net = require('net');

const [, , HOST, PORT, IMEI, DRY] = process.argv;
const DEST = { lat: 24.1477, lng: 120.6736 };

function crcItu(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return ~crc & 0xffff;
}

let serial = 1;
function packet(proto, content) {
  const body = Buffer.concat([
    Buffer.from([content.length + 5, proto]),
    content,
    Buffer.from([serial >> 8, serial & 0xff]),
  ]);
  serial += 1;
  const crc = crcItu(body);
  return Buffer.concat([Buffer.from([0x78, 0x78]), body, Buffer.from([crc >> 8, crc & 0xff, 0x0d, 0x0a])]);
}

function login(imei) {
  return packet(0x01, Buffer.from(('0' + imei).padStart(16, '0'), 'hex'));
}

function location(ms, lat, lng, speedKmh, course) {
  const d = new Date(ms);
  const c = Buffer.alloc(26);
  c.writeUInt8(d.getUTCFullYear() - 2000, 0);
  c.writeUInt8(d.getUTCMonth() + 1, 1);
  c.writeUInt8(d.getUTCDate(), 2);
  c.writeUInt8(d.getUTCHours(), 3);
  c.writeUInt8(d.getUTCMinutes(), 4);
  c.writeUInt8(d.getUTCSeconds(), 5);
  c.writeUInt8(0xc9, 6); // GPS 資料長度 12、衛星 9 顆
  c.writeUInt32BE(Math.round(Math.abs(lat) * 1800000), 7);
  c.writeUInt32BE(Math.round(Math.abs(lng) * 1800000), 11);
  c.writeUInt8(speedKmh, 15);
  const flags = (1 << 12) | (1 << 10) | (course & 0x3ff); // 已定位、北緯、東經
  c.writeUInt16BE(flags, 16);
  c.writeUInt16BE(466, 18); // MCC 台灣
  c.writeUInt8(92, 20); // MNC
  c.writeUInt16BE(0x1234, 21); // LAC
  c.writeUIntBE(0x00abcd, 23, 3); // Cell ID
  return packet(0x12, c);
}

// 組出整趟路線
const now = Date.now();
const start = now - 55 * 60000;
const pts = [];
for (let m = 0; m <= 10; m++) {
  // 從東北方約 3 公里處開過來
  const f = 1 - m / 10;
  pts.push([start + m * 60000, DEST.lat + 0.02 * f, DEST.lng + 0.02 * f, m === 10 ? 0 : 40, 225]);
}
for (let m = 15; m <= 45; m += 5) pts.push([start + m * 60000, DEST.lat, DEST.lng, 0, 0]);
for (let m = 1; m <= 5; m++) {
  pts.push([start + (45 + m) * 60000, DEST.lat - 0.004 * m, DEST.lng - 0.004 * m, 45, 225]);
}

if (DRY) {
  console.log('login', login(IMEI).toString('hex'));
  console.log('first loc', location(...pts[0]).toString('hex'));
  console.log('points', pts.length, 'span min', Math.round((pts[pts.length - 1][0] - pts[0][0]) / 60000));
  process.exit(0);
}

const sock = net.connect(Number(PORT), HOST, async () => {
  console.log('已連上 Traccar');
  sock.write(login(IMEI));
  await new Promise((r) => setTimeout(r, 1500));
  for (const p of pts) {
    sock.write(location(...p));
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('送出', pts.length, '個定位點');
  setTimeout(() => sock.end(), 2000);
});
let acks = 0;
sock.on('data', (b) => { acks += 1; if (acks === 1) console.log('收到 Traccar 回應', b.slice(3, 4).toString('hex') === '01' ? '（登入確認）' : b.toString('hex')); });
sock.on('error', (e) => console.log('連線錯誤', e.code));
sock.on('close', () => console.log('連線結束，Traccar 共回應', acks, '次'));
