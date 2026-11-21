// 影像處理：HEIC 轉檔、轉正、縮圖、EXIF、清晰度、相似度指紋、影片抽格
import sharp from 'sharp';
import exifr from 'exifr';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { parseExifDate } from './time.js';

const exec = promisify(execFile);

export function sniff(buf) {
  if (buf.length < 12) return 'unknown';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (/^(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return 'heic';
    if (brand === 'avif') return 'avif';
    return 'video'; // mp4 / mov / 3gp…
  }
  if (buf.toString('hex', 0, 4) === '1a45dfa3') return 'video'; // mkv / webm
  return 'unknown';
}
export const extOf = type => ({ jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', heic: 'heic', avif: 'avif', video: 'mp4' }[type] || 'bin');

/** 讀 EXIF：拍攝時間（沒有時區 → 當成家裡的時區）、GPS */
export async function readExif(buf) {
  try {
    const x = await exifr.parse(buf, {
      reviveValues: false, gps: true,
      pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'OffsetTime', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef']
    });
    if (!x) return {};
    const takenAt = parseExifDate(x.DateTimeOriginal || x.CreateDate, x.OffsetTimeOriginal || x.OffsetTime);
    const lat = Number.isFinite(x.latitude) ? x.latitude : null;
    const lng = Number.isFinite(x.longitude) ? x.longitude : null;
    return { takenAt, lat, lng };
  } catch { return {}; }
}

/** 任何格式 → 轉正的 JPEG（HEIC 用純 JS 解碼，因為 sharp 預設不含 HEIC） */
export async function toUprightJpeg(buf, type = sniff(buf)) {
  let input = buf;
  if (type === 'heic') {
    const { default: convert } = await import('heic-convert');
    input = Buffer.from(await convert({ buffer: buf, format: 'JPEG', quality: 0.92 }));
  }
  return sharp(input, { failOn: 'none' }).rotate().jpeg({ quality: 92 }).toBuffer();
}

/** 產生瀏覽用中圖、縮圖、清晰度分數、相似度指紋 */
export async function derive(uprightJpeg) {
  const meta = await sharp(uprightJpeg).metadata();
  const [display, thumb, dhash, sharpness] = await Promise.all([
    sharp(uprightJpeg).resize(config.media.displaySize, config.media.displaySize, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true }).toBuffer(),
    sharp(uprightJpeg).resize(config.media.thumbSize, config.media.thumbSize, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 72 }).toBuffer(),
    dHash(uprightJpeg),
    sharpnessOf(uprightJpeg)
  ]);
  return { width: meta.width, height: meta.height, display, thumb, dhash, sharpness };
}

/** 64-bit 差異雜湊：同一張照片經 LINE 壓縮後指紋幾乎不變，用來抓「同一張傳兩次」 */
export async function dHash(jpeg) {
  const px = await sharp(jpeg).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}
export function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/** 清晰度：邊緣強度的標準差，越大越清楚（手震/失焦會很低） */
export async function sharpnessOf(jpeg) {
  const { channels } = await sharp(jpeg).greyscale().resize(320, 320, { fit: 'inside' })
    .convolve({ width: 3, height: 3, kernel: [0, -1, 0, -1, 4, -1, 0, -1, 0], offset: 128 }).stats();
  return Math.round(channels[0].stdev * 10) / 10;
}

/** 裁出人臉小圖（給認人頁用） */
export async function cropFace(jpeg, box, size = 160) {
  const meta = await sharp(jpeg).metadata();
  const pad = 0.35;
  const cx = (box.x + box.w / 2) * meta.width, cy = (box.y + box.h / 2) * meta.height;
  const side = Math.max(box.w * meta.width, box.h * meta.height) * (1 + pad * 2);
  const left = Math.max(0, Math.round(cx - side / 2)), top = Math.max(0, Math.round(cy - side / 2));
  const width = Math.max(1, Math.min(meta.width - left, Math.round(side)));
  const height = Math.max(1, Math.min(meta.height - top, Math.round(side)));
  return sharp(jpeg).extract({ left, top, width, height }).resize(size, size, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
}

/** 影片：抽一格當封面 + 讀長度與拍攝時間 */
export async function probeVideo(filePath) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
  const info = JSON.parse(stdout);
  const duration = Number(info.format?.duration) || 0;
  const created = info.format?.tags?.creation_time || info.streams?.find(s => s.tags?.creation_time)?.tags.creation_time;
  const takenAt = created && !Number.isNaN(Date.parse(created)) ? Date.parse(created) : null;
  const tmp = path.join(os.tmpdir(), `frame-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  try {
    await exec('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.min(1, duration / 2)), '-i', filePath, '-frames:v', '1', '-q:v', '2', tmp]);
    return { duration, takenAt, frame: await fs.readFile(tmp) };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
