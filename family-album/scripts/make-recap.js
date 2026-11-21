// 手動做一支回顧影片。用法：npm run recap -- 2026-10   或   npm run recap -- 2026
import { makeRecap } from '../src/recap.js';
import { prevMonth } from '../src/time.js';
const period = process.argv[2] || prevMonth();
const t0 = Date.now();
const r = await makeRecap(period);
console.log(`✅ ${r.title}：${r.photoCount} 張、${r.duration.toFixed(1)} 秒${r.music ? '、有配樂' : '、無配樂（把 mp3 放進 music 資料夾就會自動配）'}\n   ${r.file}（花了 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
