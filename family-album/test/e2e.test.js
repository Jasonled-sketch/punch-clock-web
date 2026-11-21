// 整套流程實測：用「假的 LINE 伺服器」和「假的 Google 雲端硬碟」對著真正的程式跑一遍
// （真的收圖、真的認臉、真的用 ffmpeg 做影片；只有 LINE / Google / AI 是假的）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeFixtures } from './fixtures.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'album-test-'));
const freePort = () => new Promise(r => { const s = http.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const [mockPort, appPort] = [await freePort(), await freePort()];
const SECRET = 'test-secret', TOKEN = 'family-pass';
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: path.join(tmp, 'data'), PORT: String(appPort), BASE_URL: `http://127.0.0.1:${appPort}`,
  ALBUM_TOKEN: TOKEN, LINE_TOKEN: 'line-token', LINE_SECRET: SECRET,
  LINE_API_BASE: `http://127.0.0.1:${mockPort}`, LINE_DATA_BASE: `http://127.0.0.1:${mockPort}`,
  ACK_QUIET_MS: '700', AI_VISION: '0',
  GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', GOOGLE_API_BASE: `http://127.0.0.1:${mockPort}`, GOOGLE_TOKEN_URL: `http://127.0.0.1:${mockPort}/token`
});

const files = await makeFixtures(path.join(tmp, 'fx'));
const fx = name => files.find(f => f.endsWith(name));
const content = new Map();     // LINE 訊息 ID → 檔案
const replies = [], pushes = [];
const driveTree = {            // 假的雲端硬碟：資料夾 → 內容
  'folderMomAAAAAAAA': [
    { id: 'fileSceneAAAAAAA', name: 'IMG_0001.jpg', mimeType: 'image/jpeg', size: '1000', createdTime: '2026-09-10T02:00:00Z', file: 'scene0.jpg' },
    { id: 'fileSameAsLineAA', name: 'IMG_0002.jpg', mimeType: 'image/jpeg', size: '1000', createdTime: '2026-10-07T02:00:00Z', file: 'p1-0.jpg' }, // 跟 LINE 傳過的是同一個檔
    { id: 'folderSubAAAAAAA', name: '出遊', mimeType: 'application/vnd.google-apps.folder' }
  ],
  'folderSubAAAAAAA': [
    { id: 'fileScene2AAAAAA', name: 'IMG_0003.jpg', mimeType: 'image/jpeg', size: '1000', createdTime: '2026-10-20T02:00:00Z', file: 'scene1.jpg' }
  ]
};
const driveFiles = Object.values(driveTree).flat();

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  const json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  let m;
  if (url.pathname === '/v2/bot/message/reply') { replies.push(JSON.parse(body)); return json({}); }
  if (url.pathname === '/v2/bot/message/push') { pushes.push(JSON.parse(body)); return json({}); }
  if ((m = url.pathname.match(/^\/v2\/bot\/message\/(\w+)\/content$/))) return res.end(await fs.readFile(content.get(m[1])));
  if (url.pathname.startsWith('/v2/bot/group/')) return json({ displayName: '媽媽' });
  if (url.pathname === '/token') return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  if (url.pathname === '/drive/v3/about') return json({ user: { displayName: '媽媽', emailAddress: 'mom@example.com' } });
  if (url.pathname === '/drive/v3/files') {
    const parent = url.searchParams.get('q').match(/'([\w-]+)' in parents/)[1];
    return json({ files: (driveTree[parent] || []).map(({ file, ...f }) => f) });
  }
  if ((m = url.pathname.match(/^\/drive\/v3\/files\/([\w-]+)$/))) {
    if (url.searchParams.get('alt') === 'media') return res.end(await fs.readFile(fx(driveFiles.find(f => f.id === m[1]).file)));
    return json({ id: m[1], name: '媽媽的照片', mimeType: 'application/vnd.google-apps.folder' });
  }
  res.statusCode = 404; res.end();
});

let server, base, lineMod, driveMod, db;
before(async () => {
  await new Promise(r => mock.listen(mockPort, r));
  const { app } = await import('../src/server.js');
  lineMod = await import('../src/line.js'); driveMod = await import('../src/drive.js'); db = await import('../src/db.js');
  server = await new Promise(r => { const s = app.listen(appPort, () => r(s)); });
  base = `http://127.0.0.1:${appPort}`;
});
after(async () => { server.close(); mock.close(); db.db.close(); await fs.rm(tmp, { recursive: true, force: true }); });

let seq = 0;
const GROUP = { type: 'group', groupId: 'Cfamilygroup', userId: 'Umom' };
function imageEvent(file, source = GROUP) {
  const id = String(1000 + ++seq); content.set(id, fx(file));
  return { type: 'message', replyToken: 'rt' + id, timestamp: Date.now(), source, message: { type: 'image', id, contentProvider: { type: 'line' } } };
}
const textEvent = (text, source = GROUP) => ({ type: 'message', replyToken: 'rt' + (++seq), timestamp: Date.now(), source, message: { type: 'text', id: 't' + seq, text } });
async function webhook(events, sign = true) {
  const raw = JSON.stringify({ destination: 'bot', events });
  const sig = sign ? crypto.createHmac('sha256', SECRET).update(raw).digest('base64') : 'bad';
  return fetch(base + '/line/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body: raw });
}
async function until(fn, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 150)); }
  throw new Error('等太久了');
}
const lastReplyText = () => replies.at(-1).messages.map(m => m.text || m.altText || m.type).join('\n');
const count = sql => db.q.get(sql).n;
let cookie;
const family = (p, opts = {}) => fetch(base + p, { ...opts, headers: { ...(opts.headers || {}), cookie } });

test('簽章不對的 webhook 會被擋掉', async () => {
  assert.equal((await webhook([textEvent('相簿')], false)).status, 401);
});

test('沒綁定的群組：不收照片、不透露相簿，只提示要綁定', async () => {
  const stranger = { type: 'group', groupId: 'Cstranger', userId: 'Ux' };
  await webhook([imageEvent('scene3.jpg', stranger), textEvent('相簿', stranger)]);
  await until(() => replies.length === 1);
  assert.match(lastReplyText(), /還沒綁定/);
  assert.doesNotMatch(lastReplyText(), new RegExp(TOKEN));
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(count('SELECT COUNT(*) AS n FROM photos'), 0);
});

test('通行碼錯誤不能綁定；正確才綁定', async () => {
  await webhook([textEvent('綁定 wrong')]);
  await until(() => replies.length === 2);
  assert.match(lastReplyText(), /不對/);
  await webhook([textEvent(`綁定 ${TOKEN}`)]);
  await until(() => replies.length === 3);
  assert.match(lastReplyText(), /綁定完成/);
});

let firstPhotoMsgId;
test('一次傳 4 張 → 全部歸檔，只回「一則」摘要，而且是免費的 reply', async () => {
  const events = ['p1-0.jpg', 'p2-0.jpg', 'p3-0.jpg', 'p4-0.jpg'].map(f => imageEvent(f));
  firstPhotoMsgId = events[0].message.id; // p1-0.jpg
  assert.equal((await webhook(events)).status, 200);
  await until(() => replies.length === 4);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(replies.length, 4, '一批只回一則');
  assert.equal(replies.at(-1).replyToken, events.at(-1).replyToken, '用最新的 replyToken');
  assert.match(lastReplyText(), /收到 4 張/);
  assert.match(lastReplyText(), /2026 年 10 月/);
  assert.match(lastReplyText(), /還不認識/);
  assert.equal(pushes.length, 0, '沒有用到要計費的 push');
  assert.equal(count('SELECT COUNT(*) AS n FROM photos'), 4);
  assert.equal(count(`SELECT COUNT(*) AS n FROM photos WHERE uploader = '媽媽' AND orig_path IS NOT NULL`), 4);
  assert.ok(count('SELECT COUNT(*) AS n FROM faces') >= 10);
});

test('同一張再傳一次 → 不重複存', async () => {
  await webhook([imageEvent('p2-0.jpg')]);
  await until(() => replies.length === 5);
  assert.match(lastReplyText(), /之前傳過/);
  assert.equal(count('SELECT COUNT(*) AS n FROM photos'), 4);
});

test('相簿網頁：沒有通行碼進不去；帶通行碼換到 cookie', async () => {
  assert.equal((await fetch(base + '/')).status, 401);
  const denied = await fetch(base + '/api/home');
  assert.equal(denied.status, 401);
  assert.match((await denied.json()).error, /LINE/);
  assert.equal((await fetch(base + '/m/display/1')).status, 403);
  const res = await fetch(base + `/?t=${TOKEN}`);
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
  const home = await (await family('/api/home')).json();
  assert.equal(home.stats.total, 4);
  assert.equal(home.months[0].ym, '2026-10');
});

test('認人：標一次名字，之後同一個人的新照片自動歸類', async () => {
  const who = await (await family('/api/who')).json();
  assert.ok(who.clusters.length > 0);
  const first = db.q.get('SELECT id FROM photos WHERE source_ref = ?', firstPhotoMsgId);
  const faces = db.q.all('SELECT id FROM faces WHERE photo_id = ? ORDER BY x', first.id);
  for (const [i, name] of ['哥哥', '妹妹', '媽媽'].entries()) {
    const r = await family('/api/faces/name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ faceIds: [faces[i].id], name }) });
    assert.equal(r.status, 200);
  }
  await webhook([imageEvent('p1-2.jpg')]); // 同一批人、不同構圖的另一張
  await until(() => replies.length === 6);
  assert.match(lastReplyText(), /哥哥×1/);
  assert.match(lastReplyText(), /妹妹×1/);
  assert.match(lastReplyText(), /媽媽×1/);
  const people = (await (await family('/api/who')).json()).people;
  assert.deepEqual(people.map(p => p.name).sort(), ['哥哥', '妹妹', '媽媽'].sort());
  assert.ok(people.every(p => p.photos >= 2));
});

test('群組裡一般聊天不插嘴；指令才回', async () => {
  await webhook([textEvent('今天晚餐吃什麼')]);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(replies.length, 6);
  await webhook([textEvent('統計')]);
  await until(() => replies.length === 7);
  assert.match(lastReplyText(), /全部：5 個檔案/);
  assert.match(lastReplyText(), /哥哥 2/);
});

test('找照片 → 回照片卡片；卡片的圖片網址 LINE 抓得到，但沒簽章的抓不到', async () => {
  await webhook([textEvent('找 哥哥')]);
  await until(() => replies.length === 8);
  const [msg, flex] = replies.at(-1).messages;
  assert.match(msg.text, /找到 2 張/);
  assert.equal(flex.type, 'flex');
  const imgUrl = flex.contents.contents[0].hero.url;
  const img = await fetch(imgUrl);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(imgUrl.replace(/s=\w+/, 's=000000000000000000000000'))).status, 403);
  await webhook([textEvent('找 阿公')]);
  await until(() => replies.length === 9);
  assert.match(lastReplyText(), /找不到/);
});

test('雲端硬碟：掃資料夾（含子資料夾），跟 LINE 傳過的同一張不會重複', async () => {
  const acc = await driveMod.handleCallback('auth-code');
  assert.equal(acc.email, 'mom@example.com');
  assert.notEqual(db.q.get('SELECT refresh_token FROM drive_accounts').refresh_token, 'rt', 'refresh token 要加密存');
  const folder = await driveMod.addFolder(acc.id, 'https://drive.google.com/drive/folders/folderMomAAAAAAAA?usp=sharing');
  assert.equal(folder.name, '媽媽的照片');
  const r = await driveMod.scanAll();
  assert.deepEqual({ added: r.added, duplicate: r.duplicate, failed: r.failed }, { added: 2, duplicate: 1, failed: 0 });
  assert.equal(count(`SELECT COUNT(*) AS n FROM photos WHERE source = 'drive'`), 2);
  assert.equal(count(`SELECT COUNT(*) AS n FROM photos WHERE ym = '2026-10' AND source = 'drive'`), 2, '依 EXIF 拍攝時間歸月份');
  const again = await driveMod.scanAll();
  assert.deepEqual({ added: again.added, duplicate: again.duplicate }, { added: 0, duplicate: 0 }, '第二次掃描不會重抓');
  const d = await (await family('/api/drive')).json();
  assert.equal(d.accounts[0].folders[0].name, '媽媽的照片');
});

test('回顧影片：第一次要製作（做好推 1 則到群組）；之後再問直接回，不再花額度', async () => {
  await webhook([textEvent('回顧 2026-10')]);
  await until(() => replies.length === 10);
  assert.match(lastReplyText(), /開始製作2026 年 10 月回顧/);
  await until(() => pushes.length === 1, 120000);
  assert.equal(pushes[0].to, 'Cfamilygroup');
  const video = pushes[0].messages.find(m => m.type === 'video');
  const res = await fetch(video.originalContentUrl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.ok((await res.arrayBuffer()).byteLength > 100000);
  assert.equal((await fetch(video.previewImageUrl)).status, 200);

  await webhook([textEvent('回顧 2026-10')]);
  await until(() => replies.length === 11);
  assert.equal(replies.at(-1).messages[1].type, 'video');
  assert.equal(pushes.length, 1, '第二次沒有再 push');
  const list = await (await family('/api/recaps')).json();
  assert.equal(list.recaps[0].status, 'ready');
});

test('照片太少的月份做不成回顧，會好好說明', async () => {
  await webhook([textEvent('回顧 2020-01')]);
  await until(() => pushes.length === 2, 30000);
  assert.match(pushes[1].messages[0].text, /太少/);
});
