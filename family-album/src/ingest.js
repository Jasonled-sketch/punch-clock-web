// 收一張照片/影片的完整流程：去重 → 轉檔縮圖 → 歸月份 → 認臉 → （背景）AI 描述
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { q } from './db.js';
import { sniff, extOf, readExif, toUprightJpeg, derive, hamming, cropFace, probeVideo } from './media.js';
import { detectFaces, toBlob } from './faces.js';
import { matchFaces, namesInPhoto } from './people.js';
import { describePhoto, aiEnabled } from './vision.js';
import { ymOf, ymdOf } from './time.js';

const sub = id => String(Math.floor(id / 1000)).padStart(4, '0');
export const displayPath = id => path.join(config.displayDir, sub(id), `${id}.jpg`);
export const thumbPath = id => path.join(config.thumbDir, sub(id), `${id}.jpg`);
export const facePath = id => path.join(config.faceDir, sub(id), `${id}.jpg`);
async function write(file, buf) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buf);
}

/** 找「同一張照片」：指紋差 4 bit 以內（LINE 壓縮過的版本 vs 雲端硬碟原檔） */
function findNearDuplicate(dhash) {
  const exact = q.get(`SELECT id, source, width FROM photos WHERE dhash = ? AND duplicate_of IS NULL AND kind = 'photo' LIMIT 1`, dhash);
  if (exact) return exact;
  for (const r of q.all(`SELECT id, dhash, source, width FROM photos WHERE duplicate_of IS NULL AND kind = 'photo' AND dhash IS NOT NULL`)) {
    if (hamming(r.dhash, dhash) <= 4) return r;
  }
  return null;
}

/**
 * @param {object} a
 * @param {Buffer} [a.buffer]   照片內容
 * @param {string} [a.filePath] 影片（或大檔）在磁碟上的位置
 * @param {'line'|'drive'|'import'} a.source
 * @param {string} [a.sourceRef]
 * @param {string} [a.uploader] @param {string} [a.uploaderId]
 * @param {number} [a.fallbackTime] 沒有 EXIF 時用的時間（上傳時間/雲端硬碟建立時間）
 * @param {string} [a.fallbackSrc]
 * @param {boolean} [a.keepOriginal] 是否把原檔存一份在本機（LINE 上傳的要，雲端硬碟的不用）
 * @returns {Promise<{status:'added'|'duplicate', id:number, ym:string, names:string[], unknownFaces:number, kind:string}>}
 */
export async function ingest(a) {
  const buffer = a.buffer || await fs.readFile(a.filePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const seen = q.get('SELECT id, ym, kind FROM photos WHERE sha256 = ?', sha256);
  if (seen) return { status: 'duplicate', id: seen.id, ym: seen.ym, names: [], unknownFaces: 0, kind: seen.kind };

  const type = sniff(buffer);
  if (type === 'unknown' || type === 'gif') throw new Error('不支援的檔案格式');
  const kind = type === 'video' ? 'video' : 'photo';

  let upright, exif = {}, duration = null;
  if (kind === 'video') {
    let file = a.filePath, tmp = null;
    if (!file) { tmp = path.join(config.dataDir, `tmp-${sha256.slice(0, 12)}.mp4`); await fs.writeFile(tmp, buffer); file = tmp; }
    try {
      const v = await probeVideo(file);
      upright = v.frame; duration = v.duration; exif.takenAt = v.takenAt;
    } finally { if (tmp) await fs.rm(tmp, { force: true }); }
  } else {
    exif = await readExif(buffer);
    upright = await toUprightJpeg(buffer, type);
  }
  const d = await derive(upright);

  const takenAt = exif.takenAt || a.fallbackTime || Date.now();
  const takenSrc = exif.takenAt ? 'exif' : (a.fallbackSrc || 'upload');
  const dup = kind === 'photo' ? findNearDuplicate(d.dhash) : null;

  const id = Number(q.run(`
    INSERT INTO photos(sha256, dhash, kind, source, source_ref, uploader, uploader_id, taken_at, taken_src, ym, ymd,
      width, height, duration, lat, lng, drive_file_id, drive_account_id, sharpness, duplicate_of, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    sha256, d.dhash, kind, a.source, a.sourceRef || null, a.uploader || null, a.uploaderId || null,
    takenAt, takenSrc, ymOf(takenAt), ymdOf(takenAt), d.width, d.height, duration, exif.lat ?? null, exif.lng ?? null,
    a.driveFileId || null, a.driveAccountId || null, d.sharpness, dup?.id ?? null, Date.now()).lastInsertRowid);

  await write(displayPath(id), d.display);
  await write(thumbPath(id), d.thumb);
  if (a.keepOriginal) {
    const rel = path.join('library', ymOf(takenAt).slice(0, 4), ymOf(takenAt), `${id}-${sha256.slice(0, 8)}.${extOf(type)}`);
    await write(path.join(config.dataDir, rel), buffer);
    q.run('UPDATE photos SET orig_path = ? WHERE id = ?', rel, id);
  }

  // 同一張已經有了：兩邊都留紀錄，但相簿只顯示一張（優先留雲端硬碟原檔、解析度高的）
  if (dup) {
    const newIsBetter = (a.source === 'drive' && dup.source !== 'drive') || d.width > (dup.width || 0) * 1.2;
    if (newIsBetter) {
      q.run('UPDATE photos SET duplicate_of = NULL WHERE id = ?', id);
      q.run('UPDATE photos SET duplicate_of = ? WHERE id = ? OR duplicate_of = ?', id, dup.id, dup.id);
    } else {
      return { status: 'duplicate', id, ym: ymOf(takenAt), names: [], unknownFaces: 0, kind };
    }
  }

  let names = [], unknownFaces = 0;
  if (config.faces.enabled) {
    try {
      const found = await detectFaces(d.display);
      const rows = [];
      for (const f of found) {
        const faceId = Number(q.run('INSERT INTO faces(photo_id, x, y, w, h, score, descriptor) VALUES(?,?,?,?,?,?,?)',
          id, f.box.x, f.box.y, f.box.w, f.box.h, f.score, toBlob(f.descriptor)).lastInsertRowid);
        await write(facePath(faceId), await cropFace(upright, f.box));
        rows.push({ id: faceId, descriptor: f.descriptor });
      }
      for (const [faceId, m] of matchFaces(rows)) {
        q.run('UPDATE faces SET person_id = ?, status = ?, dist = ? WHERE id = ?', m.personId, m.status, m.dist, faceId);
        if (m.status !== 'auto') unknownFaces++;
      }
      q.run('UPDATE photos SET face_count = ? WHERE id = ?', found.length, id);
      names = namesInPhoto(id);
    } catch (e) {
      console.error(`[faces] 照片 ${id} 認臉失敗：`, e.message);
    }
  }

  enqueueDescribe(id);
  return { status: 'added', id, ym: ymOf(takenAt), names, unknownFaces, kind };
}

// ---- AI 描述：背景慢慢做，一次最多 2 張，失敗不影響收圖 ----
const pending = [];
let running = 0;
export function enqueueDescribe(id) {
  if (!aiEnabled()) return;
  pending.push(id);
  pump();
}
function pump() {
  while (running < 2 && pending.length) {
    const id = pending.shift();
    running++;
    describeOne(id).catch(e => console.error(`[ai] 照片 ${id} 描述失敗：`, e.message)).finally(() => { running--; pump(); });
  }
}
async function describeOne(id) {
  const p = q.get('SELECT id, taken_at, ai_done FROM photos WHERE id = ?', id);
  if (!p || p.ai_done) return;
  const jpeg = await fs.readFile(displayPath(id));
  const info = await describePhoto(jpeg, { names: namesInPhoto(id), takenAt: p.taken_at });
  if (!info) { q.run('UPDATE photos SET ai_done = 2 WHERE id = ?', id); return; }
  q.run(`UPDATE photos SET caption = ?, event = ?, scene = ?, tags = ?, quality = ?, highlight = ?, is_document = ?, ai_done = 1 WHERE id = ?`,
    info.caption, info.event, info.scene, JSON.stringify(info.tags), info.quality, info.highlight, info.is_document ? 1 : 0, id);
}
/** 開機時把上次沒描述完的補做 */
export function resumeDescribe() {
  if (!aiEnabled()) return 0;
  const rows = q.all('SELECT id FROM photos WHERE ai_done = 0 ORDER BY id DESC LIMIT 2000');
  rows.forEach(r => pending.push(r.id));
  pump();
  return rows.length;
}
export const describeBacklog = () => pending.length + running;
