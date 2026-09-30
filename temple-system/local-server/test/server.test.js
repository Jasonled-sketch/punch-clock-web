// 執行：node --test test/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server');
const { findTargets, prune, MARKER, DIRNAME } = require('../lib/backup');

function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), name)); }

async function start(opts) {
  const app = createApp(Object.assign({ log: () => {} }, opts));
  const srv = http.createServer(app.handle);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let token = null;
  const call = async (method, p, body, tok = token) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { app, srv, call, setToken: t => { token = t; }, async stop() { srv.close(); await app.shutdown(); } };
}

const SETUP = { templeName: '溪湖福安宮', adminName: '林管理', adminPin: '246810', backupPassword: 'fuan-backup-2026' };

test('完整流程：設定、登入、登記、作廢核准、操作紀錄、關帳備份、換機還原', async () => {
  const dataA = tmp('templeA-'), usbA = tmp('usbA-'), usbB = tmp('usbB-');
  const s = await start({ dataDir: dataA, extraTargets: [usbA, usbB] });

  assert.equal((await s.call('GET', '/api/status')).body.setup, false);
  const evil = await new Promise(r => http.get({ host: '127.0.0.1', port: s.srv.address().port, path: '/api/status', headers: { Host: 'evil.example.com' } }, res => r(res.statusCode)));
  assert.equal(evil, 421, '外部網域不能連');
  const setup = await s.call('POST', '/api/setup', SETUP);
  assert.equal(setup.status, 200);
  const templeId = setup.body.templeId;
  assert.equal((await s.call('POST', '/api/setup', SETUP)).status, 409, '不能重複設定');

  // 隨身碟：只有放了本廟代碼的才算備份碟
  fs.writeFileSync(path.join(usbA, MARKER), templeId + '\n');
  fs.writeFileSync(path.join(usbB, MARKER), 'T-OTHER\n');
  assert.deepEqual(findTargets(templeId, [usbA, usbB]), [usbA]);

  // 未登入不能讀資料
  assert.equal((await s.call('GET', '/api/state')).status, 401);

  // 登入、PIN 錯誤鎖定
  const login = await s.call('POST', '/api/login', { name: '林管理', pin: '246810' });
  assert.equal(login.status, 200);
  s.setToken(login.body.token);
  await s.call('POST', '/api/admin/users', { action: 'add', name: '小美', role: 'counter', pin: '1111' });
  await s.call('POST', '/api/admin/users', { action: 'add', name: '王會計', role: 'accountant', pin: '2222' });
  for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/login', { name: '小美', pin: '0000' }, null)).status, 401);
  assert.equal((await s.call('POST', '/api/login', { name: '小美', pin: '1111' }, null)).status, 423, '錯 5 次要鎖定');

  // 櫃台登記（用管理員代登）
  const rec = [];
  for (const [name, item, amount] of [['王小明', '光明燈', 600], ['李淑芬', '添油香', 1000], ['陳志豪', '太歲燈', 1200]]) {
    const r = await s.call('POST', '/api/records', { record: { name, item, amount, qty: 1, phone: '0912000000' } });
    assert.equal(r.status, 200); rec.push(r.body.record);
  }
  assert.match(rec[0].no, /^\d{7}-0001$/);
  assert.match(rec[2].no, /-0003$/, '收據連號');
  assert.equal((await s.call('POST', '/api/records', { record: { name: '', item: '添油香', amount: 1 } })).status, 400);

  // 手寫收據補登，不能重複
  const man = await s.call('POST', '/api/records', { record: { name: '張雅婷', item: '添油香', amount: 500, manualNo: 'H0001', date: '2026-09-29T10:00:00+08:00' } });
  assert.equal(man.status, 200); assert.equal(man.body.record.manualNo, 'H0001');
  assert.equal((await s.call('POST', '/api/records', { record: { name: '張雅婷', item: '添油香', amount: 500, manualNo: 'H0001' } })).status, 409);

  // 作廢：櫃台 PIN 不能核准，會計可以
  assert.equal((await s.call('POST', '/api/records/void', { id: rec[1].id, reason: '金額打錯', approver: { name: '小美', pin: '1111' } })).status, 423);
  await s.call('POST', '/api/admin/users', { action: 'add', name: '阿華', role: 'counter', pin: '3333' });
  assert.equal((await s.call('POST', '/api/records/void', { id: rec[1].id, reason: '金額打錯', approver: { name: '阿華', pin: '3333' } })).status, 403, '櫃台不能核准作廢');
  const hua = await s.call('POST', '/api/login', { name: '阿華', pin: '3333' }, null);
  assert.equal((await s.call('POST', '/api/close-day', {}, hua.body.token)).status, 403, '櫃台不能關帳');
  assert.equal((await s.call('GET', '/api/audit', null, hua.body.token)).status, 403, '櫃台不能看操作紀錄');
  assert.equal((await s.call('POST', '/api/records/void', { id: rec[1].id, reason: '金額打錯', approver: { name: '王會計', pin: '9999' } })).status, 403, '核准 PIN 錯誤不能變成登出');
  const v = await s.call('POST', '/api/records/void', { id: rec[1].id, reason: '金額打錯', approver: { name: '王會計', pin: '2222' } });
  assert.equal(v.status, 200); assert.equal(v.body.record.void, true);
  assert.equal((await s.call('POST', '/api/records/void', { id: rec[1].id, reason: 'x', approver: { name: '王會計', pin: '2222' } })).status, 409);

  // 設定存檔
  assert.equal((await s.call('PUT', '/api/state', { state: { temple: { name: '溪湖福安宮' }, tier: 'basic', events: [] } })).status, 200);
  const st = await s.call('GET', '/api/state');
  assert.equal(st.body.records.length, 4); assert.equal(st.body.state.tier, 'basic');

  // 關帳：統計排除作廢，並自動備份到隨身碟
  const today = new Date(); const p = n => String(n).padStart(2, '0');
  const close = await s.call('POST', '/api/close-day', { day: `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}` });
  assert.equal(close.status, 200);
  assert.equal(close.body.total, 1800); assert.equal(close.body.count, 2); assert.equal(close.body.voided, 1);
  assert.deepEqual(close.body.backup.targets, [usbA]);
  const onUsb = fs.readdirSync(path.join(usbA, DIRNAME)).filter(f => f.endsWith('.tbak'));
  assert.equal(onUsb.length, 1);
  assert.ok(!fs.existsSync(path.join(usbB, DIRNAME)), '別間廟的碟不寫入');
  const bak = fs.readFileSync(path.join(usbA, DIRNAME, onUsb[0]));
  assert.equal(bak.subarray(0, 5).toString(), 'TBAK2');
  assert.ok(!bak.includes(Buffer.from('王小明')), '備份檔裡不能有明文姓名');
  const status = (await s.call('GET', '/api/status')).body;
  assert.equal(status.backup.ok, true); assert.equal(status.backup.plugged, 1);

  // 操作紀錄：驗證通過；直接改資料庫會被抓到
  const ver = await s.call('GET', '/api/audit/verify');
  assert.equal(ver.body.ok, true); assert.ok(ver.body.checked >= 10);
  s.app.db.prepare("UPDATE audit SET detail=replace(detail,'1000','100') WHERE action='record_void'").run();
  const bad = await s.call('GET', '/api/audit/verify');
  assert.equal(bad.body.ok, false, '竄改要被發現');
  await s.stop();

  // 換機：新主機用備份檔＋密碼還原
  const dataB = tmp('templeB-');
  const s2 = await start({ dataDir: dataB });
  const b64 = bak.toString('base64');
  assert.equal((await s2.call('POST', '/api/setup/restore', { file: b64, password: 'wrong-password' })).status, 400, '密碼錯不能還原');
  const rs = await s2.call('POST', '/api/setup/restore', { file: b64, password: SETUP.backupPassword });
  assert.equal(rs.status, 200); assert.equal(rs.body.records, 4);
  const l2 = await s2.call('POST', '/api/login', { name: '王會計', pin: '2222' });
  assert.equal(l2.status, 200, '人員與 PIN 一起還原');
  s2.setToken(l2.body.token);
  const st2 = await s2.call('GET', '/api/state');
  assert.equal(st2.body.records.find(r => r.void).voidReason, '金額打錯');
  assert.equal(s2.app.config.templeId, templeId, '廟宇代碼沿用，原本的隨身碟可繼續用');
  // 還原後的新主機能繼續用同一把密碼備份
  const again = await s2.call('POST', '/api/backup/run');
  assert.equal(again.status, 200);
  await s2.stop();
});

test('備份保留規則：最新 5 份＋30 天每日＋12 個月每月', () => {
  const dir = tmp('prune-');
  const names = [];
  for (let m = 1; m <= 14; m++) for (const d of [1, 15, 28]) {
    const n = `backup_2025${String(m > 12 ? m - 12 : m).padStart(2, '0')}${String(d).padStart(2, '0')}_${m > 12 ? '1' : '0'}00000.tbak`;
    names.push(n); fs.writeFileSync(path.join(dir, n), 'x');
  }
  for (let h = 0; h < 8; h++) fs.writeFileSync(path.join(dir, `backup_20260930_${String(h).padStart(2, '0')}0000.tbak`), 'x');
  prune(dir);
  const left = fs.readdirSync(dir);
  assert.ok(left.includes('backup_20260930_070000.tbak'));
  assert.ok(left.filter(f => f.startsWith('backup_20260930')).length === 5, '同一天保留最新 5 份');
  assert.ok(left.length <= 5 + 30 + 12);
  assert.ok(!left.includes('backup_20250101_000000.tbak') || left.length > 0);
});
