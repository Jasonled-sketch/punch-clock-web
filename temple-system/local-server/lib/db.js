// SQLite 資料庫：單一檔案，WAL 日誌模式，斷電不壞檔
'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  no TEXT UNIQUE,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  addr TEXT DEFAULT '',
  item TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  amount INTEGER NOT NULL DEFAULT 0,
  show INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '',
  void INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT,
  void_by TEXT,
  manual_no TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_date ON records(date);
CREATE INDEX IF NOT EXISTS records_phone ON records(phone);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS closings (
  day TEXT PRIMARY KEY,
  total INTEGER NOT NULL,
  count INTEGER NOT NULL,
  voided INTEGER NOT NULL,
  chain_head TEXT NOT NULL,
  closed_by TEXT NOT NULL,
  closed_at TEXT NOT NULL
);
`;

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  return db;
}

function integrityOk(db) {
  const r = db.prepare('PRAGMA integrity_check').get();
  return r && Object.values(r)[0] === 'ok';
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { open, integrityOk, tx };
