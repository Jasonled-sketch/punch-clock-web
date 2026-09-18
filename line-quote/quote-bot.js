'use strict';
/**
 * USLED LINE 群組 → Ragic 專案報價單（Sheet 8）自動建單模組
 *
 * 放進 usled-linebot 專案（Railway），在 webhook 的群組事件分支呼叫：
 *
 *   const quoteBot = require('./line-quote/quote-bot');
 *   ...
 *   if (ev.source.type === 'group' || ev.source.type === 'room') {
 *     if (await quoteBot.handleEvent(ev, { lineToken: ACCOUNT_TOKEN })) continue;
 *     ... 原本的群組流程 ...
 *   }
 *
 * 指令（只認 QUOTE_STAFF 白名單內的員工）：
 *   報價單 <客戶> <品項…>      → 建 Sheet 8 草稿，reply Flex 卡（免費）
 *   查報價 <關鍵字>            → 搜 Sheet 8，reply 列表（免費）
 *   照片：報價單前後 3 分鐘內傳的圖片自動掛到該單「上傳圖片」欄
 *
 * 環境變數（Railway → Variables）：
 *   ANTHROPIC_API_KEY   Claude
 *   RAGIC_API_KEY       Ragic 服務帳戶 Claude YSPE 的 API key
 *   QUOTE_STAFF         JSON：LINE userId → 首洽縮寫，如 {"Uaaa":"J","Ubbb":"T","Uccc":"W"}
 *   QUOTE_GROUP_ID      （選填）只在這個群組生效；不填＝所有群組都可用
 *   QUOTE_MODEL         （選填）預設 claude-opus-5
 */

const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');

// ───────────────────────────── 設定 ─────────────────────────────
const RAGIC_BASE = 'https://ap10.ragic.com/Fan28';
const SHEET_QUOTE = `${RAGIC_BASE}/ragicproject-management/8`;          // 專案報價單（客製）
const SHEET_CRM = `${RAGIC_BASE}/ragicsales-order-management/20004`;    // 客戶主檔
const MODEL = process.env.QUOTE_MODEL || 'claude-opus-5';

// Sheet 8 主表欄位 ID（2026-06 API 探測，見 skill ragic-api/references/usled-sheets.md）
const F = {
  caseNo: '1000644',     // 案件編號（自動）
  desc: '1000763',       // 案件敘述
  date: '1000759',       // 報價日期 YYYY/MM/DD
  category: '1002409',   // 產品類別
  brief: '1000764',      // 產品簡要
  customer: '1000645',   // 客戶名稱
  phone: '1000646',      // 連絡電話
  taxId: '1000835',      // 統編
  title: '1000836',      // 抬頭
  address: '1002646',    // 抵達地址
  firstContact: '1002753', // 首洽
  progress: '1000833',   // 進度欄
  total: '1000657',      // 現金未稅總計
  memo: '1001191',       // 其他備註
  photo: '1002179',      // 上傳圖片（檔案欄）
  SUB_PRODUCT: '1000655', // 子表 1 產品明細：序/項目/規格內容/數量/單位/單價
  SUB_EXTRA: '1000681',   // 子表 2 附加項目：序/附加項目/詳細內容/數量/單位/單價
};
const PROGRESS_DRAFT = '✎草稿';
const CATEGORIES = ['🌈小條屏', '中條屏', '大條屏', '電視牆', '特製屏', '光源材料', '照明燈具', '燈飾成品', '亮化加工'];

const PHOTO_WINDOW_MS = 3 * 60 * 1000;   // 照片與報價單文字配對的時間窗
const CMD_QUOTE = /^\s*(報價單|建報價|新報價)[\s:：]*/;
const CMD_SEARCH = /^\s*(查報價|找報價|@AI\s*(找|查)?)[\s:：]*/;

// ───────────────────────────── 狀態 ─────────────────────────────
const anthropic = new Anthropic();               // 讀 ANTHROPIC_API_KEY
const pending = new Map();                       // key = groupId:userId → { images:[{id,at}], lastQuote:{ragicId,caseNo,at} }

function staffMap() {
  try { return JSON.parse(process.env.QUOTE_STAFF || '{}'); } catch (e) { console.error('[quote] QUOTE_STAFF 不是合法 JSON'); return {}; }
}
function ragicKey() {
  const k = (process.env.RAGIC_API_KEY || '').trim();
  if (!k) throw new Error('RAGIC_API_KEY 未設定');
  return k;
}
function today() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);   // 台灣時間
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}
function money(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US'); }

// ───────────────────────────── 入口 ─────────────────────────────
/**
 * 回傳 true = 這個事件已被報價模組處理完，呼叫端應 continue。
 * opts.lineToken = 該 LINE OA 的 channel access token
 */
async function handleEvent(ev, opts) {
  const src = ev.source || {};
  if (src.type !== 'group' && src.type !== 'room') return false;
  const gid = src.groupId || src.roomId;
  if (process.env.QUOTE_GROUP_ID && gid !== process.env.QUOTE_GROUP_ID) return false;
  const initial = staffMap()[src.userId];
  if (!initial) return false;                            // 非白名單員工：不理
  if (ev.type !== 'message') return false;

  const key = `${gid}:${src.userId}`;
  const m = ev.message;

  if (m.type === 'image') {
    await onImage(ev, key, opts);
    return true;
  }
  if (m.type !== 'text') return false;
  const text = m.text || '';

  if (CMD_QUOTE.test(text)) {
    await onQuoteCommand(ev, key, initial, text.replace(CMD_QUOTE, ''), opts);
    return true;
  }
  if (CMD_SEARCH.test(text)) {
    await onSearchCommand(ev, text.replace(CMD_SEARCH, '').trim(), opts);
    return true;
  }
  return false;
}

// ───────────────────────────── 建單 ─────────────────────────────
async function onQuoteCommand(ev, key, initial, body, opts) {
  const reply = msgs => lineReply(ev.replyToken, msgs, opts.lineToken);
  if (!body.trim()) {
    return reply([text('請在「報價單」後面接客戶與品項，例如：\n報價單 蚵寮國小\n1.更換訊號延伸器組 $3500\n2.拉線壁切 $2000')]);
  }
  let parsed;
  try {
    parsed = await parseQuoteText(body);
  } catch (e) {
    console.error('[quote] parse fail', e);
    return reply([text('❌ 讀不懂這段內容，請再打一次（每個品項一行，結尾放金額）')]);
  }
  if (!parsed.items.length) return reply([text('❌ 沒有抓到任何品項，請每個品項一行、結尾放金額')]);

  let cust = null;
  try { cust = await lookupCustomer(parsed.customer); } catch (e) { console.error('[quote] CRM lookup fail', e.message); }

  let created;
  try {
    created = await createQuote(parsed, cust, initial);
  } catch (e) {
    console.error('[quote] ragic create fail', e);
    return reply([text('❌ Ragic 寫入失敗：' + String(e.message || e).slice(0, 120))]);
  }

  // 掛前 3 分鐘內傳的照片
  const st = pending.get(key) || { images: [] };
  const now = Date.now();
  const imgs = st.images.filter(i => now - i.at < PHOTO_WINDOW_MS);
  let nPhoto = 0;
  if (imgs.length) {
    try { nPhoto = await attachPhotos(created.ragicId, imgs.map(i => i.id), opts.lineToken); }
    catch (e) { console.error('[quote] photo attach fail', e.message); }
  }
  pending.set(key, { images: [], lastQuote: { ragicId: created.ragicId, caseNo: created.caseNo, at: now } });

  return reply([quoteFlex(created, parsed, cust, nPhoto)]);
}

/** Claude：自由文字 → 結構化報價 JSON */
async function parseQuoteText(body) {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['customer', 'phone', 'address', 'memo', 'category', 'items'],
    properties: {
      customer: { type: 'string', description: '客戶名稱／單位名稱，沒有就空字串' },
      phone: { type: 'string' },
      address: { type: 'string' },
      memo: { type: 'string', description: '不屬於品項的補充說明' },
      category: { type: 'string', enum: ['', ...CATEGORIES] },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'spec', 'qty', 'unit', 'price', 'kind'],
          properties: {
            name: { type: 'string', description: '品項名稱，去掉開頭的序號' },
            spec: { type: 'string', description: '規格／說明，沒有就空字串' },
            qty: { type: 'number' },
            unit: { type: 'string', description: '台/組/式/個/片/組…；不確定用「式」' },
            price: { type: 'number', description: '單價，未稅' },
            kind: { type: 'string', enum: ['product', 'extra'], description: 'product=機器/材料/零件；extra=施工/安裝/拉線/出車/工資/配件' },
          },
        },
      },
    },
  };
  const system = `你是 USLED 譽昇光電（LED 字幕機製造商）的報價單助理。員工在 LINE 群組貼的口語內容，請整理成報價單資料。
規則：
- 「$3500」「3500元」「三千五」都是金額；金額是單價，數量沒寫就是 1。
- 「更換」「升級」「維修」類的零件或機器 = product；「施工」「安裝」「拉線」「壁切」「出車」「工資」「配件」= extra。
- 產品類別只在明確看得出時才填（例：字幕機維修→🌈小條屏、施工為主→亮化加工），不確定留空字串。
- 客戶名稱保留原文，不要加「先生/小姐」。
- 不要編造內容，沒有的欄位給空字串或 0。`;

  const res = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: body }],
  });
  if (res.stop_reason === 'refusal') throw new Error('model refused');
  const raw = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const json = JSON.parse(raw.replace(/```json|```/g, '').trim());
  json.items = (json.items || []).filter(i => i && i.name).map(i => ({
    ...i, qty: Number(i.qty) > 0 ? Number(i.qty) : 1, price: Number(i.price) || 0, unit: i.unit || '式',
  }));
  return json;
}

/** CRM 20004 依客戶簡稱模糊查（讀取用中文名） */
async function lookupCustomer(name) {
  name = (name || '').trim();
  if (!name) return null;
  const url = `${SHEET_CRM}?api&where=3000479,like,${encodeURIComponent(name)}&limit=5`;
  const rows = await ragicGet(url);
  const list = Object.values(rows || {});
  if (!list.length) return null;
  const exact = list.find(r => (r['客戶簡稱'] || '').trim() === name);
  return exact || list[0];
}

/** 寫入 Sheet 8（主表 + 兩個子表），回 { ragicId, caseNo, url } */
async function createQuote(p, cust, initial) {
  const fd = buildQuoteForm(p, cust, initial);
  const r = await ragicPost(`${SHEET_QUOTE}?api&doFormula=true`, fd);
  if (!r || r.status !== 'SUCCESS') throw new Error('Ragic 回應：' + JSON.stringify(r).slice(0, 200));
  const ragicId = r.ragicId;
  const data = r.data || {};
  const caseNo = data['案件編號'] || data[F.caseNo] || ('#' + ragicId);
  return { ragicId, caseNo, url: `${SHEET_QUOTE}/${ragicId}` };
}

/** 純函式：組 FormData（test-parse.js 也用它做 dry-run） */
function buildQuoteForm(p, cust, initial) {
  const fd = new FormData();
  const items = p.items;
  const products = items.filter(i => i.kind !== 'extra');
  const extras = items.filter(i => i.kind === 'extra');
  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
  const brief = (products[0] || items[0]).name.slice(0, 40);
  const date = today();

  fd.append(F.date, date);
  fd.append(F.customer, p.customer || (cust && cust['客戶簡稱']) || '');
  fd.append(F.desc, `${date}-${p.customer || ''}-${brief}`);
  fd.append(F.brief, brief);
  fd.append(F.progress, PROGRESS_DRAFT);
  fd.append(F.firstContact, initial || '');
  fd.append(F.total, String(Math.round(total)));
  if (p.category) fd.append(F.category, p.category);
  if (p.memo) fd.append(F.memo, p.memo);
  const phone = p.phone || (cust && (cust['連絡手機'] || cust['電話號碼'])) || '';
  if (phone) fd.append(F.phone, phone);
  const addr = p.address || (cust && cust['送貨完整地址']) || '';
  if (addr) fd.append(F.address, addr);
  if (cust) {
    if (cust['統一編號']) fd.append(F.taxId, cust['統一編號']);
    if (cust['客戶全名（抬頭）']) fd.append(F.title, cust['客戶全名（抬頭）']);
  }
  products.forEach((it, i) => {
    const n = -(i + 1);
    fd.append(`${F.SUB_PRODUCT}_序_${n}`, String(i + 1));
    fd.append(`${F.SUB_PRODUCT}_項目_${n}`, it.name);
    if (it.spec) fd.append(`${F.SUB_PRODUCT}_規格內容_${n}`, it.spec);
    fd.append(`${F.SUB_PRODUCT}_數量_${n}`, String(it.qty));
    fd.append(`${F.SUB_PRODUCT}_單位_${n}`, it.unit);
    fd.append(`${F.SUB_PRODUCT}_單價_${n}`, String(it.price));
  });
  extras.forEach((it, i) => {
    const n = -(i + 1);
    fd.append(`${F.SUB_EXTRA}_序_${n}`, String(i + 1));
    fd.append(`${F.SUB_EXTRA}_附加項目_${n}`, '施工安裝');
    fd.append(`${F.SUB_EXTRA}_詳細內容_${n}`, it.spec ? `${it.name}（${it.spec}）` : it.name);
    fd.append(`${F.SUB_EXTRA}_數量_${n}`, String(it.qty));
    fd.append(`${F.SUB_EXTRA}_單位_${n}`, it.unit);
    fd.append(`${F.SUB_EXTRA}_單價_${n}`, String(it.price));
  });
  return fd;
}

// ───────────────────────────── 照片 ─────────────────────────────
async function onImage(ev, key, opts) {
  const st = pending.get(key) || { images: [] };
  const now = Date.now();
  const lq = st.lastQuote;
  if (lq && now - lq.at < PHOTO_WINDOW_MS) {
    // 報價單剛建好，照片直接掛上去
    try {
      await attachPhotos(lq.ragicId, [ev.message.id], opts.lineToken);
      lq.at = now;                                       // 連續傳多張，時間窗順延
      pending.set(key, st);
      await lineReply(ev.replyToken, [text(`📷 已掛到 ${lq.caseNo}`)], opts.lineToken);
    } catch (e) {
      console.error('[quote] attach fail', e.message);
      await lineReply(ev.replyToken, [text('❌ 照片掛到報價單失敗：' + e.message)], opts.lineToken);
    }
    return;
  }
  // 還沒有報價單：先暫存，等文字來配對
  st.images = st.images.filter(i => now - i.at < PHOTO_WINDOW_MS);
  st.images.push({ id: ev.message.id, at: now });
  pending.set(key, st);
  // 不回覆（避免群組洗版）；3 分鐘內打「報價單 …」就會一起附上
}

async function attachPhotos(ragicId, messageIds, lineToken) {
  const fd = new FormData();
  let n = 0;
  for (const id of messageIds) {
    const buf = await lineDownload(id, lineToken);
    fd.append(F.photo, new Blob([buf], { type: 'image/jpeg' }), `line-${id}.jpg`);
    n++;
  }
  const r = await ragicPost(`${SHEET_QUOTE}/${ragicId}?api`, fd);
  if (!r || r.status !== 'SUCCESS') throw new Error('上傳回應 ' + JSON.stringify(r).slice(0, 120));
  return n;
}

// ───────────────────────────── 查詢 ─────────────────────────────
async function onSearchCommand(ev, kw, opts) {
  const reply = msgs => lineReply(ev.replyToken, msgs, opts.lineToken);
  if (!kw) return reply([text('請接關鍵字，例如：查報價 蚵寮國小')]);
  let rows;
  try { rows = await searchQuotes(kw); }
  catch (e) { console.error('[quote] search fail', e); return reply([text('❌ 查詢失敗：' + e.message)]); }
  if (!rows.length) return reply([text(`找不到含「${kw}」的報價單`)]);
  return reply([searchFlex(kw, rows)]);
}

async function searchQuotes(kw) {
  const q = encodeURIComponent(kw);
  const urls = [
    `${SHEET_QUOTE}?api&where=${F.customer},like,${q}&limit=10`,
    `${SHEET_QUOTE}?api&where=${F.desc},like,${q}&limit=10`,
    `${SHEET_QUOTE}?api&where=${F.brief},like,${q}&limit=10`,
  ];
  const seen = new Map();
  for (const u of urls) {
    const rows = await ragicGet(u);
    for (const [rid, r] of Object.entries(rows || {})) if (!seen.has(rid)) seen.set(rid, { rid, ...r });
  }
  return [...seen.values()]
    .sort((a, b) => String(b['報價日期'] || '').localeCompare(String(a['報價日期'] || '')))
    .slice(0, 5);
}

// ───────────────────────────── 每日草稿提醒（cron 用，push 1 則） ─────────────────────────────
/** 例：cron.schedule('0 9 * * 1-6', () => quoteBot.remindDrafts({ lineToken, groupId })) */
async function remindDrafts({ lineToken, groupId }) {
  const rows = await ragicGet(`${SHEET_QUOTE}?api&where=${F.progress},eq,${encodeURIComponent(PROGRESS_DRAFT)}&limit=50`);
  const list = Object.entries(rows || {}).map(([rid, r]) => ({ rid, ...r }));
  if (!list.length) return 0;
  const lines = list.slice(0, 15).map(r => `• ${r['案件編號'] || r.rid} ${r['客戶名稱'] || ''}｜${r['產品簡要'] || ''}`);
  const body = `📝 尚未處理的報價單草稿 ${list.length} 筆：\n${lines.join('\n')}\n\n請到 Ragic 核價後改進度為「✉︎已報」`;
  await linePush(groupId, [text(body)], lineToken);
  return list.length;
}

// ───────────────────────────── Flex ─────────────────────────────
function text(t) { return { type: 'text', text: t }; }

function quoteFlex(created, p, cust, nPhoto) {
  const rows = p.items.map(it => ({
    type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`, size: 'sm', color: '#333333', flex: 5, wrap: true },
      { type: 'text', text: money(it.qty * it.price), size: 'sm', color: '#111111', align: 'end', flex: 2 },
    ],
  }));
  const total = p.items.reduce((s, i) => s + i.qty * i.price, 0);
  const foot = [];
  if (cust) foot.push(`✔ 已對到客戶主檔：${cust['客戶簡稱']}`); else foot.push('⚠ 客戶主檔沒對到，請在 Ragic 補客戶編號');
  if (nPhoto) foot.push(`📷 已附 ${nPhoto} 張照片`);
  foot.push('進度：✎草稿，請行政核價後改「✉︎已報」');
  return {
    type: 'flex',
    altText: `報價單草稿 ${created.caseNo} ${p.customer} ${money(total)}`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#1e3a8a', contents: [
        { type: 'text', text: `報價單草稿 ${created.caseNo}`, color: '#ffffff', weight: 'bold', size: 'md' },
        { type: 'text', text: p.customer || '（未填客戶）', color: '#bfdbfe', size: 'sm' },
      ] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        ...rows,
        { type: 'separator', margin: 'md' },
        { type: 'box', layout: 'horizontal', margin: 'md', contents: [
          { type: 'text', text: '未稅合計', weight: 'bold', size: 'sm', flex: 5 },
          { type: 'text', text: money(total), weight: 'bold', size: 'sm', align: 'end', flex: 2 },
        ] },
        { type: 'text', text: foot.join('\n'), size: 'xs', color: '#6b7280', wrap: true, margin: 'md' },
      ] },
      footer: { type: 'box', layout: 'vertical', contents: [
        { type: 'button', style: 'primary', color: '#1e3a8a', action: { type: 'uri', label: '在 Ragic 開啟修改', uri: created.url } },
      ] },
    },
  };
}

function searchFlex(kw, rows) {
  const bubbles = rows.map(r => ({
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
      { type: 'text', text: `${r['案件編號'] || r.rid}  ${r['進度欄'] || ''}`, weight: 'bold', size: 'sm' },
      { type: 'text', text: `${r['客戶名稱'] || ''}`, size: 'sm', wrap: true },
      { type: 'text', text: `${r['產品簡要'] || ''}`, size: 'xs', color: '#6b7280', wrap: true },
      { type: 'text', text: `${r['報價日期'] || ''}  未稅 ${money(r['現金未稅總計'])}`, size: 'xs', color: '#374151' },
    ] },
    footer: { type: 'box', layout: 'vertical', contents: [
      { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '開啟報價單', uri: `${SHEET_QUOTE}/${r.rid}` } },
    ] },
  }));
  return { type: 'flex', altText: `找到 ${rows.length} 筆「${kw}」報價單`, contents: { type: 'carousel', contents: bubbles } };
}

// ───────────────────────────── Ragic HTTP（server-side：Authorization header） ─────────────────────────────
async function ragicGet(url) {
  const r = await fetch(url, { headers: { Authorization: 'Basic ' + ragicKey() } });
  if (r.status === 429) throw new Error('Ragic 429 限流，稍後再試');
  if (!r.ok) throw new Error(`Ragic GET ${r.status}`);
  return r.json();
}
async function ragicPost(url, fd) {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Basic ' + ragicKey() }, body: fd }); // 不要自設 Content-Type
  if (r.status === 429) throw new Error('Ragic 429 限流，稍後再試');
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { throw new Error(`Ragic POST ${r.status}: ${t.slice(0, 120)}`); }
}

// ───────────────────────────── LINE HTTP（不依賴 SDK 版本） ─────────────────────────────
function lineApi(path, payload, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.line.me', path, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => (res.statusCode < 300 ? resolve(d) : reject(new Error(`LINE ${res.statusCode}: ${d.slice(0, 200)}`))));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
async function lineReply(replyToken, messages, token) {
  try { await lineApi('/v2/bot/message/reply', { replyToken, messages }, token); }
  catch (e) { console.error('[quote] reply fail', e.message); }
}
async function linePush(to, messages, token) {
  await lineApi('/v2/bot/message/push', { to, messages }, token);
}
function lineDownload(messageId, token) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'api-data.line.me', path: `/v2/bot/message/${messageId}/content`, headers: { Authorization: `Bearer ${token}` } }, res => {
      if (res.statusCode !== 200) return reject(new Error(`LINE content ${res.statusCode}`));
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

module.exports = { handleEvent, remindDrafts, parseQuoteText, lookupCustomer, createQuote, buildQuoteForm, searchQuotes, quoteFlex, searchFlex, F };
