// 全部測試。node test/run.js
// 不連外網、不打 Ragic、不打 Claude API，可以隨時跑。

const assert = require('node:assert');
const { md5, md5Pure } = require('../src/md5');
const { receive } = require('../src/lpush');
const { createState, onPacket, sweep, mergeConfig, DEFAULTS } = require('../src/visit-engine');
const { distanceMeters } = require('../src/geo');
const { ragicDate, ragicDateTime } = require('../src/ragic');
const { fallbackSummary, summarizeVisit } = require('../src/ai');
const { createIngest } = require('../src/handler');
const { MemoryStore } = require('../src/stores');

let pass = 0;
let fail = 0;
const group = (n) => console.log(`\n── ${n}`);
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra)); }
}

const KEY = 'testkey0123456789';
const T0 = Date.UTC(2026, 8, 18, 0, 0, 0); // 台灣 2026-09-18 08:00
const min = (m) => T0 + m * 60000;
const fmt = (ms) => {
  const d = new Date(ms + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const form = (type, data, key) => {
  const ds = JSON.stringify(data);
  const t = String(Math.floor(Math.random() * 1e9));
  return new URLSearchParams({ LPushType: String(type), time: t, token: md5((key || KEY) + t + ds), data: ds }).toString();
};
const locPkt = (ms, lat, lng, speed, acc, imei) => ({
  gType: 1, imei: imei || '868120214425578', plateNum: 'ABC-1234',
  lat, lng, speed, dir: 90, vol: 12.6, gtm: fmt(ms), ctm: fmt(ms),
  acc, ups: 1, bat: 90, gsm: 25, gNum: 14,
});
const loc = (atMs, lat, lng, speed, acc, gType) => ({
  kind: 'location', imei: 'T', plateNum: 'ABC-1234', at: atMs, receivedAt: atMs,
  lat, lng, speed, acc, fixType: gType === undefined ? 1 : gType,
  trustedFix: (gType === undefined ? 1 : gType) === 1 && lat !== null, dir: 0, ups: 1,
});

// ─────────────────────────────────────────
group('MD5（RFC 1321 測試向量）');
[['', 'd41d8cd98f00b204e9800998ecf8427e'],
 ['abc', '900150983cd24fb0d6963f7d28e17f72'],
 ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
 ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
 ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
].forEach(([input, want]) => check(`md5(${JSON.stringify(input).slice(0, 24)})`, md5Pure(input) === want));
check('中文 UTF-8：純 JS 與 node:crypto 一致', md5Pure('滬Z18399 中文') === md5('滬Z18399 中文'));

// ─────────────────────────────────────────
group('LPush 封包解析與驗簽');
{
  const data = { gType: 2, imei: '868120214425578', lat: 31.29776222222222, lng: 121.12016, speed: 0, dir: 89, vol: 0.0, gtm: '2019-07-05 19:24:58', ctm: '2021-07-05 19:24:58', acc: 0, ups: 0, bat: 0, gsm: 28, gNum: 12, plateNum: '滬Z18399' };
  const ds = JSON.stringify(data);
  const t = '1626765954';
  const tok = md5(KEY + t + ds);

  const p = receive(new URLSearchParams({ LPushType: '2', time: t, token: tok, data: ds }).toString(),
    'application/x-www-form-urlencoded', { tfKey: KEY });
  check('form-urlencoded 驗簽通過', p.signatureVerified);
  check('中文車牌無亂碼', p.plateNum === '滬Z18399');
  check('gtm 依 UTC+8 解析', new Date(p.at).toISOString() === '2019-07-05T11:24:58.000Z');
  check('acc=0 保留為 0 不變 null', p.acc === 0);
  check('基站定位 gType=2 標記為不可信', p.trustedFix === false);

  const j = receive(JSON.stringify({ LPushType: 2, time: Number(t), token: tok, data }), 'application/json', { tfKey: KEY });
  check('application/json 驗簽通過', j.signatureVerified);

  const pretty = `{\n "LPushType" : 2,\n "time" : ${t},\n "token" : "${tok}",\n "data" : ${ds}\n}`;
  check('JSON 有多餘空白時仍驗簽通過（靠原始子字串）', receive(pretty, 'application/json', { tfKey: KEY }).signatureVerified);

  let threw = null;
  try { receive(new URLSearchParams({ LPushType: '2', time: t, token: 'deadbeef', data: ds }).toString(), 'application/x-www-form-urlencoded', { tfKey: KEY }); }
  catch (e) { threw = e.code; }
  check('錯誤 token 被擋下', threw === 'bad_signature');

  const zero = JSON.stringify({ gType: 1, imei: 'x', lat: 0, lng: 0, speed: 0, gtm: fmt(T0), acc: 1 });
  const zp = receive(new URLSearchParams({ LPushType: '2', time: t, token: md5(KEY + t + zero), data: zero }).toString(), 'application/x-www-form-urlencoded', { tfKey: KEY });
  check('lat/lng 皆 0 視為未定位', zp.lat === null && zp.trustedFix === false);
}
{
  const t = '1';
  const mk = (type, d) => receive(new URLSearchParams({ LPushType: String(type), time: t, token: md5(KEY + t + JSON.stringify(d)), data: JSON.stringify(d) }).toString(), 'application/x-www-form-urlencoded', { tfKey: KEY });
  check('心跳包', mk(1, { imei: 'a', plateNum: 'P', vol: 12.6, ctm: fmt(T0), acc: 0, ups: 1, bat: 70, gsm: 28 }).kind === 'heartbeat');
  check('告警包解出 alarmType', mk(4, { imei: 'a', plateNum: 'P', lat: 24.1, lng: 120.6, alarmTime: fmt(T0), alarmType: 'POWER_OFF' }).alarmType === 'POWER_OFF');
  check('工牌包 signType "01" → 上班', mk(5, { imei: 'a', plateNum: '工牌', lat: 24.1, lng: 120.6, signType: '01', signTime: fmt(T0), mil: 0 }).badge.direction === 'in');
  check('里程包解出當日公尺數', mk(6, { imei: 'a', plateNum: 'P', allTotalMil: 356456, allAccWorkTime: 4593, date: '2026-09-17', mil: 34560, accWorkTime: 18000 }).mileage.dayMeters === 34560);
}

// ─────────────────────────────────────────
group('設定合併（曾經的 bug：undefined 蓋掉預設值）');
check('undefined 不覆蓋', mergeConfig({ matchRadiusMeters: undefined }).matchRadiusMeters === DEFAULTS.matchRadiusMeters);
check('NaN 不覆蓋', mergeConfig({ movingSpeedKmh: NaN }).movingSpeedKmh === DEFAULTS.movingSpeedKmh);
check('有值才覆蓋', mergeConfig({ minVisitMinutes: 10 }).minVisitMinutes === 10);

// ─────────────────────────────────────────
group('距離計算');
check('台中到彰化約 9 公里', Math.abs(distanceMeters({ lat: 24.1477, lng: 120.6736 }, { lat: 24.0810, lng: 120.6736 }) - 7415) < 400);
check('同點為 0', distanceMeters({ lat: 24.1, lng: 120.6 }, { lat: 24.1, lng: 120.6 }) === 0);
check('缺座標回 Infinity', distanceMeters({ lat: null, lng: null }, { lat: 24.1, lng: 120.6 }) === Infinity);

// ─────────────────────────────────────────
group('到點 / 離開判斷');
{
  const customers = [{ id: 'C001', name: '台中客戶甲', lat: 24.1477, lng: 120.6736 },
                     { id: 'C002', name: '彰化客戶乙', lat: 24.0810, lng: 120.5410 }];
  let s = createState('T');
  let ev = [];
  for (let m = 0; m < 5; m += 1) ev.push(...onPacket(s, loc(min(m), 24.16 - 0.002 * m, 120.68, 45, 1), customers).events);
  check('行駛中無事件', ev.length === 0);
  ev = [];
  for (let m = 5; m < 50; m += 1) ev.push(...onPacket(s, loc(min(m), 24.1478 + (m % 3) * 0.0001, 120.6737, 0, 0), customers).events);
  const arr = ev.find((e) => e.type === 'arrival');
  check('產生到點', !!arr);
  check('比對到正確客戶', arr && arr.customer.id === 'C001');
  check('停留期間不重複到點', ev.filter((e) => e.type === 'arrival').length === 1);
  ev = onPacket(s, loc(min(51), 24.1520, 120.6800, 30, 1), customers).events;
  const dep = ev.find((e) => e.type === 'departure');
  check('產生離開', !!dep);
  check('時長約 46 分鐘', dep && dep.durationMinutes >= 44 && dep.durationMinutes <= 48);

  s = createState('T'); ev = [];
  for (let m = 0; m <= 3; m += 1) ev.push(...onPacket(s, loc(min(m), 24.1478, 120.6737, 0, 1), customers).events);
  ev.push(...onPacket(s, loc(min(4), 24.16, 120.69, 40, 1), customers).events);
  check('停 4 分鐘未達門檻 → 丟棄', ev.some((e) => e.type === 'visit_discarded') && !ev.some((e) => e.type === 'departure'));

  s = createState('T'); ev = [];
  for (let m = 0; m < 30; m += 1) ev.push(...onPacket(s, loc(min(m), 24.1477, 120.6736, 0, 0, 2), customers).events);
  check('基站定位不觸發到點', ev.length === 0);

  s = createState('T'); ev = [];
  for (let m = 0; m < 12; m += 1) ev.push(...onPacket(s, loc(min(m), 25.0330, 121.5654, 0, 0), customers).events);
  check('未建檔地點仍記錄但客戶為 null', ev[0] && ev[0].type === 'arrival' && ev[0].customer === null);

  s = createState('T'); ev = [];
  ev.push(...onPacket(s, loc(min(0), 24.1478, 120.6737, 0, 0), customers).events);
  ev.push(...onPacket(s, loc(min(1.2), 24.1478, 120.6737, 0, 0), customers).events);
  check('熄火 1 分鐘即到點（送貨快停）', ev.filter((e) => e.type === 'arrival').length === 1);

  s = createState('T'); ev = [];
  ev.push(...onPacket(s, loc(min(0), 24.1478, 120.6737, 0, 1), customers).events);
  ev.push(...onPacket(s, loc(min(1.5), 24.1478, 120.6737, 0, 1), customers).events);
  check('引擎未熄的 90 秒臨停不成案', ev.length === 0);

  s = createState('T');
  for (let m = 0; m < 12; m += 1) onPacket(s, loc(min(m), 24.1477, 120.6736, 0, 0), customers);
  check('離線 8 分鐘不收', sweep([s], min(20)).length === 0);
  check('離線 80 分鐘收掉', sweep([s], min(80)).length === 1 && s.visit === null);

  s = createState('T'); ev = [];
  for (let m = 0; m < 12; m += 1) ev.push(...onPacket(s, loc(min(m), 24.1477, 120.6736, 0, 0), customers).events);
  for (let m = 12; m < 25; m += 1) ev.push(...onPacket(s, loc(min(m), 24.12 - 0.001 * (m - 12), 120.60, 50, 1), customers).events);
  for (let m = 25; m < 45; m += 1) ev.push(...onPacket(s, loc(min(m), 24.0811, 120.5411, 0, 0), customers).events);
  for (let m = 45; m < 48; m += 1) ev.push(...onPacket(s, loc(min(m), 24.0900, 120.5600, 45, 1), customers).events);
  const arrs = ev.filter((e) => e.type === 'arrival');
  check('一趟兩個客戶、順序正確', arrs.length === 2 && arrs[0].customer.id === 'C001' && arrs[1].customer.id === 'C002');
  check('對應兩筆離開', ev.filter((e) => e.type === 'departure').length === 2);
}

// ─────────────────────────────────────────
group('Ragic 格式');
{
  const ms = Date.UTC(2026, 8, 17, 16, 5, 9); // 台灣 2026/09/18 00:05:09
  check('日期為 YYYY/MM/DD 且跨日正確', ragicDate(ms) === '2026/09/18');
  check('日期時間格式', ragicDateTime(ms) === '2026/09/18 00:05:09');
}

// ─────────────────────────────────────────
group('AI 摘要退路');
{
  const v = { plateNum: 'ABC-1234', customerName: '台中客戶甲', customerDistanceMeters: 15,
              arrivedAt: min(70), departedAt: min(145), durationMinutes: 75 };
  const fb = fallbackSummary(v, 8);
  check('規則式句子有內容', fb.summary.includes('台中客戶甲') && fb.summary.includes('1 小時 15 分鐘'));
  check('信心標為 low', fb.confidence === 'low');
}

// ─────────────────────────────────────────
(async () => {
  group('端對端（假 Ragic）');
  const written = { visits: [], punches: [] };
  const fakeRagic = {
    async fetchCustomers() { return [{ id: 'C001', name: '台中客戶甲', lat: 24.1477, lng: 120.6736 }]; },
    async writeVisit(v) { written.visits.push(v); return { status: 'SUCCESS' }; },
    async writeBadgePunch(p) { written.punches.push(p); return { status: 'SUCCESS' }; },
  };
  const logs = [];
  const env = { AZLIOT_TF_KEY: KEY, GPS_AI_DISABLED: '1',
                GPS_DRIVER_MAP: JSON.stringify({ '868120214425578': '王小明' }) };
  const ingest = createIngest(env, { store: new MemoryStore(), ragic: fakeRagic, log: (l, m) => logs.push(`${l}: ${m}`) });
  const post = async (type, data) => {
    const r = await ingest.handle(form(type, data), 'application/x-www-form-urlencoded');
    await r.work;
    return r;
  };

  for (let m = 0; m < 5; m += 1) await post(2, locPkt(min(m), 24.17 - 0.004 * m, 120.69, 45, 1));
  for (let m = 5; m < 40; m += 1) await post(2, locPkt(min(m), 24.1478, 120.6737, 0, 0));
  check('停留期間不寫入（等結案）', written.visits.length === 0);
  await post(2, locPkt(min(41), 24.1600, 120.6900, 40, 1));
  check('離開後寫入一筆', written.visits.length === 1);
  const v = written.visits[0] || {};
  check('客戶、駕駛、時長都對', v.customerName === '台中客戶甲' && v.driver === '王小明' && v.durationMinutes >= 34 && v.durationMinutes <= 38, v);
  check('摘要非空', typeof v.summary === 'string' && v.summary.length > 0);

  const ok = await post(1, { imei: '868120214425578', plateNum: 'ABC-1234', vol: 12.6, ctm: fmt(min(50)), acc: 0, ups: 1, bat: 70, gsm: 28 });
  check('回應符合文件：errorCode 0 / 操作成功', ok.body.errorCode === 0 && ok.body.errorStr === '操作成功' && ok.status === 200);

  const bad = await ingest.handle(new URLSearchParams({ LPushType: '2', time: '1', token: 'bad', data: '{"imei":"x"}' }).toString(), 'application/x-www-form-urlencoded');
  check('驗簽失敗回 errorCode 非 0 但 HTTP 200', bad.body.errorCode !== 0 && bad.status === 200);

  await post(5, { imei: 'BADGE001', plateNum: '王小明工牌', lat: 24.1477, lng: 120.6736, signType: '01', signTime: fmt(min(70)), mil: 0 });
  check('工牌打卡寫入打卡表並帶出地點', written.punches.length === 1 && written.punches[0].direction === 'in' && written.punches[0].nearCustomer.name === '台中客戶甲');

  const vb = written.visits.length;
  await post(4, { imei: '868120214425578', plateNum: 'ABC-1234', lat: 24.1, lng: 120.6, alarmTime: fmt(min(80)), alarmType: 'POWER_OFF' });
  check('告警不寫拜訪表但有記錄', written.visits.length === vb && logs.some((l) => l.includes('POWER_OFF')));

  const flaky = createIngest(env, {
    store: new MemoryStore(),
    ragic: { async fetchCustomers() { throw new Error('Ragic 503'); },
             async writeVisit() { throw new Error('Ragic 503'); },
             async writeBadgePunch() { throw new Error('Ragic 503'); } },
    log: () => {},
  });
  const fr = await flaky.handle(form(2, locPkt(min(90), 24.1478, 120.6737, 0, 0, 'IMEI_F')), 'application/x-www-form-urlencoded');
  await fr.work;
  check('Ragic 掛掉仍回 200，不讓平台無限重送', fr.body.errorCode === 0);

  const sw = createIngest(env, { store: new MemoryStore(), ragic: fakeRagic, log: () => {} });
  for (let m = 0; m < 12; m += 1) {
    const r = await sw.handle(form(2, locPkt(Date.now() - 60 * 60000 + m * 60000, 24.1478, 120.6737, 0, 0, 'IMEI_S')), 'application/x-www-form-urlencoded');
    await r.work;
  }
  const before = written.visits.length;
  const swept = await sw.sweepNow();
  check('sweep 收掉離線卡住的拜訪並寫入', swept.length === 1 && written.visits.length === before + 1 && written.visits[written.visits.length - 1].reason === 'offline_timeout');

  console.log(`\n${fail === 0 ? `全部通過 ${pass} 項` : `通過 ${pass}，失敗 ${fail}`}`);
  process.exit(fail === 0 ? 0 : 1);
})();
