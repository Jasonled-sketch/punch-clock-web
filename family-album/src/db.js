// SQLite（Node 內建，免安裝）。資料庫檔放在 DATA_DIR（Railway 要掛 Volume，否則重新部署會清空）。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';

for (const d of [config.dataDir, config.libraryDir, config.displayDir, config.thumbDir, config.faceDir, config.recapDir, config.musicDir]) {
  fs.mkdirSync(d, { recursive: true });
}

export const db = new DatabaseSync(config.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  sha256 TEXT UNIQUE NOT NULL,
  dhash TEXT,
  kind TEXT NOT NULL DEFAULT 'photo',        -- photo | video
  source TEXT NOT NULL,                      -- line | drive | import
  source_ref TEXT,                           -- LINE 訊息 ID / 雲端硬碟檔案 ID / 檔案路徑
  uploader TEXT, uploader_id TEXT,
  taken_at INTEGER NOT NULL,                 -- 毫秒
  taken_src TEXT,                            -- exif | drive | upload | file
  ym TEXT NOT NULL, ymd TEXT NOT NULL,       -- 依台灣時間算的 2026-11 / 2026-11-21
  width INTEGER, height INTEGER, duration REAL,
  lat REAL, lng REAL,
  orig_path TEXT,                            -- 本機原檔（相對 DATA_DIR）
  drive_file_id TEXT, drive_account_id INTEGER,
  sharpness REAL,
  caption TEXT, event TEXT, scene TEXT, tags TEXT,
  quality INTEGER, highlight INTEGER, is_document INTEGER DEFAULT 0,
  ai_done INTEGER DEFAULT 0,
  face_count INTEGER DEFAULT 0,
  duplicate_of INTEGER,
  hidden INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_ym ON photos(ym, taken_at);
CREATE INDEX IF NOT EXISTS photos_drive ON photos(drive_file_id);
CREATE INDEX IF NOT EXISTS photos_dhash ON photos(dhash);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  x REAL, y REAL, w REAL, h REAL, score REAL,
  descriptor BLOB NOT NULL,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'unknown',    -- unknown | suggest(猜的,待確認) | auto(自動認出) | confirmed(家人標的) | ignored(路人)
  dist REAL
);
CREATE INDEX IF NOT EXISTS faces_photo ON faces(photo_id);
CREATE INDEX IF NOT EXISTS faces_person ON faces(person_id, status);

CREATE TABLE IF NOT EXISTS recaps (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                        -- month | year
  period TEXT NOT NULL,                      -- 2026-10 / 2026
  title TEXT, photo_count INTEGER, duration REAL,
  status TEXT NOT NULL DEFAULT 'making',     -- making | ready | failed
  error TEXT,
  created_at INTEGER NOT NULL, pushed_at INTEGER
);
CREATE INDEX IF NOT EXISTS recaps_period ON recaps(period);

CREATE TABLE IF NOT EXISTS drive_accounts (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL, name TEXT,
  refresh_token TEXT NOT NULL,               -- 已加密
  folders TEXT NOT NULL DEFAULT '[]',        -- [{id,name}]
  last_scan_at INTEGER, last_scan_note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`);

export const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p)
};

export const kv = {
  get(key, fallback = null) {
    const r = q.get('SELECT value FROM kv WHERE key = ?', key);
    if (!r) return fallback;
    try { return JSON.parse(r.value); } catch { return fallback; }
  },
  set(key, value) {
    q.run('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }
};

// 雲端硬碟的 refresh token 加密後才存（金鑰由 ALBUM_TOKEN 衍生；改了 ALBUM_TOKEN 就要重新授權）
const encKey = crypto.createHash('sha256').update('enc:' + config.albumToken).digest();
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
export function decrypt(b64) {
  const raw = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
