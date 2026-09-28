#!/usr/bin/env node
// 自動抓 Ragic 欄位 ID，輸出可以直接貼進環境變數的 JSON。
//
// 為什麼需要這個：Ragic 的 POST 只認欄位 ID（像 1002825），不認中文欄位名，
// 送中文名會靜默失敗——回 SUCCESS 但欄位是空的。一張表十幾個欄位，
// 手動去後台一個一個抄 ID 又慢又容易抄錯行。
//
// 用法：
//   1. 用 ragic/*.csv 匯入建表（CSV 第二列就是探測標記，匯入後自動變成一筆記錄）
//   2. RAGIC_API_KEY=xxx node tools/probe-fields.js ragicproject-management/21 visit
//   3. 把印出來的 JSON 貼進 RAGIC_VISIT_FIELDS
//   4. 回 Ragic 把那筆 PROBE 記錄刪掉
//
// 第二個參數是表的種類：visit（拜訪記錄）、punch（工牌打卡）、customer（客戶主檔）

const MARKERS = {
  visit: {
    date: '2001/01/02',
    plateNum: 'PROBEPLATE',
    imei: 'PROBEIMEI',
    driver: 'PROBEDRIVER',
    customer: 'PROBECUSTOMER',
    customerCode: 'PROBECUSTCODE',
    arrivedAt: 'PROBEARRIVED|2001/01/02 03:04:05',
    departedAt: 'PROBEDEPARTED|2001/01/02 06:07:08',
    durationMinutes: '91001',
    distanceMeters: '91002',
    lat: 'PROBELAT',
    lng: 'PROBELNG',
    mapUrl: 'PROBEMAPURL',
    summary: 'PROBESUMMARY',
    category: 'PROBECATEGORY',
    source: 'PROBESOURCE',
  },
  punch: {
    date: '2001/01/02',
    name: 'PROBENAME',
    imei: 'PROBEIMEI',
    direction: 'PROBEDIR',
    at: 'PROBEAT|2001/01/02 03:04:05',
    lat: 'PROBELAT',
    lng: 'PROBELNG',
    place: 'PROBEPLACE',
    mileageMeters: '91003',
  },
  // 客戶主檔是既有的表，不會有探測標記。這裡靠欄位名稱猜，
  // 猜不到就看底下印出來的完整欄位清單自己挑。
  customer: {
    name: null,
    lat: null,
    lng: null,
  },
};

const NAME_HINTS = {
  name: ['客戶名稱', '客戶', '公司名稱', '名稱'],
  lat: ['緯度', 'lat', 'latitude'],
  lng: ['經度', 'lng', 'lon', 'longitude'],
};

const [, , sheetPath, kindArg] = process.argv;
const kind = kindArg || 'visit';

if (!sheetPath) {
  console.error('用法: RAGIC_API_KEY=xxx node tools/probe-fields.js <表單路徑> [visit|punch|customer]');
  console.error('例如: RAGIC_API_KEY=xxx node tools/probe-fields.js ragicproject-management/21 visit');
  process.exit(1);
}
if (!MARKERS[kind]) {
  console.error(`不認識的表種類 "${kind}"，可用: ${Object.keys(MARKERS).join(', ')}`);
  process.exit(1);
}

const KEY = process.env.RAGIC_API_KEY;
if (!KEY) {
  console.error('請設定 RAGIC_API_KEY');
  process.exit(1);
}
const BASE = (process.env.RAGIC_BASE || 'https://ap10.ragic.com/Fan28').replace(/\/+$/, '');

function norm(v) {
  return String(v == null ? '' : v).trim();
}

async function main() {
  // 抓兩份：naming=fid 拿欄位 ID，不帶 naming 拿中文欄位名，兩份對照
  const urlFid = `${BASE}/${sheetPath}?api&naming=fid&limit=200`;
  const urlName = `${BASE}/${sheetPath}?api&limit=200`;
  const headers = { Authorization: `Basic ${KEY}` };

  const [rf, rn] = await Promise.all([fetch(urlFid, { headers }), fetch(urlName, { headers })]);
  if (!rf.ok) {
    console.error(`讀取失敗 HTTP ${rf.status}: ${(await rf.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const byFid = await rf.json();
  const byName = rn.ok ? await rn.json() : {};

  const fidRecords = Object.entries(byFid).filter(([k]) => /^\d+$/.test(k));
  if (!fidRecords.length) {
    console.error('這張表目前沒有任何記錄。先匯入 ragic/*.csv（裡面含探測用的那一列）再跑一次。');
    process.exit(1);
  }

  const wanted = MARKERS[kind];
  const markerValues = Object.values(wanted).filter(Boolean)
    .flatMap((m) => String(m).split('|'));

  // 找出含有最多探測標記的那筆記錄
  let best = null;
  let bestHits = 0;
  for (const [recId, rec] of fidRecords) {
    const vals = Object.values(rec).map(norm);
    const hits = markerValues.filter((m) => vals.some((v) => v === m || v.includes(m))).length;
    if (hits > bestHits) { bestHits = hits; best = [recId, rec]; }
  }

  // 建立 欄位ID → 中文欄位名 的對照
  const fidToName = {};
  if (best) {
    const nameRec = byName[best[0]];
    if (nameRec) {
      for (const [fid, val] of Object.entries(best[1])) {
        for (const [cn, v2] of Object.entries(nameRec)) {
          if (norm(val) === norm(v2) && norm(val) !== '' && !/^_/.test(cn)) {
            fidToName[fid] = cn;
          }
        }
      }
    }
  }

  const mapping = {};
  const unresolved = [];

  if (kind === 'customer') {
    // 靠欄位名稱猜
    const anyRec = byName[fidRecords[0][0]] || {};
    const fidRec = fidRecords[0][1];
    const nameToFid = {};
    for (const [fid, val] of Object.entries(fidRec)) {
      for (const [cn, v2] of Object.entries(anyRec)) {
        if (norm(val) === norm(v2) && norm(val) !== '' && !/^_/.test(cn)) nameToFid[cn] = fid;
      }
    }
    for (const key of Object.keys(wanted)) {
      const hit = Object.keys(nameToFid).find((cn) => (NAME_HINTS[key] || []).some((h) => cn.includes(h)));
      if (hit) mapping[key] = nameToFid[hit];
      else unresolved.push(key);
    }
  } else {
    if (!best || bestHits === 0) {
      console.error('找不到含探測標記的記錄。請確認有用 ragic/*.csv 匯入，且那一列 PROBE 資料還在。');
      process.exit(1);
    }
    const [, rec] = best;
    for (const [key, marker] of Object.entries(wanted)) {
      if (!marker) { unresolved.push(key); continue; }
      const candidates = String(marker).split('|');
      const found = Object.entries(rec).find(([fid, val]) => {
        if (!/^\d+$/.test(fid)) return false;
        const v = norm(val);
        return candidates.some((c) => v === c || (c.length > 5 && v.includes(c)));
      });
      if (found) mapping[key] = found[0];
      else unresolved.push(key);
    }
  }

  const envName = kind === 'visit' ? 'RAGIC_VISIT_FIELDS'
    : kind === 'punch' ? 'RAGIC_PUNCH_FIELDS' : 'RAGIC_CUSTOMER_FIELDS';

  console.log('');
  console.log('─'.repeat(70));
  console.log(`對應結果（${Object.keys(mapping).length} / ${Object.keys(wanted).length} 個欄位）`);
  console.log('─'.repeat(70));
  for (const [key, fid] of Object.entries(mapping)) {
    const cn = fidToName[fid] ? `  ← ${fidToName[fid]}` : '';
    console.log(`  ${key.padEnd(18)} ${fid}${cn}`);
  }
  if (unresolved.length) {
    console.log('');
    console.log('  沒對應到：' + unresolved.join(', '));
    console.log('  （非必填欄位沒建就會這樣，程式會自動略過。必填的是 date / plateNum / arrivedAt）');
  }

  console.log('');
  console.log('貼進環境變數：');
  console.log('');
  console.log(`${envName}=${JSON.stringify(mapping)}`);
  console.log('');

  if (kind !== 'customer') {
    console.log('做完記得回 Ragic 把那筆 PROBE 記錄刪掉。');
  }

  // 對不到時，把整張表的欄位倒出來給人工挑
  if (unresolved.length && best) {
    console.log('');
    console.log('該筆記錄的完整欄位（人工對照用）：');
    for (const [fid, val] of Object.entries(best[1])) {
      if (!/^\d+$/.test(fid)) continue;
      const cn = fidToName[fid] ? ` (${fidToName[fid]})` : '';
      console.log(`  ${fid}${cn} = ${norm(val).slice(0, 60)}`);
    }
  }
}

main().catch((err) => {
  console.error('執行失敗:', err.message);
  process.exit(1);
});
