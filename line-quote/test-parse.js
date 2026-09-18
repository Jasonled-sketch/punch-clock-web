'use strict';
/**
 * 本機測試（不經 LINE）：
 *   node line-quote/test-parse.js --mock            只用內建範例，不打任何 API，看組出來的欄位
 *   node line-quote/test-parse.js                   打 Claude 解析內建範例（需 ANTHROPIC_API_KEY）
 *   node line-quote/test-parse.js "報價單 xxx ..."   解析你給的文字
 *   node line-quote/test-parse.js --write           解析後真的寫進 Ragic Sheet 8（需 RAGIC_API_KEY）
 */
const bot = require('./quote-bot');

const SAMPLE = `蚵寮國小
1.更換為訊號延伸器組(華碩) $3500
2.更換為華碩 USB無線網卡 $1200
3.升級韌體為非陸製軟件組 $8600
4.實體開關 拉線壁切 $2000`;

const MOCK = {
  customer: '蚵寮國小', phone: '', address: '', memo: '', category: '',
  items: [
    { name: '更換為訊號延伸器組(華碩)', spec: '', qty: 1, unit: '組', price: 3500, kind: 'product' },
    { name: '更換為華碩 USB無線網卡', spec: '', qty: 1, unit: '個', price: 1200, kind: 'product' },
    { name: '升級韌體為非陸製軟件組', spec: '', qty: 1, unit: '式', price: 8600, kind: 'product' },
    { name: '實體開關 拉線壁切', spec: '', qty: 1, unit: '式', price: 2000, kind: 'extra' },
  ],
};

(async () => {
  const args = process.argv.slice(2);
  const mock = args.includes('--mock');
  const write = args.includes('--write');
  const textArg = args.filter(a => !a.startsWith('--')).join(' ').replace(/^\s*報價單\s*/, '');
  const body = textArg || SAMPLE;

  let parsed;
  if (mock) { parsed = MOCK; console.log('（mock）跳過 Claude'); }
  else { console.log('→ Claude 解析中…'); parsed = await bot.parseQuoteText(body); }
  console.log('\n=== 解析結果 ===\n' + JSON.stringify(parsed, null, 2));

  let cust = null;
  if (process.env.RAGIC_API_KEY) {
    try { cust = await bot.lookupCustomer(parsed.customer); console.log('\n=== CRM 對到 ===', cust ? cust['客戶簡稱'] : '（無）'); }
    catch (e) { console.log('\nCRM 查詢失敗：', e.message); }
  } else console.log('\n（沒有 RAGIC_API_KEY，跳過 CRM 查詢）');

  const fd = bot.buildQuoteForm(parsed, cust, 'J');
  console.log('\n=== 將送到 Sheet 8 的欄位 ===');
  for (const [k, v] of fd.entries()) console.log(`${k} = ${v}`);

  if (write) {
    console.log('\n→ 寫入 Ragic…');
    const r = await bot.createQuote(parsed, cust, 'J');
    console.log('✅ 建好了：', r);
  } else console.log('\n（沒帶 --write，未寫入 Ragic）');
})().catch(e => { console.error('❌', e); process.exit(1); });
