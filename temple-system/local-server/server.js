#!/usr/bin/env node
// 宮廟雲 入門版本機伺服器：不需網路、不需安裝套件（Node.js 22 以上）
// 用法：
//   node server.js                         啟動（預設 http://127.0.0.1:8080，只有本機能連）
//   node server.js --data D:\temple-data   指定資料夾
//   node server.js prepare-usb E:\         把隨身碟設定成這間廟的備份碟
//   node server.js restore 備份檔.tbak       用備份檔還原（換機時用）
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open, integrityOk, tx } = require('./lib/db');
const secure = require('./lib/secure');
const { Backup, prepareTarget, restoreToFile } = require('./lib/backup');

const ROLES = { counter: { name: '櫃台', rank: 1 }, accountant: { name: '會計', rank: 2 }, chair: { name: '主委／管理人', rank: 3 }, admin: { name: '系統管理員', rank: 4 } };
const IDLE_MS = 15 * 60 * 1000;
const MAX_FAILS = 5, LOCK_MS = 5 * 60 * 1000;
const BACKUP_EVERY = 50;
const STATIC_ROOT = path.resolve(__dirname, '..');
const STATIC_FILES = new Set(['index.html', 'app.js', 'charter.js', 'poster.js', 'manifest.webmanifest']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json' };

function rocNo(iso, id) {
  const d = new Date(iso), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear() - 1911}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(id).padStart(4, '0')}`;
}
function dayOf(iso) { const d = new Date(iso), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function createApp({ dataDir, extraTargets = [], log = console.log } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const cfgFile = path.join(dataDir, 'config.json');
  const dbFile = path.join(dataDir, 'temple.db');
  let config = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : null;
  if (config) config.extraTargets = [...new Set([...(config.extraTargets || []), ...extraTargets])];
  let db = open(dbFile);
  let integrity = integrityOk(db);
  let backup = config ? new Backup({ db, dataDir, config }) : null;
  const sessions = new Map();
  let sinceBackup = 0, dirty = false;

  const saveConfig = () => { const c = Object.assign({}, config); fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2), { mode: 0o600 }); };
  const kvGet = k => { const r = db.prepare('SELECT value FROM kv WHERE key=?').get(k); return r ? r.value : null; };
  const kvSet = (k, v) => db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

  function audit(user, action, detail) {
    const ts = new Date().toISOString(), d = JSON.stringify(detail || {});
    const last = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get();
    const prev = last ? last.hash : secure.GENESIS;
    const hash = secure.chainHash(prev, ts, user, action, d);
    db.prepare('INSERT INTO audit(ts,user,action,detail,prev,hash) VALUES(?,?,?,?,?,?)').run(ts, user, action, d, prev, hash);
    return hash;
  }
  function verifyAudit() {
    let prev = secure.GENESIS, n = 0;
    for (const r of db.prepare('SELECT * FROM audit ORDER BY id').iterate()) {
      if (r.prev !== prev || secure.chainHash(r.prev, r.ts, r.user, r.action, r.detail) !== r.hash) return { ok: false, brokenAt: r.id, checked: n };
      prev = r.hash; n++;
    }
    return { ok: true, checked: n, head: prev };
  }

  function touchBackup(reason) {
    dirty = true;
    if (++sinceBackup >= BACKUP_EVERY) { sinceBackup = 0; backup.run(reason).then(() => { dirty = false; }); }
  }

  // ---- auth ----
  function auth(req, minRank = 1) {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    const s = sessions.get(t);
    if (!s || Date.now() - s.last > IDLE_MS) { if (s) sessions.delete(t); throw new HttpError(401, '請重新登入'); }
    if (ROLES[s.role].rank < minRank) throw new HttpError(403, '權限不足');
    s.last = Date.now();
    return s;
  }
  function verifyUserPin(name, pin) {
    const u = db.prepare('SELECT * FROM users WHERE name=? AND active=1').get(String(name || ''));
    if (!u) throw new HttpError(401, '帳號或 PIN 錯誤');
    if (u.locked_until > Date.now()) throw new HttpError(423, `錯誤太多次，請 ${Math.ceil((u.locked_until - Date.now()) / 60000)} 分鐘後再試`);
    if (!secure.checkPin(pin, u.pin_salt, u.pin_hash)) {
      const fails = u.fails + 1;
      db.prepare('UPDATE users SET fails=?, locked_until=? WHERE id=?').run(fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? Date.now() + LOCK_MS : 0, u.id);
      audit(u.name, 'login_fail', {});
      throw new HttpError(401, '帳號或 PIN 錯誤');
    }
    db.prepare('UPDATE users SET fails=0, locked_until=0 WHERE id=?').run(u.id);
    return u;
  }
  function validPin(pin) { if (!/^\d{4,8}$/.test(String(pin || ''))) throw new HttpError(400, 'PIN 需為 4～8 位數字'); }
  function addUser(name, role, pin) {
    if (!ROLES[role]) throw new HttpError(400, '角色錯誤');
    if (!String(name || '').trim()) throw new HttpError(400, '請輸入姓名');
    validPin(pin);
    const h = secure.hashPin(pin);
    db.prepare('INSERT INTO users(name,role,pin_salt,pin_hash) VALUES(?,?,?,?)').run(String(name).trim(), role, h.salt, h.hash);
  }

  const pubRecord = r => ({ id: r.id, no: r.no, date: r.date, name: r.name, phone: r.phone, addr: r.addr, item: r.item, qty: r.qty, amount: r.amount, show: !!r.show, note: r.note, void: !!r.void, voidReason: r.void_reason, manualNo: r.manual_no, by: r.created_by });

  // ---- routes ----
  const routes = {
    'GET /api/status': () => ({
      server: true, setup: !!config, templeName: kvGet('templeName'), integrity,
      backup: backup ? Object.assign({}, backup.status, { plugged: backup.targets().length }) : null,
    }),
    'GET /api/users/public': () => db.prepare('SELECT name, role FROM users WHERE active=1 ORDER BY id').all().map(u => ({ name: u.name, role: u.role, roleName: ROLES[u.role].name })),

    'POST /api/setup': (req, b) => {
      if (config) throw new HttpError(409, '已經設定過');
      if (String(b.backupPassword || '').length < 8) throw new HttpError(400, '備份密碼至少 8 碼');
      validPin(b.adminPin);
      const k = secure.deriveBackupKey(b.backupPassword);
      const templeId = 'T' + Date.now().toString(36).toUpperCase();
      config = { templeId, backupSalt: k.salt, backupKey: k.key.toString('base64'), extraTargets, createdAt: new Date().toISOString() };
      tx(db, () => {
        kvSet('templeId', templeId); kvSet('templeName', String(b.templeName || '本宮'));
        addUser(b.adminName || '管理員', 'admin', b.adminPin);
        audit(b.adminName || '管理員', 'setup', { templeName: b.templeName });
      });
      saveConfig();
      backup = new Backup({ db, dataDir, config });
      return { ok: true, templeId };
    },
    'POST /api/setup/restore': async (req, b) => {
      if (config) throw new HttpError(409, '這台主機已有資料，請改用管理員還原');
      const buf = Buffer.from(String(b.file || ''), 'base64');
      db.close();
      let r;
      try { r = restoreToFile(buf, b.password, dbFile); } catch (e) { db = open(dbFile); throw new HttpError(400, e.message); }
      db = open(dbFile); integrity = integrityOk(db);
      const k = secure.deriveBackupKey(b.password, r.salt);
      config = { templeId: r.templeId, backupSalt: k.salt, backupKey: k.key.toString('base64'), extraTargets, createdAt: new Date().toISOString(), restoredAt: new Date().toISOString() };
      saveConfig();
      backup = new Backup({ db, dataDir, config });
      audit('系統', 'restore', { records: r.records, via: 'setup' });
      return { ok: true, records: r.records };
    },

    'POST /api/login': (req, b) => {
      if (!config) throw new HttpError(409, '尚未設定');
      const u = verifyUserPin(b.name, b.pin);
      const t = secure.token();
      sessions.set(t, { user: u.name, role: u.role, last: Date.now() });
      audit(u.name, 'login', {});
      return { token: t, user: u.name, role: u.role, roleName: ROLES[u.role].name, idleMinutes: IDLE_MS / 60000 };
    },
    'POST /api/logout': req => { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); sessions.delete(t); return { ok: true }; },

    'GET /api/state': req => {
      auth(req);
      const state = JSON.parse(kvGet('state') || 'null');
      const records = db.prepare('SELECT * FROM records ORDER BY id').all().map(pubRecord);
      return { state, records };
    },
    'PUT /api/state': (req, b) => {
      const s = auth(req);
      const next = b.state || {};
      delete next.records;
      const prev = JSON.parse(kvGet('state') || '{}');
      const changed = Object.keys(Object.assign({}, prev, next)).filter(k => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
      if (!changed.length) return { ok: true, changed };
      tx(db, () => {
        kvSet('state', JSON.stringify(next));
        if (next.temple && next.temple.name) kvSet('templeName', next.temple.name);
        audit(s.user, 'update_state', { keys: changed });
      });
      touchBackup('settings');
      return { ok: true, changed };
    },

    'POST /api/records': (req, b) => {
      const s = auth(req);
      const r = b.record || {};
      if (!String(r.name || '').trim() || !r.item) throw new HttpError(400, '請填姓名與項目');
      const amount = Math.round(Number(r.amount)), qty = Math.max(1, Math.round(Number(r.qty) || 1));
      if (!Number.isFinite(amount) || amount < 0) throw new HttpError(400, '金額錯誤');
      const manual = r.manualNo ? String(r.manualNo).trim() : null;
      if (manual && db.prepare('SELECT 1 FROM records WHERE manual_no=?').get(manual)) throw new HttpError(409, `手寫收據 ${manual} 已補登過`);
      const date = manual && r.date ? new Date(r.date).toISOString() : new Date().toISOString();
      const rec = tx(db, () => {
        const info = db.prepare(`INSERT INTO records(date,name,phone,addr,item,qty,amount,show,note,manual_no,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(date, String(r.name).trim(), r.phone || '', r.addr || '', String(r.item), qty, amount, r.show === false ? 0 : 1, r.note || '', manual, s.user, new Date().toISOString());
        const id = Number(info.lastInsertRowid);
        db.prepare('UPDATE records SET no=? WHERE id=?').run(rocNo(date, id), id);
        const row = db.prepare('SELECT * FROM records WHERE id=?').get(id);
        audit(s.user, manual ? 'record_manual' : 'record_create', { no: row.no, manualNo: manual, name: row.name, item: row.item, amount: row.amount });
        return row;
      });
      touchBackup('records');
      return { record: pubRecord(rec) };
    },
    'POST /api/records/void': (req, b) => {
      const s = auth(req);
      let approver;
      try { approver = verifyUserPin(b.approver && b.approver.name, b.approver && b.approver.pin); }
      catch (e) { throw new HttpError(e.code === 423 ? 423 : 403, e.code === 423 ? e.message : '核准人 PIN 錯誤'); }
      if (ROLES[approver.role].rank < 2) throw new HttpError(403, '作廢需要會計、主委或管理員核准');
      if (!String(b.reason || '').trim()) throw new HttpError(400, '請填作廢原因');
      const row = db.prepare('SELECT * FROM records WHERE id=?').get(Number(b.id));
      if (!row) throw new HttpError(404, '找不到收據');
      if (row.void) throw new HttpError(409, '已經作廢');
      tx(db, () => {
        db.prepare('UPDATE records SET void=1, void_reason=?, void_by=? WHERE id=?').run(String(b.reason), approver.name, row.id);
        audit(s.user, 'record_void', { no: row.no, amount: row.amount, reason: b.reason, approvedBy: approver.name });
      });
      touchBackup('void');
      return { record: pubRecord(db.prepare('SELECT * FROM records WHERE id=?').get(row.id)) };
    },

    'POST /api/close-day': async (req, b) => {
      const s = auth(req, 2);
      const day = b.day || dayOf(new Date().toISOString());
      const rows = db.prepare('SELECT * FROM records').all().filter(r => dayOf(r.date) === day);
      const live = rows.filter(r => !r.void);
      const total = live.reduce((a, r) => a + r.amount, 0);
      const head = audit(s.user, 'close_day', { day, total, count: live.length, voided: rows.length - live.length });
      db.prepare(`INSERT INTO closings(day,total,count,voided,chain_head,closed_by,closed_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(day) DO UPDATE SET total=excluded.total,count=excluded.count,voided=excluded.voided,chain_head=excluded.chain_head,closed_by=excluded.closed_by,closed_at=excluded.closed_at`)
        .run(day, total, live.length, rows.length - live.length, head, s.user, new Date().toISOString());
      const byItem = {};
      live.forEach(r => { byItem[r.item] = (byItem[r.item] || 0) + r.amount; });
      const bk = await backup.run('close_day'); sinceBackup = 0; dirty = false;
      return { day, total, count: live.length, voided: rows.length - live.length, byItem, chainHead: head.slice(0, 16), backup: bk };
    },
    'POST /api/backup/run': async req => { auth(req); const r = await backup.run('manual'); sinceBackup = 0; dirty = false; return r; },
    'POST /api/backup/prepare-usb': (req, b) => {
      const s = auth(req, 3);
      const root = path.resolve(String(b.path || ''));
      prepareTarget(root, config.templeId);
      if (!backup.targets().includes(root)) { config.extraTargets = [...new Set([...(config.extraTargets || []), root])]; saveConfig(); }
      audit(s.user, 'prepare_usb', { path: root });
      return { ok: true, targets: backup.targets() };
    },

    'GET /api/audit': req => { auth(req, 2); return db.prepare('SELECT id,ts,user,action,detail FROM audit ORDER BY id DESC LIMIT 300').all().map(r => Object.assign(r, { detail: JSON.parse(r.detail) })); },
    'GET /api/audit/verify': req => { auth(req, 2); return verifyAudit(); },

    'GET /api/admin/users': req => { auth(req, 4); return db.prepare('SELECT id,name,role,active FROM users ORDER BY id').all(); },
    'POST /api/admin/users': (req, b) => {
      const s = auth(req, 4);
      if (b.action === 'add') addUser(b.name, b.role, b.pin);
      else if (b.action === 'pin') { validPin(b.pin); const h = secure.hashPin(b.pin); db.prepare('UPDATE users SET pin_salt=?, pin_hash=?, fails=0, locked_until=0 WHERE id=?').run(h.salt, h.hash, Number(b.id)); }
      else if (b.action === 'active') db.prepare('UPDATE users SET active=? WHERE id=?').run(b.active ? 1 : 0, Number(b.id));
      else throw new HttpError(400, '未知動作');
      audit(s.user, 'user_' + b.action, { name: b.name, id: b.id, role: b.role });
      return { ok: true };
    },
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      // 只接受本機網址，擋掉 DNS rebinding（惡意網站把自己的網域指到 127.0.0.1）
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new HttpError(421, '只允許本機連線');
      if (!url.pathname.startsWith('/api/')) {
        const f = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!STATIC_FILES.has(f)) return send(404, '找不到', 'text/plain; charset=utf-8');
        return send(200, fs.readFileSync(path.join(STATIC_ROOT, f)), MIME[path.extname(f)]);
      }
      const fn = routes[`${req.method} ${url.pathname}`];
      if (!fn) throw new HttpError(404, '找不到');
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') {
        const limit = url.pathname === '/api/setup/restore' ? 200 * 1024 * 1024 : 5 * 1024 * 1024;
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, '資料太大'); chunks.push(c); }
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      }
      send(200, await fn(req, body));
    } catch (e) {
      if (!(e instanceof HttpError)) log('錯誤', e);
      send(e.code || 500, { error: e instanceof HttpError ? e.message : '系統錯誤，請聯絡維修' });
    }
  }

  const hourly = setInterval(() => { if (dirty && backup) backup.run('hourly').then(() => { dirty = false; sinceBackup = 0; }); }, 60 * 60 * 1000);
  hourly.unref();

  return {
    handle, audit, verifyAudit,
    get db() { return db; }, get backup() { return backup; }, get config() { return config; },
    async shutdown() { clearInterval(hourly); if (backup && dirty) await backup.run('shutdown'); db.close(); },
  };
}

function arg(name, def) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; }

if (require.main === module) {
  const dataDir = path.resolve(arg('--data', path.join(__dirname, 'data')));
  const port = Number(arg('--port', 8080));
  const cmd = process.argv[2];
  if (cmd === 'prepare-usb') {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const root = path.resolve(process.argv[3]);
    prepareTarget(root, cfg.templeId);
    if (process.platform !== 'win32' || !/^[A-Z]:\\?$/i.test(process.argv[3])) { cfg.extraTargets = [...new Set([...(cfg.extraTargets || []), root])]; fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 }); }
    console.log(`已設定備份碟：${process.argv[3]}（廟宇代碼 ${cfg.templeId}）`);
  } else if (cmd === 'restore') {
    const file = process.argv[3];
    process.stdout.write('請輸入備份密碼：');
    process.stdin.once('data', d => {
      const pw = d.toString().trim();
      fs.mkdirSync(dataDir, { recursive: true });
      try {
        const r = restoreToFile(fs.readFileSync(file), pw, path.join(dataDir, 'temple.db'));
        const k = secure.deriveBackupKey(pw, r.salt);
        fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ templeId: r.templeId, backupSalt: k.salt, backupKey: k.key.toString('base64'), extraTargets: [], restoredAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
        console.log(`還原完成：${r.records} 筆收據。請重新啟動系統。`);
        process.exit(0);
      } catch (e) { console.error('還原失敗：' + e.message); process.exit(1); }
    });
  } else {
    const app = createApp({ dataDir });
    const srv = http.createServer(app.handle);
    srv.listen(port, '127.0.0.1', () => console.log(`宮廟雲 入門版已啟動：http://127.0.0.1:${port}　資料夾：${dataDir}${app.config ? '' : '（尚未設定）'}`));
    const stop = async () => { console.log('關閉中，備份最新資料…'); srv.close(); await app.shutdown(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }
}

module.exports = { createApp, ROLES };
