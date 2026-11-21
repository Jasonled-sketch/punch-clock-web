// 把電腦上一個資料夾的照片整批匯入（測試或一次性搬舊照片用）
// 用法：npm run import -- /path/to/photos [上傳者名字]
import fs from 'node:fs/promises';
import path from 'node:path';
import { ingest } from '../src/ingest.js';

const [dir, uploader = '匯入'] = process.argv.slice(2);
if (!dir) { console.error('用法：npm run import -- <資料夾> [上傳者名字]'); process.exit(1); }

async function* walk(d) {
  for (const e of await fs.readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(jpe?g|png|webp|heic|heif|mp4|mov)$/i.test(e.name)) yield p;
  }
}
let added = 0, dup = 0, failed = 0;
for await (const file of walk(path.resolve(dir))) {
  try {
    const st = await fs.stat(file);
    const r = await ingest({ filePath: file, source: 'import', sourceRef: file, uploader, fallbackTime: st.mtimeMs, fallbackSrc: 'file' });
    r.status === 'added' ? added++ : dup++;
    console.log(`${r.status === 'added' ? '＋' : '＝'} ${path.basename(file)} → ${r.ym}${r.names.length ? '（' + r.names.join('、') + '）' : ''}${r.unknownFaces ? `　待認 ${r.unknownFaces} 張臉` : ''}`);
  } catch (e) { failed++; console.error(`✗ ${path.basename(file)}：${e.message}`); }
}
console.log(`\n完成：新增 ${added}、重複 ${dup}、失敗 ${failed}`);
