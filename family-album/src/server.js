import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, signMedia, albumUrl } from './config.js';
import { q, kv } from './db.js';
import { facesReady } from './faces.js';
import { displayPath, thumbPath, facePath, resumeDescribe, describeBacklog } from './ingest.js';
import { searchPhotos, months, stats } from './search.js';
import { peopleList, pendingClusters, nameFaces, ignoreFaces, renamePerson, namesInPhoto } from './people.js';
import { parseQuery, aiEnabled } from './vision.js';
import { makeRecapOnce, recapFile, recapPoster, periodTitle } from './recap.js';
import { verifySignature, handleEvent, pushRecap, familyTarget } from './line.js';
import * as drive from './drive.js';
import { parts, prevMonth } from './time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// ---- LINE webhook：先回 200，再慢慢處理（收圖、認臉都要時間）----
app.post('/line/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  if (!verifySignature(req.body, req.get('x-line-signature'))) return res.status(401).send('bad signature');
  res.sendStatus(200);
  let events = [];
  try { events = JSON.parse(req.body.toString('utf8')).events || []; } catch { return; }
  for (const ev of events) handleEvent(ev).catch(e => console.error('[line] 事件處理失敗：', e.message));
});

app.get('/health', (_req, res) => res.json({ ok: true, photos: q.get('SELECT COUNT(*) AS n FROM photos').n, ai: aiEnabled(), describeBacklog: describeBacklog() }));

// ---- 相簿只給自家人看：網址帶通行碼進來一次，之後靠 cookie ----
const COOKIE = 'album';
const cookieValue = crypto.createHmac('sha256', config.albumToken).update('cookie').digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hasCookie = req => (req.get('cookie') || '').split(/;\s*/).some(c => c === `${COOKIE}=${cookieValue}`);
function requireFamily(req, res, next) {
  if (hasCookie(req)) return next();
  if (req.query.t && safeEq(req.query.t, config.albumToken)) {
    res.setHeader('Set-Cookie', `${COOKIE}=${cookieValue}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${config.baseUrl.startsWith('https') ? '; Secure' : ''}`);
    return next();
  }
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: '請從 LINE 裡小秘書給的連結進來' });
  res.status(401).type('html').send('<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;padding:2rem"><h3>🔒 家庭相簿</h3><p>請在 LINE 對小秘書說「相簿」，用它給的連結進來。</p>');
}

// ---- 圖片/影片檔：自家人（cookie）或帶簽章的連結（給 LINE 抓圖用）----
const mediaFile = {
  thumb: id => thumbPath(Number(id)),
  display: id => displayPath(Number(id)),
  face: id => facePath(Number(id)),
  recap: id => /^\d{4}(-\d{2})?$/.test(id) ? recapFile(id) : null,
  recapposter: id => /^\d{4}(-\d{2})?$/.test(id) ? recapPoster(id) : null,
  orig: id => { const p = q.get('SELECT orig_path FROM photos WHERE id = ?', Number(id)); return p?.orig_path ? path.join(config.dataDir, p.orig_path) : null; }
};
app.get('/m/:kind/:id', (req, res) => {
  const { kind, id } = req.params;
  if (!mediaFile[kind]) return res.sendStatus(404);
  const signed = req.query.s && safeEq(req.query.s, signMedia(kind, id));
  if (!signed && !hasCookie(req)) return res.sendStatus(403);
  const file = mediaFile[kind](id);
  if (!file || !fs.existsSync(file)) return res.sendStatus(404);
  res.setHeader('Cache-Control', kind.startsWith('recap') ? 'private, max-age=300' : 'private, max-age=604800');
  res.sendFile(file);
});

// ---- Google 雲端硬碟授權 ----
app.get('/auth/google', requireFamily, (_req, res) => {
  if (!drive.driveConfigured()) return res.status(400).send('尚未設定 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
  const state = crypto.randomBytes(16).toString('hex');
  kv.set('oauth.state', { state, at: Date.now() });
  res.redirect(drive.authUrl(state));
});
app.get('/auth/google/callback', async (req, res) => {
  const saved = kv.get('oauth.state');
  if (!saved || !req.query.state || !safeEq(req.query.state, saved.state) || Date.now() - saved.at > 600000) return res.status(400).send('授權逾時，請回相簿重新按一次「連結雲端硬碟」');
  kv.set('oauth.state', null);
  try {
    await drive.handleCallback(String(req.query.code || ''));
    res.redirect(`${config.baseUrl}/#settings`); // 同一個瀏覽器已經有 cookie，不用再帶通行碼
  } catch (e) { res.status(400).type('text').send(e.message); }
});

// ---- 相簿 API ----
const api = express.Router();
api.use(express.json({ limit: '200kb' }));
api.use(requireFamily);
const photoOut = p => ({ ...p, tags: p.tags ? JSON.parse(p.tags) : [] });

api.get('/home', (_req, res) => res.json({ months: months(), people: peopleList(), stats: stats(), ai: aiEnabled(), line: Boolean(config.line.token), bound: Boolean(familyTarget()) }));
api.get('/photos', async (req, res) => {
  const f = { ym: req.query.ym || undefined, people: req.query.person ? [String(req.query.person)] : [], limit: Number(req.query.limit) || 120, offset: Number(req.query.offset) || 0 };
  if (req.query.q) {
    const parsed = await parseQuery(String(req.query.q), peopleList().map(p => p.name));
    Object.assign(f, { people: [...f.people, ...parsed.people], from: parsed.from, to: parsed.to, keywords: parsed.keywords });
    f.parsed = parsed;
  }
  const r = searchPhotos(f);
  res.json({ total: r.total, photos: r.rows.map(photoOut), parsed: f.parsed || null });
});
api.get('/photo/:id', (req, res) => {
  const p = q.get('SELECT * FROM photos WHERE id = ?', Number(req.params.id));
  if (!p) return res.sendStatus(404);
  const faces = q.all(`SELECT f.id, f.x, f.y, f.w, f.h, f.status, f.dist, p.name FROM faces f LEFT JOIN people p ON p.id = f.person_id WHERE f.photo_id = ? ORDER BY f.x`, p.id);
  delete p.sha256;
  res.json({ ...photoOut(p), faces, names: namesInPhoto(p.id), hasOriginal: Boolean(p.orig_path), aiPending: aiEnabled() && !p.ai_done });
});
api.post('/photo/:id/hide', (req, res) => { q.run('UPDATE photos SET hidden = ? WHERE id = ?', req.body.hidden === false ? 0 : 1, Number(req.params.id)); res.json({ ok: true }); });
api.get('/who', (_req, res) => res.json({ clusters: pendingClusters(), people: peopleList() }));
api.post('/faces/name', (req, res) => {
  try { res.json(nameFaces((req.body.faceIds || []).map(Number), req.body.name)); } catch (e) { res.status(400).json({ error: e.message }); }
});
api.post('/faces/ignore', (req, res) => { ignoreFaces((req.body.faceIds || []).map(Number)); res.json({ ok: true }); });
api.post('/people/:id/rename', (req, res) => {
  try { res.json({ id: renamePerson(Number(req.params.id), req.body.name) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
api.get('/recaps', (_req, res) => res.json({ recaps: q.all(`SELECT id, kind, period, title, photo_count, duration, status, error, created_at FROM recaps ORDER BY period DESC, id DESC`) }));
api.post('/recaps', (req, res) => {
  const period = String(req.body.period || '');
  if (!/^\d{4}(-\d{2})?$/.test(period)) return res.status(400).json({ error: '期間格式要是 2026-10 或 2026' });
  makeRecapOnce(period).catch(e => console.error('[recap] 製作失敗：', e.message));
  res.json({ ok: true, title: `${periodTitle(period)}回顧` });
});
api.get('/drive', (_req, res) => res.json({ configured: drive.driveConfigured(), scanning: drive.isScanning(), accounts: drive.accounts(), backup: config.drive.backupLineUploads }));
api.post('/drive/:id/folders', async (req, res) => {
  try { res.json(await drive.addFolder(req.params.id, req.body.url)); } catch (e) { res.status(400).json({ error: e.message }); }
});
api.delete('/drive/:id/folders/:folderId', (req, res) => { drive.removeFolder(req.params.id, req.params.folderId); res.json({ ok: true }); });
api.delete('/drive/:id', (req, res) => { drive.removeAccount(req.params.id); res.json({ ok: true }); });
api.post('/drive/scan', (_req, res) => { runDriveScan(); res.json({ ok: true }); });
app.use('/api', api);

app.get('/', requireFamily, (_req, res) => res.sendFile(path.join(here, '../web/index.html')));

// ---- 排程：每分鐘看一次有沒有事要做 ----
async function runDriveScan() {
  try {
    let r;
    do { r = await drive.scanAll(); } while (r.more); // 有積壓就一批一批做完
    kv.set('drive.lastScan', Date.now());
  } catch (e) { console.error('[drive] 掃描失敗：', e.message); }
}
async function tick() {
  const now = parts(Date.now());
  // 雲端硬碟
  if (drive.driveConfigured() && !drive.isScanning() && Date.now() - kv.get('drive.lastScan', 0) > config.drive.scanIntervalMin * 60000) {
    kv.set('drive.lastScan', Date.now());
    runDriveScan();
  }
  // 每月回顧：到了設定的日子、時間，把上個月做成影片推到家庭群組（1 則）
  const m = config.recap.monthlyAt.match(/^(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m && config.line.token && familyTarget()) {
    // 當天時間到就做；那天伺服器剛好沒開的話，之後的白天補做（不會半夜吵人）
    const day = Number(m[1]), minutes = now.h * 60 + now.mi;
    const due = d => (now.d === d && minutes >= Number(m[2]) * 60 + Number(m[3])) || (now.d > d && now.h >= 9 && now.h < 21);
    const jobs = [];
    if (due(day)) jobs.push(prevMonth());
    if (now.m === 1 && due(day + 1)) jobs.push(String(now.y - 1)); // 元月再多做一支年度回顧
    for (const period of jobs) {
      if (kv.get(`recap.auto.${period}`)) continue;
      kv.set(`recap.auto.${period}`, Date.now()); // 先記下來，失敗也不會每分鐘重推
      const col = period.length === 4 ? 'substr(ym, 1, 4)' : 'ym';
      if (q.get(`SELECT COUNT(*) AS n FROM photos WHERE ${col} = ? AND kind = 'photo' AND hidden = 0 AND duplicate_of IS NULL`, period).n < 3) continue;
      pushRecap(period).then(r => console.log(`[recap] 已推送 ${r.title}`)).catch(e => console.error('[recap] 自動回顧失敗：', e.message));
    }
  }
}

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, () => {
    console.log(`[album] started :${config.port}　相簿：${config.albumTokenFromEnv ? config.baseUrl + '/?t=<ALBUM_TOKEN>' : albumUrl()}`);
    if (!config.albumTokenFromEnv) console.log('[album] ⚠ 沒設 ALBUM_TOKEN，通行碼每次重啟都會變，請到 Variables 設定一個固定的');
    if (!config.line.token || !config.line.secret) console.log('[album] ⚠ 沒設 LINE_TOKEN / LINE_SECRET，LINE 功能停用');
    if (!aiEnabled()) console.log('[album] ⚠ 沒設 ANTHROPIC_API_KEY，照片不會有 AI 註記（認臉、歸檔、回顧仍可用）');
    facesReady().then(() => console.log('[album] 人臉模型載入完成')).catch(e => console.error('[album] 人臉模型載入失敗：', e.message));
    const n = resumeDescribe();
    if (n) console.log(`[album] 續做 ${n} 張照片的 AI 註記`);
    setInterval(() => tick().catch(e => console.error('[tick]', e.message)), 60000);
  });
}
export { app, tick };
