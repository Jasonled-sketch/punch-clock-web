// AI 註記流程實測：用「假的 Claude API」確認送出去的請求長對、回來的結果有寫進相簿
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeFixtures } from './fixtures.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'album-ai-'));
const requests = [];
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({ url: req.url, headers: req.headers, body });
  const isPhoto = Array.isArray(body.messages[0].content);
  const out = isPhoto
    ? { caption: '在公園盪鞦韆笑得很開心', event: '出遊', scene: '公園', tags: ['鞦韆', '公園', '笑容'], quality: 4.4, highlight: 9, is_document: false }
    : { intent: 'search', people: ['妹妹', '不存在的人'], from: '2026-10-01', to: '2026-10-31', keywords: ['公園', '鞦韆'], reply: '' };
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 10, output_tokens: 10 } }));
});
await new Promise(r => mock.listen(0, r));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: path.join(tmp, 'data'), ALBUM_TOKEN: 'x', FACES: '0',
  ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}` });
delete process.env.ANTHROPIC_AUTH_TOKEN;

let ingestMod, db, vision, search;
before(async () => {
  ingestMod = await import('../src/ingest.js'); db = await import('../src/db.js');
  vision = await import('../src/vision.js'); search = await import('../src/search.js');
});
after(async () => { mock.close(); db.db.close(); await fs.rm(tmp, { recursive: true, force: true }); });

test('收進來的照片會在背景請 AI 寫註記，寫完就搜得到', async () => {
  const [file] = (await makeFixtures(path.join(tmp, 'fx'))).filter(f => f.endsWith('scene0.jpg'));
  const r = await ingestMod.ingest({ filePath: file, source: 'import' });
  assert.equal(r.status, 'added');
  for (let i = 0; i < 100 && !db.q.get('SELECT ai_done FROM photos WHERE id = ?', r.id).ai_done; i++) await new Promise(s => setTimeout(s, 50));
  const p = db.q.get('SELECT * FROM photos WHERE id = ?', r.id);
  assert.equal(p.caption, '在公園盪鞦韆笑得很開心');
  assert.equal(p.quality, 4);
  assert.equal(p.highlight, 5, '超出範圍的分數會被壓回 1~5');
  assert.deepEqual(JSON.parse(p.tags), ['鞦韆', '公園', '笑容']);
  assert.equal(search.searchPhotos({ keywords: ['鞦韆'] }).total, 1);
  assert.equal(search.searchPhotos({ keywords: ['海邊'] }).total, 0);

  const req = requests[0];
  assert.match(req.url, /\/v1\/messages/);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.output_config.effort, 'low');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  const [image, text] = req.body.messages[0].content;
  assert.equal(image.source.media_type, 'image/jpeg');
  assert.ok(image.source.data.length > 1000);
  assert.match(text.text, /拍攝日期：2026\/10\/4/);
  assert.match(req.body.system, /不要從長相去判斷身分/);
});

test('口語查詢交給 AI 轉成條件，且只接受相簿裡真的有的名字', async () => {
  const f = await vision.parseQuery('上個月妹妹在公園玩的照片', ['妹妹', '哥哥']);
  assert.deepEqual(f.people, ['妹妹']);
  assert.equal(f.from, '2026-10-01');
  assert.deepEqual(f.keywords, ['公園', '鞦韆']);
  assert.match(requests.at(-1).body.system, /妹妹、哥哥/);
});
