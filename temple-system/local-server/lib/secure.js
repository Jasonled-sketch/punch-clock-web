// 加密、PIN 雜湊、操作紀錄雜湊鏈
'use strict';
const crypto = require('node:crypto');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// ---- PIN ----
function hashPin(pin, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32, SCRYPT);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}
function checkPin(pin, saltB64, hashB64) {
  const h = crypto.scryptSync(String(pin), Buffer.from(saltB64, 'base64'), 32, SCRYPT);
  const want = Buffer.from(hashB64, 'base64');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

// ---- 備份金鑰：由備份密碼經 scrypt 衍生 ----
function deriveBackupKey(password, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  return { salt: salt.toString('base64'), key };
}

// 檔案格式：'TBAK2' | salt(16) | iv(12) | tag(16) | 密文（AES-256-GCM）
const MAGIC = Buffer.from('TBAK2');
function encryptFile(plain, key, saltB64) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, Buffer.from(saltB64, 'base64'), iv, c.getAuthTag(), ct]);
}
function readHeader(buf) {
  if (buf.length < 49 || !buf.subarray(0, 5).equals(MAGIC)) throw new Error('不是本系統的備份檔');
  return { salt: buf.subarray(5, 21).toString('base64') };
}
function decryptFile(buf, password) {
  const { salt } = readHeader(buf);
  const { key } = deriveBackupKey(password, salt);
  const iv = buf.subarray(21, 33), tag = buf.subarray(33, 49);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(buf.subarray(49)), d.final()]); }
  catch (e) { throw new Error('密碼錯誤或備份檔損毀'); }
}

// ---- 操作紀錄雜湊鏈 ----
const GENESIS = '0'.repeat(64);
function chainHash(prev, ts, user, action, detail) {
  return crypto.createHash('sha256').update([prev, ts, user, action, detail].join('␟')).digest('hex');
}

function token() { return crypto.randomBytes(24).toString('base64url'); }

module.exports = { hashPin, checkPin, deriveBackupKey, encryptFile, decryptFile, readHeader, chainHash, GENESIS, token };
