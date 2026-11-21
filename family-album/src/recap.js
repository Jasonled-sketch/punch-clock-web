// 月度 / 年度回顧影片：挑精選 → 每張做成 3 秒慢慢推近的片段 → 淡入淡出接起來 → 配樂
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { q } from './db.js';
import { hamming } from './media.js';
import { displayPath } from './ingest.js';
import { zhMonth, parts } from './time.js';

const exec = promisify(execFile);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const W = () => config.recap.width, H = () => config.recap.height, FPS = 30, XF = 0.6;

export const recapFile = period => path.join(config.recapDir, `${period}.mp4`);
export const recapPoster = period => path.join(config.recapDir, `${period}.jpg`);
export const isYear = period => /^\d{4}$/.test(period);
export const periodTitle = period => isYear(period) ? `${period} 年` : zhMonth(period);

/** 挑精選：分數高的優先，但每天（年度則每月）輪流挑，避免整支都是同一天；連拍只留一張 */
export function pickHighlights(period, max = isYear(period) ? Math.round(config.recap.maxPhotos * 1.6) : config.recap.maxPhotos) {
  const rows = q.all(`
    SELECT ph.id, ph.taken_at, ph.ym, ph.ymd, ph.dhash, ph.caption, ph.quality, ph.highlight, ph.sharpness, ph.face_count,
      (SELECT COUNT(*) FROM faces f WHERE f.photo_id = ph.id AND f.status IN ('auto', 'confirmed')) AS known,
      (SELECT group_concat(p.name, '、') FROM faces f JOIN people p ON p.id = f.person_id
        WHERE f.photo_id = ph.id AND f.status IN ('auto', 'confirmed')) AS names
    FROM photos ph
    WHERE ph.hidden = 0 AND ph.duplicate_of IS NULL AND ph.kind = 'photo' AND ph.is_document = 0 AND ${isYear(period) ? 'substr(ph.ym, 1, 4)' : 'ph.ym'} = ?`, period);
  for (const r of rows) {
    r.score = (r.highlight ?? 3) * 2 + (r.quality ?? 3) + Math.min((r.sharpness || 0) / 15, 2) + (r.known ? 2 : r.face_count ? 1 : 0);
  }
  const buckets = new Map();
  for (const r of rows) {
    const k = isYear(period) ? r.ym : r.ymd;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const lists = [...buckets.values()].map(l => l.sort((a, b) => b.score - a.score)).sort((a, b) => b[0].score - a[0].score);
  const picked = [];
  for (let round = 0; picked.length < max && lists.some(l => l.length); round++) {
    for (const l of lists) {
      if (picked.length >= max) break;
      let c;
      while ((c = l.shift())) {
        if (!picked.some(p => p.dhash && c.dhash && hamming(p.dhash, c.dhash) <= 8)) { picked.push(c); break; }
      }
    }
  }
  return { picked: picked.sort((a, b) => a.taken_at - b.taken_at), totalPhotos: rows.length };
}

const svgText = (lines, opts = {}) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W()}" height="${H()}">
  ${opts.defs || ''}${opts.bg || ''}
  ${lines.map(l => `<text x="${l.x ?? W() / 2}" y="${l.y}" font-family="${esc(config.recap.font)}" font-size="${l.size}" font-weight="${l.weight || 400}"
    fill="${l.fill || '#fff'}" text-anchor="${l.anchor || 'middle'}" ${l.spacing ? `letter-spacing="${l.spacing}"` : ''}>${esc(l.text)}</text>`).join('\n')}
</svg>`);

/** 直式照片不裁切：後面墊一層同一張的模糊放大版 */
async function frameOf(photoId) {
  const src = await fs.readFile(displayPath(photoId));
  const bg = await sharp(src).resize(W(), H(), { fit: 'cover' }).blur(28).modulate({ brightness: 0.55 }).toBuffer();
  const fg = await sharp(src).resize(W(), H(), { fit: 'inside' }).toBuffer();
  return sharp(bg).composite([{ input: fg, gravity: 'centre' }]).jpeg({ quality: 90 }).toBuffer();
}
function captionOf(p) {
  const t = parts(p.taken_at);
  const line2 = [p.names, p.caption].filter(Boolean).join('｜');
  const h = H(), s = h / 720;
  return sharp(svgText([
    { text: `${t.m} 月 ${t.d} 日`, x: 44 * s, y: h - (line2 ? 62 : 36) * s, size: 22 * s, anchor: 'start', fill: '#ffffffcc', spacing: 1 },
    ...(line2 ? [{ text: line2.length > 34 ? line2.slice(0, 33) + '…' : line2, x: 44 * s, y: h - 28 * s, size: 30 * s, anchor: 'start', weight: 500 }] : [])
  ], {
    defs: `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.62"/></linearGradient></defs>`,
    bg: `<rect x="0" y="${h - 170 * s}" width="${W()}" height="${170 * s}" fill="url(#g)"/>`
  })).png().toBuffer();
}
async function titleCard(coverId, lines) {
  const src = await fs.readFile(displayPath(coverId));
  const bg = await sharp(src).resize(W(), H(), { fit: 'cover' }).blur(22).modulate({ brightness: 0.42 }).toBuffer();
  return sharp(bg).composite([{ input: await sharp(svgText(lines)).png().toBuffer() }]).jpeg({ quality: 90 }).toBuffer();
}

async function renderClip(out, basePath, overlayPath, seconds, zoomIn) {
  const n = Math.round(seconds * FPS);
  const z = zoomIn === null ? '1' : zoomIn ? `1+0.10*on/${n}` : `1.10-0.10*on/${n}`;
  const zoom = `scale=${W() * 2}:${H() * 2},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${n}:s=${W()}x${H()}:fps=${FPS}`;
  const args = ['-v', 'error', '-y', '-i', basePath];
  if (overlayPath) args.push('-loop', '1', '-framerate', String(FPS), '-i', overlayPath, '-filter_complex', `[0:v]${zoom}[z];[z][1:v]overlay=0:0,format=yuv420p[v]`);
  else args.push('-filter_complex', `[0:v]${zoom},format=yuv420p[v]`);
  args.push('-map', '[v]', '-frames:v', String(n), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out);
  await exec('ffmpeg', args, { maxBuffer: 1 << 24 });
}

async function pickMusic(period) {
  try {
    const files = (await fs.readdir(config.musicDir)).filter(f => /\.(mp3|m4a|aac|wav|ogg)$/i.test(f)).sort();
    if (!files.length) return null;
    const n = [...period].reduce((s, c) => s + c.charCodeAt(0), 0);
    return path.join(config.musicDir, files[n % files.length]);
  } catch { return null; }
}

/**
 * @param {string} period '2026-10' 或 '2026'
 * @returns {Promise<{period, title, file, photoCount, duration}>}
 */
export async function makeRecap(period) {
  if (!/^\d{4}(-\d{2})?$/.test(period)) throw new Error('期間格式要是 2026-10 或 2026');
  const { picked, totalPhotos } = pickHighlights(period);
  if (picked.length < 3) throw new Error(`${periodTitle(period)}的照片只有 ${picked.length} 張，太少了做不成影片`);

  const recId = Number(q.run(`INSERT INTO recaps(kind, period, title, status, created_at) VALUES(?,?,?,'making',?)`,
    isYear(period) ? 'year' : 'month', period, `${periodTitle(period)}回顧`, Date.now()).lastInsertRowid);
  const work = path.join(config.recapDir, `work-${recId}`);
  await fs.mkdir(work, { recursive: true });
  try {
    const sec = isYear(period) ? Math.max(2.2, config.recap.secondsPerPhoto - 0.6) : config.recap.secondsPerPhoto;
    const s = H() / 720;
    const people = q.all(`SELECT p.name, COUNT(DISTINCT f.photo_id) AS n FROM faces f JOIN people p ON p.id = f.person_id JOIN photos ph ON ph.id = f.photo_id
      WHERE f.status IN ('auto', 'confirmed') AND ph.hidden = 0 AND ph.duplicate_of IS NULL AND ${isYear(period) ? 'substr(ph.ym, 1, 4)' : 'ph.ym'} = ?
      GROUP BY p.id ORDER BY n DESC LIMIT 4`, period);
    const cover = [...picked].sort((a, b) => b.score - a.score)[0];

    const clips = []; // {file, dur}
    const jobs = [];
    const intro = path.join(work, 'intro.jpg');
    await fs.writeFile(intro, await titleCard(cover.id, [
      { text: periodTitle(period), y: H() / 2 - 6 * s, size: 76 * s, weight: 700, spacing: 4 },
      { text: '我 們 家 的 回 顧', y: H() / 2 + 58 * s, size: 30 * s, fill: '#ffffffd0', spacing: 6 }
    ]));
    clips.push({ file: path.join(work, 'c000.mp4'), dur: 2.6 });
    jobs.push(() => renderClip(clips[0].file, intro, null, 2.6, null));

    picked.forEach((p, i) => {
      const clip = { file: path.join(work, `c${String(i + 1).padStart(3, '0')}.mp4`), dur: sec };
      clips.push(clip);
      jobs.push(async () => {
        const base = path.join(work, `f${i}.jpg`), cap = path.join(work, `t${i}.png`);
        await fs.writeFile(base, await frameOf(p.id));
        await fs.writeFile(cap, await captionOf(p));
        await renderClip(clip.file, base, cap, sec, i % 2 === 0);
      });
    });

    const outro = path.join(work, 'outro.jpg');
    await fs.writeFile(outro, await titleCard(picked[picked.length - 1].id, [
      { text: `這${isYear(period) ? '一年' : '個月'}留下了 ${totalPhotos} 張照片`, y: H() / 2 - 20 * s, size: 44 * s, weight: 600 },
      ...(people.length ? [{ text: people.map(p => `${p.name} ${p.n} 張`).join('　'), y: H() / 2 + 40 * s, size: 28 * s, fill: '#ffffffd0' }] : []),
      { text: '家庭相簿小秘書', y: H() - 48 * s, size: 20 * s, fill: '#ffffff90', spacing: 3 }
    ]));
    const last = { file: path.join(work, 'c999.mp4'), dur: 3.2 };
    clips.push(last);
    jobs.push(() => renderClip(last.file, outro, null, 3.2, null));

    // 一次跑 3 個片段
    let next = 0;
    await Promise.all(Array.from({ length: 3 }, async () => { while (next < jobs.length) await jobs[next++](); }));

    // 淡入淡出串接
    const args = ['-v', 'error', '-y'];
    clips.forEach(c => args.push('-i', c.file));
    const music = await pickMusic(period);
    let total = clips[0].dur, graph = '', prev = '0:v';
    for (let i = 1; i < clips.length; i++) {
      const out = i === clips.length - 1 ? 'vout' : `x${i}`;
      graph += `[${prev}][${i}:v]xfade=transition=fade:duration=${XF}:offset=${(total - XF).toFixed(3)}[${out}];`;
      total += clips[i].dur - XF;
      prev = out;
    }
    if (music) args.push('-stream_loop', '-1', '-i', music);
    else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    graph += `[${clips.length}:a]atrim=0:${total.toFixed(3)},afade=t=in:d=1,afade=t=out:st=${Math.max(0, total - 2.5).toFixed(3)}:d=2.5[aout]`;
    const file = recapFile(period);
    args.push('-filter_complex', graph, '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', file + '.tmp.mp4');
    await exec('ffmpeg', args, { maxBuffer: 1 << 24 });
    await fs.rename(file + '.tmp.mp4', file);
    await fs.copyFile(intro, recapPoster(period));

    q.run(`DELETE FROM recaps WHERE period = ? AND id != ?`, period, recId);
    q.run(`UPDATE recaps SET status = 'ready', photo_count = ?, duration = ? WHERE id = ?`, picked.length, Math.round(total * 10) / 10, recId);
    return { period, title: `${periodTitle(period)}回顧`, file, photoCount: picked.length, duration: total, music: Boolean(music) };
  } catch (e) {
    q.run(`UPDATE recaps SET status = 'failed', error = ? WHERE id = ?`, String(e.message).slice(0, 500), recId);
    throw e;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

const making = new Map(); // 同一個期間不要重複做
export function makeRecapOnce(period) {
  if (!making.has(period)) making.set(period, makeRecap(period).finally(() => making.delete(period)));
  return making.get(period);
}
export const readyRecap = period => q.get(`SELECT * FROM recaps WHERE period = ? AND status = 'ready' ORDER BY id DESC LIMIT 1`, period);
