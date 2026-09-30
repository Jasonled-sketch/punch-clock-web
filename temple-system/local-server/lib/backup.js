// 自動加密備份：本機快照＋所有插著的備份隨身碟（＋有網路時雲端）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const secure = require('./secure');
const { open, integrityOk } = require('./db');

const MARKER = 'TEMPLE-BACKUP.txt';           // 隨身碟根目錄放這個檔，內容第一行＝廟宇代碼
const DIRNAME = 'TempleBackup';
const FILE_RE = /^backup_(\d{8})_(\d{6})\.tbak$/;

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function candidateRoots() {
  if (process.platform === 'win32') {
    const sys = (process.env.SystemDrive || 'C:').toUpperCase();
    return 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => l + ':\\').filter(r => !r.startsWith(sys));
  }
  const roots = [];
  for (const base of ['/media', '/mnt', '/Volumes', '/run/media']) {
    let a = []; try { a = fs.readdirSync(base); } catch (e) { continue; }
    for (const x of a) {
      const p1 = path.join(base, x); roots.push(p1);
      try { for (const y of fs.readdirSync(p1)) roots.push(path.join(p1, y)); } catch (e) {}
    }
  }
  return roots;
}

// 找出屬於這間廟的備份隨身碟
function findTargets(templeId, extra = []) {
  const out = [];
  for (const root of [...candidateRoots(), ...extra]) {
    try {
      const id = fs.readFileSync(path.join(root, MARKER), 'utf8').split(/\r?\n/)[0].trim();
      if (id === templeId) out.push(root);
    } catch (e) {}
  }
  return [...new Set(out)];
}

function prepareTarget(root, templeId) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, MARKER), `${templeId}\n宮廟雲備份碟，請勿刪除此檔。\n`);
}

// 保留：最新 5 份、最近 30 天每天最後一份、最近 12 個月每月最後一份
function prune(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => FILE_RE.test(f)).sort().reverse(); } catch (e) { return 0; }
  const keep = new Set(files.slice(0, 5));
  const days = new Set(), months = new Set();
  for (const f of files) {
    const d = f.match(FILE_RE)[1];
    if (days.size < 30 && !days.has(d)) { days.add(d); keep.add(f); }
    const m = d.slice(0, 6);
    if (months.size < 12 && !months.has(m)) { months.add(m); keep.add(f); }
  }
  let n = 0;
  for (const f of files) if (!keep.has(f)) { try { fs.unlinkSync(path.join(dir, f)); n++; } catch (e) {} }
  return n;
}

function writeDurable(file, buf) {
  const tmp = file + '.part';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

class Backup {
  constructor({ db, dataDir, config }) {
    this.db = db; this.dataDir = dataDir; this.config = config;
    this.status = { last: null, ok: null, error: null, targets: [], cloud: null, reason: null };
    this.running = null;
  }

  targets() { return findTargets(this.config.templeId, this.config.extraTargets || []); }

  async run(reason = 'manual') {
    if (this.running) return this.running;
    this.running = this._run(reason).finally(() => { this.running = null; });
    return this.running;
  }

  async _run(reason) {
    const key = Buffer.from(this.config.backupKey, 'base64');
    const name = `backup_${stamp()}.tbak`;
    const tmpDb = path.join(os.tmpdir(), `temple-${process.pid}-${Date.now()}.db`);
    const result = { time: new Date().toISOString(), reason, file: name, targets: [], errors: [] };
    try {
      this.db.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
      const enc = secure.encryptFile(fs.readFileSync(tmpDb), key, this.config.backupSalt);
      const snapDir = path.join(this.dataDir, 'snapshots');
      fs.mkdirSync(snapDir, { recursive: true });
      writeDurable(path.join(snapDir, name), enc);
      prune(snapDir);
      for (const root of this.targets()) {
        try {
          const dir = path.join(root, DIRNAME);
          fs.mkdirSync(dir, { recursive: true });
          writeDurable(path.join(dir, name), enc);
          prune(dir);
          result.targets.push(root);
        } catch (e) { result.errors.push(`${root}：${e.message}`); }
      }
      if (this.config.cloud && this.config.cloud.url) {
        try {
          const r = await fetch(this.config.cloud.url + '/' + encodeURIComponent(this.config.templeId) + '/' + name, {
            method: 'PUT', body: enc, headers: { Authorization: 'Bearer ' + this.config.cloud.token, 'Content-Type': 'application/octet-stream' },
            signal: AbortSignal.timeout(30000) });
          this.status.cloud = r.ok ? 'ok' : `失敗 ${r.status}`;
        } catch (e) { this.status.cloud = '沒有網路，下次再傳'; }
      }
      Object.assign(this.status, { last: result.time, ok: result.targets.length > 0, error: result.targets.length ? (result.errors[0] || null) : '沒有插備份隨身碟，只存在本機', targets: result.targets, reason });
    } catch (e) {
      Object.assign(this.status, { ok: false, error: e.message, reason });
      result.errors.push(e.message);
    } finally { try { fs.unlinkSync(tmpDb); } catch (e) {} }
    return result;
  }
}

// 從備份檔還原成資料庫檔（先驗證完整性，再換上）
function restoreToFile(buf, password, dbPath) {
  const plain = secure.decryptFile(buf, password);
  const tmp = dbPath + '.restoring';
  fs.writeFileSync(tmp, plain);
  const test = open(tmp);
  const ok = integrityOk(test);
  const n = test.prepare('SELECT COUNT(*) c FROM records').get().c;
  const kv = test.prepare("SELECT value FROM kv WHERE key='templeId'").get();
  test.close();
  for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(tmp + s); } catch (e) {} }
  if (!ok) { fs.unlinkSync(tmp); throw new Error('備份檔內容損毀'); }
  if (fs.existsSync(dbPath)) fs.renameSync(dbPath, dbPath + '.before-restore-' + stamp());
  for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch (e) {} }
  fs.renameSync(tmp, dbPath);
  return { records: n, templeId: kv ? kv.value : null, salt: secure.readHeader(buf).salt };
}

module.exports = { Backup, findTargets, prepareTarget, prune, restoreToFile, MARKER, DIRNAME };
