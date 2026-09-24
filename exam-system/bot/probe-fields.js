'use strict';
/**
 * 建完 Ragic 四張表後跑這支，把欄位 ID 印出來填進 exam-module.js 的 FIELDS。
 * 用法：RAGIC_KEY=xxx node bot/probe-fields.js bookkeeping/7 bookkeeping/8 bookkeeping/9
 * 注意：Ragic 複製表單會把欄位 ID 全部重編，所以每次建新表都要重跑，不能沿用舊的。
 */
const BASE = process.env.RAGIC_BASE || 'https://ap10.ragic.com/Fan28';
const KEY  = process.env.RAGIC_KEY;
if (!KEY) { console.error('請先設 RAGIC_KEY 環境變數'); process.exit(1); }

(async () => {
  for (const sheet of process.argv.slice(2)) {
    console.log('\n=== ' + sheet + ' ===');
    try {
      // 先用中文名讀一筆，再用 fid 讀同一筆，兩邊對起來就是「中文名 → 欄位 ID」
      const [named, fid] = await Promise.all([
        fetch(`${BASE}/${sheet}?api&limit=1`, { headers:{ Authorization:'Basic '+KEY } }).then(r => r.json()),
        fetch(`${BASE}/${sheet}?api&naming=fid&limit=1`, { headers:{ Authorization:'Basic '+KEY } }).then(r => r.json())
      ]);
      const a = Object.values(named || {})[0], b = Object.values(fid || {})[0];
      if (!a || !b) { console.log('這張表還沒有資料，請先在 Ragic 手動建一筆再跑一次'); continue; }
      const map = {};
      for (const [cname, val] of Object.entries(a)) {
        if (cname.startsWith('_')) continue;
        const hit = Object.keys(b).find(k => !k.startsWith('_') && b[k] === val && !Object.values(map).includes(k));
        if (hit) map[cname] = hit;
      }
      for (const [k, v] of Object.entries(map)) console.log(`  ${k}: '${v}',`);
      const miss = Object.keys(a).filter(k => !k.startsWith('_') && !map[k]);
      if (miss.length) console.log('  ⚠ 對不出來（該欄是空值，填點資料再跑）:', miss.join(', '));
    } catch (e) { console.log('  失敗:', e.message); }
  }
})();
