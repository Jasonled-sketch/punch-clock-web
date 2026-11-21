// 測試用照片：拿人臉套件附的範例圖，做出「同一批人、不同天、不同構圖」的變化版，並寫入 EXIF 拍攝時間
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const demo = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'demo');

const exif = (y, m, d, h) => ({ IFD0: { Make: 'TestCam' }, IFD2: { DateTimeOriginal: `${y}:${String(m).padStart(2, '0')}:${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:15:00` } });

export async function makeFixtures(dir, { year = 2026, month = 10 } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const out = [];
  const variants = [
    img => img,                                                             // 原圖
    img => img.modulate({ brightness: 1.15, saturation: 0.9 }),            // 亮一點
    img => img.extract({ left: 120, top: 40, width: 1600, height: 1100 })  // 換個構圖
  ];
  for (let s = 1; s <= 4; s++) {
    for (let v = 0; v < variants.length; v++) {
      const file = path.join(dir, `p${s}-${v}.jpg`);
      const base = sharp(await fs.readFile(path.join(demo, `sample${s}.jpg`)));
      await variants[v](base).withExif(exif(year, month, 2 + s * 5 + v, 9 + v)).jpeg({ quality: 88 }).toFile(file);
      out.push(file);
    }
  }
  // 沒有人臉的風景照
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, `scene${i}.jpg`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${200 + i * 25},70%,${55 + i * 5}%)"/><stop offset="1" stop-color="hsl(${30 + i * 40},80%,70%)"/></linearGradient></defs>
      <rect width="1600" height="1200" fill="url(#g)"/><circle cx="${300 + i * 300}" cy="${250 + i * 40}" r="110" fill="#fff8d0"/>
      <path d="M0 900 Q 400 ${700 - i * 40} 800 880 T 1600 ${820 + i * 20} V1200 H0Z" fill="hsl(${140 + i * 10},45%,32%)"/></svg>`;
    await sharp(Buffer.from(svg)).withExif(exif(year, month, 4 + i * 6, 16)).jpeg({ quality: 88 }).toFile(file);
    out.push(file);
  }
  return out;
}
