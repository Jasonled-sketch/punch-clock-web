// 宮廟雲 — 四方案架構原型
// 入門：單機（localStorage）。標準以上：store 換成雲端 API 即可，畫面與流程不變。

const TIERS = {
  basic:    { rank: 0, name: '入門', price: 9800,  tag: '單機・不需網路', desc: '油香系統、自動列印收據、查詢補印、加密備份。沒有網路也能用，我們提供主機。' },
  standard: { rank: 1, name: '標準', price: 29800, tag: '雲端・手機 PWA・半自動', desc: '雲端信眾管理（CRM）、手機也能登記查詢、手動推播簡訊、字幕機按鈕播報。' },
  deluxe:   { rank: 2, name: '豪華', price: 49800, tag: '雲端・LINE 機器人・全自動', desc: '標準全部功能，加上 LINE 機器人、陣頭廠商專區、全自動推播與字幕機、財務分析、法會與慶典。', hot: true },
  flagship: { rank: 3, name: '旗艦', price: 98000, tag: '雲端・全通路', desc: '豪華全部功能，加上官網建置、FB 同步、LINE Pay 線上點燈、AI 客服、建醮。' },
};
const YEARLY = { basic: 0, standard: 3600, deluxe: 6000, flagship: 12000 };

const MODULES = [
  { id: 'home',     name: '首頁',           tier: 'basic' },
  { id: 'donate',   name: '油香登記',       tier: 'basic' },
  { id: 'search',   name: '查詢・補印',     tier: 'basic' },
  { id: 'crm',      name: '信眾管理',       tier: 'standard' },
  { id: 'sms',      name: '簡訊推播',       tier: 'standard' },
  { id: 'led',      name: '字幕機播報',     tier: 'standard' },
  { id: 'auto',     name: '全自動設定',     tier: 'deluxe' },
  { id: 'finance',  name: '財務分析',       tier: 'deluxe' },
  { id: 'linebot',  name: 'LINE 機器人',    tier: 'deluxe' },
  { id: 'online',   name: '官網・FB・金流', tier: 'flagship' },
  { id: 'fahui',    name: '法會',           tier: 'deluxe' },
  { id: 'festival', name: '慶典',           tier: 'deluxe' },
  { id: 'jiao',     name: '建醮',           tier: 'flagship' },
  { id: 'troupe',   name: '陣頭・廠商專區', tier: 'deluxe' },
  { id: 'poster',   name: '海報・帆布輸出', tier: 'basic' },
  { id: 'backup',   name: '備份・還原',     tier: 'basic' },
  { id: 'audit',    name: '操作紀錄',       tier: 'basic' },
  { id: 'charter',  name: '章程・管理辦法', tier: 'basic' },
  { id: 'plans',    name: '方案比較',       tier: 'basic' },
  { id: 'settings', name: '宮廟設定',       tier: 'basic' },
];

const ITEMS = { '添油香': 0, '光明燈': 600, '太歲燈': 600, '文昌燈': 600, '財神燈': 1000, '普渡': 1200, '捐贈物資': 0 };

// ---------- store ----------
const KEY = 'temple-cloud-v1';
let S;
function load() {
  try { S = JSON.parse(localStorage.getItem(KEY)); } catch (e) { S = null; }
  if (!S) S = seed();
  if (!S.v2) { // 舊資料升級：活動加上類別，補法會、慶典範例
    S.events.forEach(e => e.kind = e.kind || 'jiao');
    const id = Math.max(0, ...S.events.map(e => e.id));
    seedEvents().filter(e => e.kind !== 'jiao').forEach((e, i) => S.events.push(Object.assign(e, { id: id + i + 1 })));
    S.v2 = true; save();
  }
}
let saveTimer;
function save() {
  if (SRV.on) { clearTimeout(saveTimer); saveTimer = setTimeout(pushState, 400); return; }
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
}

// 空白廟（本機伺服器第一次啟用）
function blankState(name) {
  return { v2: true, tier: 'basic', records: [], led: [], sms: [],
    temple: { name: name || '本宮', type: '宮', org: 'committee', deity: '', address: '', phone: '', head: '', charter: {} },
    rules: { autoLed: true, autoRemind: true, autoReport: true, autoBirthday: false, autoSync: false },
    online: { web: false, fb: false, pay: false, ai: false }, events: [], troupes: [] };
}

function seed() {
  const names = ['王小明', '李淑芬', '陳志豪', '林美玲', '黃建國', '張雅婷', '吳俊傑', '劉秀英', '蔡宗翰', '楊惠君', '許家豪', '鄭麗華', '謝文雄', '洪佩珊', '郭明德', '邱玉梅', '曾國華', '廖美惠', '賴俊宏', '周淑貞'];
  const areas = ['溪湖鎮', '埔鹽鄉', '員林市', '埔心鄉', '福興鄉'];
  const recs = [];
  let seq = 0;
  const now = new Date();
  for (let back = 20; back >= 0; back--) {
    const d0 = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const n = d0.getMonth() === 0 ? 14 : d0.getMonth() === 7 ? 10 : 5;
    for (let k = 0; k < n; k++) {
      const i = (seq * 7 + k * 3) % names.length;
      const item = d0.getMonth() === 0 ? (k % 2 ? '太歲燈' : '光明燈') : d0.getMonth() === 7 ? '普渡' : ['添油香', '文昌燈', '財神燈', '添油香', '捐贈物資'][k % 5];
      const day = Math.min(28, 1 + k * 3);
      const d = new Date(d0.getFullYear(), d0.getMonth(), day, 9 + k % 8);
      if (d > now) continue;
      const qty = item.endsWith('燈') ? 1 + (i % 3) : 1;
      const amount = ITEMS[item] ? ITEMS[item] * qty : [300, 500, 1000, 2000, 600][(i + k) % 5];
      recs.push(mkRecord({ date: d.toISOString(), name: names[i], phone: '09' + String(12345678 + i * 1111).slice(0, 8),
        addr: '彰化縣' + areas[i % 5], item, qty, amount, show: i % 9 !== 0, note: '' }, ++seq));
    }
  }
  return {
    temple: { memberId: '1234', name: '溪湖福安宮', type: '宮', org: 'committee', deity: '天上聖母', address: '彰化縣溪湖鎮○○路 100 號', phone: '04-8800000', head: '陳○○', charter: {} },
    v2: true, tier: 'flagship', records: recs, led: [], sms: [],
    rules: { autoLed: true, autoRemind: true, autoReport: true, autoBirthday: false, autoSync: false },
    online: { web: false, fb: false, pay: false, ai: false },
    events: seedEvents(),
    troupes: [
      { name: '溪湖八家將', type: '家將', contact: '黃○○', phone: '0912-000111', date: '2026-10-12' },
      { name: '埔鹽龍鳳獅', type: '舞龍舞獅', contact: '張○○', phone: '0922-000222', date: '2026-11-20' }],
  };
}

function seedEvents() {
  return [
    { id: 1, kind: 'jiao', name: '丙午年祈安建醮', date: '2026-11-20', roles: [
      { role: '主醮首', name: '王小明', amount: 360000 }, { role: '主會首', name: '李淑芬', amount: 168000 },
      { role: '福德正神斗首', name: '陳志豪', amount: 36000 }, { role: '平安斗首', name: '林美玲', amount: 8800 }] },
    { id: 2, kind: 'fahui', name: '中元普度超度法會', date: '2026-08-27', roles: [
      { role: '超度祖先', name: '王府歷代祖先', amount: 1200 }, { role: '超度祖先', name: '黃府歷代祖先', amount: 1200 },
      { role: '冤親債主', name: '張雅婷', amount: 1000 }, { role: '消災祈福', name: '吳俊傑', amount: 600 },
      { role: '超度嬰靈', name: '劉秀英', amount: 1500 }, { role: '功德主', name: '蔡宗翰', amount: 12000 }] },
    { id: 3, kind: 'festival', name: '天上聖母聖誕千秋', date: '2027-04-29', roles: [
      { role: '贊助金', name: '楊惠君', amount: 20000 }, { role: '贊助金', name: '許家豪', amount: 10000 },
      { role: '物資（壽麵 50 斤）', name: '鄭麗華', amount: 3000 }, { role: '遶境餐點', name: '謝文雄', amount: 15000 },
      { role: '贊助金', name: '洪佩珊', amount: 6000 }, { role: '贊助金', name: '郭明德', amount: 3600 }] },
  ];
}

const EVENT_KINDS = {
  fahui:    { name: '法會', role: '登記項目', roles: ['超度祖先', '冤親債主', '超度嬰靈', '消災祈福', '功德主', '禮斗'], sample: '例：梁皇寶懺法會' },
  festival: { name: '慶典', role: '贊助項目', roles: ['贊助金', '物資', '遶境餐點', '陣頭', '香燭金紙'], sample: '例：玄天上帝聖誕千秋' },
  jiao:     { name: '建醮', role: '職稱／斗首', roles: ['主醮首', '主會首', '主壇首', '斗首', '燈首'], sample: '例：丙午年祈安建醮' },
};

function mkRecord(r, seq) {
  const d = new Date(r.date);
  const no = `${d.getFullYear() - 1911}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${String(seq).padStart(4, '0')}`;
  return Object.assign({ id: seq, no, void: false }, r);
}

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n || 0).toLocaleString('zh-TW');
const roc = iso => { const d = new Date(iso); return `${d.getFullYear() - 1911}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; };
const mask = n => !n ? '' : n.length <= 2 ? n[0] + '○' : n[0] + '○' + n.slice(2);
const has = t => TIERS[S.tier].rank >= TIERS[t].rank;
const live = () => S.records.filter(r => !r.void);
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); }

// ---------- shell ----------
let current = 'home';
try { current = localStorage.getItem(KEY + ':tab') || 'home'; } catch (e) {}

function renderShell() {
  const t = S.temple;
  $('#tname').textContent = t.name;
  $('#tbadge').textContent = `${t.type}・${ORG_TYPES[t.org].name}`;
  $('#tier').value = S.tier;
  $('#nav').innerHTML = MODULES.map(m => {
    const lock = !has(m.tier);
    return `<button class="nav-i${m.id === current ? ' on' : ''}" data-go="${m.id}">${m.name}${lock ? `<span class="lk">${TIERS[m.tier].name}</span>` : ''}</button>`;
  }).join('');
  go(current);
}

function go(id) {
  current = id;
  try { localStorage.setItem(KEY + ':tab', id); } catch (e) {}
  document.querySelectorAll('.nav-i').forEach(b => b.classList.toggle('on', b.dataset.go === id));
  const m = MODULES.find(x => x.id === id);
  const main = $('#main');
  if (!has(m.tier)) { main.innerHTML = locked(m); return; }
  main.innerHTML = VIEWS[id]();
  if (AFTER[id]) AFTER[id]();
}

function locked(m) {
  const t = TIERS[m.tier];
  return `<div class="locked"><h2>${m.name}</h2>
    <p>這個功能屬於<b>${t.name}方案</b>（${t.tag}）。</p><p class="muted">${t.desc}</p>
    <button class="btn pri" data-tier="${m.tier}">切換到${t.name}方案看看</button></div>`;
}

// ---------- views ----------
const VIEWS = {};
const AFTER = {};

VIEWS.home = () => {
  const now = new Date(), ym = now.getFullYear() * 12 + now.getMonth();
  const rs = live();
  const month = rs.filter(r => { const d = new Date(r.date); return d.getFullYear() * 12 + d.getMonth() === ym; });
  const last = rs.filter(r => { const d = new Date(r.date); return d.getFullYear() * 12 + d.getMonth() === ym - 12; });
  const sum = a => a.reduce((s, r) => s + Number(r.amount), 0);
  const lamps = a => a.filter(r => r.item.endsWith('燈')).length;
  const diff = sum(last) ? Math.round((sum(month) / sum(last) - 1) * 100) : 0;
  const t = TIERS[S.tier];
  return `<h2>今日廟務</h2>
  <div class="tiles">
    <div class="tile"><span class="k">本月收入</span><span class="v">${money(sum(month))}<small>元</small></span><span class="chip ${diff >= 0 ? 'up' : 'dn'}">${diff >= 0 ? '▲' : '▼'} ${Math.abs(diff)}% 較去年同月</span></div>
    <div class="tile"><span class="k">本月點燈</span><span class="v">${lamps(month)}<small>筆</small></span></div>
    <div class="tile"><span class="k">本月登記</span><span class="v">${month.length}<small>筆</small></span></div>
    <div class="tile"><span class="k">信眾人數</span><span class="v">${new Set(rs.map(r => r.phone)).size}<small>人</small></span></div>
  </div>
  <div class="card"><h3>目前方案：${t.name}（${t.tag}）</h3><p>${t.desc}</p>
    <div class="flow">${flowFor(S.tier)}</div></div>
  <div class="row2">
    <div class="card"><h3>最近登記</h3>${recTable(rs.slice(-6).reverse(), false)}</div>
    <div class="card"><h3>快速動作</h3><div class="stack">
      <button class="btn pri" data-go="donate">＋ 新增油香登記</button>
      <button class="btn" data-go="search">查詢・補印收據</button>
      <button class="btn" data-go="charter">產生章程</button></div></div>
  </div>`;
};

function flowFor(tier) {
  const steps = {
    basic: ['櫃台登記', '列印收據', '本機存檔'],
    standard: ['櫃台登記', '列印收據', '雲端 CRM', '人工按鈕推字幕機・發簡訊'],
    deluxe: ['櫃台登記', '列印收據', '雲端 CRM', '自動上字幕機', '自動簡訊・月報'],
    flagship: ['櫃台／LINE／官網登記', '列印收據', '雲端 CRM', '自動上字幕機', '自動簡訊・月報', '同步 FB・官網'],
  }[tier];
  return steps.map(s => `<span>${s}</span>`).join('<i>→</i>');
}

VIEWS.donate = () => `<h2>油香登記</h2>
  <form id="fdon" class="card form" autocomplete="off">
    <label>信眾姓名<input id="d-name" required placeholder="例：王小明"></label>
    <label>手機<input id="d-phone" inputmode="tel" placeholder="0912345678"></label>
    <label class="w2">地址<input id="d-addr" placeholder="彰化縣溪湖鎮…"></label>
    <label>項目<select id="d-item">${Object.keys(ITEMS).map(k => `<option>${k}</option>`).join('')}</select></label>
    <label>數量<input id="d-qty" type="number" min="1" value="1"></label>
    <label>金額（元）<input id="d-amt" type="number" min="0" required></label>
    <label class="chk"><input id="d-show" type="checkbox" checked> 同意公開姓名（字幕機・功德榜）</label>
    <label class="w2">備註<input id="d-note" placeholder="例：闔家平安"></label>
    <details class="w2"><summary>補登手寫收據（系統故障時開的單）</summary><div class="form" style="margin-top:8px">
      <label>手寫收據編號<input id="d-man" placeholder="H0001"></label><label>手寫日期<input id="d-mdate" type="date"></label></div></details>
    <div class="w2 act"><button class="btn pri" type="submit">確定並列印收據</button>
      <span class="muted">${has('deluxe') && S.rules.autoLed ? '全自動：確定後會自動送上字幕機。' : has('standard') ? '半自動：確定後可按按鈕推上字幕機。' : '入門：收據列印並存在本機。'}</span></div>
  </form>
  <div id="after"></div>`;

AFTER.donate = () => {
  const f = $('#fdon'), item = $('#d-item'), qty = $('#d-qty'), amt = $('#d-amt');
  const price = () => { const p = ITEMS[item.value]; if (p) amt.value = p * (Number(qty.value) || 1); };
  item.onchange = price; qty.oninput = price; price();
  $('#d-phone').onblur = () => {
    const r = [...S.records].reverse().find(x => x.phone && x.phone === $('#d-phone').value.trim());
    if (r) { if (!$('#d-name').value) $('#d-name').value = r.name; if (!$('#d-addr').value) $('#d-addr').value = r.addr; toast('已帶入舊信眾資料：' + r.name); }
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const man = $('#d-man').value.trim(), mdate = $('#d-mdate').value;
    const input = { date: man && mdate ? new Date(mdate + 'T12:00:00').toISOString() : new Date().toISOString(), name: $('#d-name').value.trim(), phone: $('#d-phone').value.trim(),
      addr: $('#d-addr').value.trim(), item: item.value, qty: Number(qty.value) || 1, amount: Number(amt.value) || 0,
      show: $('#d-show').checked, note: $('#d-note').value.trim(), manualNo: man || undefined };
    let r;
    if (SRV.on) {
      try { r = (await api('POST', '/api/records', { record: input })).record; } catch (err) { toast(err.message); return; }
    } else {
      if (man && S.records.some(x => x.manualNo === man)) { toast(`手寫收據 ${man} 已補登過`); return; }
      r = mkRecord(input, S.records.length + 1);
    }
    S.records.push(r);
    let ledMsg = '';
    if (has('deluxe') && S.rules.autoLed && r.show) { pushLed(r); ledMsg = '已自動送上字幕機。'; }
    save();
    printReceipt(r);
    $('#after').innerHTML = `<div class="card ok"><b>已登記 收據 ${r.no}</b>${r.manualNo ? `（補登手寫 ${esc(r.manualNo)}）` : ''}　${esc(r.name)}・${r.item}・${money(r.amount)} 元　${ledMsg}
      <div class="act">${has('standard') && !ledMsg && r.show ? `<button class="btn" data-led="${r.id}">推上字幕機</button>` : ''}
      <button class="btn" data-print="${r.id}">再印一次</button></div></div>`;
    f.reset(); price();
  };
};

function ledText(r) { return `感謝 ${mask(r.name)} 大德 ${r.item} ${money(r.amount)} 元　${S.temple.deity}保佑 闔家平安`; }
function pushLed(r) { S.led.unshift({ text: ledText(r), time: new Date().toISOString(), status: '已送出' }); S.led = S.led.slice(0, 50); }

VIEWS.search = () => `<h2>查詢・補印</h2>
  <div class="card form">
    <label class="w2">關鍵字<input id="q" placeholder="姓名、電話、收據編號"></label>
    <label>項目<select id="qi"><option value="">全部</option>${Object.keys(ITEMS).map(k => `<option>${k}</option>`).join('')}</select></label>
    <label>年份（民國）<select id="qy"><option value="">全部</option>${[...new Set(S.records.map(r => new Date(r.date).getFullYear() - 1911))].sort((a, b) => b - a).map(y => `<option>${y}</option>`).join('')}</select></label>
  </div><div id="res" class="card"></div>`;
AFTER.search = () => {
  const run = () => {
    const q = $('#q').value.trim(), i = $('#qi').value, y = $('#qy').value;
    const list = S.records.filter(r => (!q || r.name.includes(q) || (r.phone || '').includes(q) || r.no.includes(q))
      && (!i || r.item === i) && (!y || new Date(r.date).getFullYear() - 1911 == y)).reverse();
    $('#res').innerHTML = `<p class="muted">共 ${list.length} 筆，合計 ${money(list.filter(r => !r.void).reduce((s, r) => s + r.amount, 0))} 元</p>` + recTable(list.slice(0, 200), true);
  };
  ['#q', '#qi', '#qy'].forEach(s => $(s).oninput = run); run();
};

function recTable(list, actions) {
  if (!list.length) return '<p class="muted">沒有資料。</p>';
  return `<div class="tbl"><table><thead><tr><th>收據</th><th>日期</th><th>姓名</th><th>項目</th><th class="n">金額</th>${actions ? '<th></th>' : ''}</tr></thead><tbody>
  ${list.map(r => `<tr class="${r.void ? 'void' : ''}"><td>${r.no}</td><td>${roc(r.date)}</td><td>${esc(r.name)}</td><td>${r.item}${r.qty > 1 ? '×' + r.qty : ''}</td><td class="n">${money(r.amount)}</td>
  ${actions ? `<td class="act">${r.void ? '已作廢' : `<button class="btn sm" data-print="${r.id}">補印</button><button class="btn sm" data-void="${r.id}">作廢</button>`}</td>` : ''}</tr>`).join('')}
  </tbody></table></div>`;
}

function devotees() {
  const map = new Map();
  for (const r of live()) {
    const k = r.phone || r.name;
    const d = map.get(k) || { name: r.name, phone: r.phone, addr: r.addr, total: 0, count: 0, years: new Set(), items: new Set(), last: r.date };
    d.total += r.amount; d.count++; d.years.add(new Date(r.date).getFullYear()); d.items.add(r.item);
    if (r.date > d.last) { d.last = r.date; d.name = r.name; d.addr = r.addr; }
    map.set(k, d);
  }
  const y = new Date().getFullYear();
  return [...map.values()].map(d => Object.assign(d, { lapsed: d.years.has(y - 1) && !d.years.has(y) })).sort((a, b) => b.total - a.total);
}

VIEWS.crm = () => {
  const ds = devotees();
  const lapsed = ds.filter(d => d.lapsed).length;
  return `<h2>信眾管理（雲端 CRM）</h2>
  <div class="tiles"><div class="tile"><span class="k">信眾</span><span class="v">${ds.length}<small>人</small></span></div>
  <div class="tile"><span class="k">待回流</span><span class="v">${lapsed}<small>人</small></span><span class="chip dn">去年有、今年還沒來</span></div></div>
  <div class="card"><div class="tbl"><table><thead><tr><th>姓名</th><th>手機</th><th>地址</th><th class="n">累計</th><th class="n">次數</th><th>項目</th><th>狀態</th></tr></thead><tbody>
  ${ds.map(d => `<tr><td>${esc(d.name)}</td><td>${esc(d.phone)}</td><td>${esc(d.addr)}</td><td class="n">${money(d.total)}</td><td class="n">${d.count}</td><td>${[...d.items].join('、')}</td><td>${d.lapsed ? '<span class="chip dn">待回流</span>' : '<span class="chip up">活躍</span>'}</td></tr>`).join('')}
  </tbody></table></div></div>`;
};

VIEWS.sms = () => {
  const auto = has('deluxe');
  return `<h2>簡訊推播</h2>
  <p class="muted">${auto ? '豪華以上：可在「全自動設定」開啟排程，這裡仍可手動加發。' : '標準方案：挑名單、寫內容、按下發送（半自動）。'}</p>
  <div class="card form">
    <label>名單<select id="seg"><option value="lapsed">待回流信眾</option><option value="all">全部信眾</option><option value="lamp">今年點燈信眾</option></select></label>
    <label class="w2">內容<textarea id="msg" rows="3">【${esc(S.temple.name)}】${esc(S.temple.deity)}保佑！${new Date().getFullYear() - 1911 + 1}年光明燈、太歲燈開始登記，歡迎回宮點燈。電話 ${esc(S.temple.phone)}</textarea></label>
    <div class="w2 act"><span id="cnt" class="muted"></span><button class="btn pri" id="send">發送</button><button class="btn" id="copy">複製電話清單</button></div>
  </div>
  <div class="card"><h3>發送紀錄</h3>${S.sms.length ? `<ul class="log">${S.sms.map(s => `<li>${roc(s.time)}　${s.segment}　${s.count} 則　<span class="muted">${esc(s.text.slice(0, 30))}…</span></li>`).join('')}</ul>` : '<p class="muted">尚未發送。</p>'}</div>`;
};
AFTER.sms = () => {
  const y = new Date().getFullYear();
  const pick = () => {
    const ds = devotees().filter(d => d.phone);
    const v = $('#seg').value;
    return v === 'lapsed' ? ds.filter(d => d.lapsed) : v === 'lamp' ? ds.filter(d => d.years.has(y) && [...d.items].some(i => i.endsWith('燈'))) : ds;
  };
  const upd = () => { const n = pick().length, len = $('#msg').value.length; $('#cnt').textContent = `${n} 人・每則 ${len} 字（${len > 70 ? '長簡訊' : '一般簡訊'}）`; };
  $('#seg').onchange = upd; $('#msg').oninput = upd; upd();
  $('#send').onclick = () => {
    const list = pick();
    S.sms.unshift({ time: new Date().toISOString(), segment: $('#seg').selectedOptions[0].text, count: list.length, text: $('#msg').value });
    save(); toast(`已排入簡訊閘道：${list.length} 則（原型不會真的發送）`); go('sms');
  };
  $('#copy').onclick = () => {
    const txt = pick().map(d => d.phone).join('\n');
    navigator.clipboard.writeText(txt).then(() => toast('已複製')).catch(() => toast('無法複製，請改用匯出'));
  };
};

VIEWS.led = () => `<h2>字幕機播報</h2>
  <div class="led" aria-live="polite"><div class="led-in" id="ledrun">${esc(S.led[0] ? S.led[0].text : `歡迎蒞臨 ${S.temple.name}　${S.temple.deity}保佑 闔家平安`)}</div></div>
  <div class="row2">
    <div class="card"><h3>待播佇列</h3>${S.led.length ? `<ul class="log">${S.led.slice(0, 12).map(l => `<li>${roc(l.time)}　${esc(l.text)}</li>`).join('')}</ul>` : '<p class="muted">還沒有播報。登記油香後按「推上字幕機」。</p>'}
      <div class="act"><button class="btn" id="ledtest">送測試字</button></div></div>
    <div class="card"><h3>控制卡連線</h3>
      <div class="form">
        <label>控制卡<select id="ctype"><option>灰度 HDPlayer 全彩（A/C/D 系列）</option><option>灰度 HD2020 單雙色</option><option>C-Power（A30）</option><option>電視牆（網頁播放）</option></select></label>
        <label>連線方式<select><option>控制卡主動連回雲端</option><option>廟內樹莓派中繼</option></select></label>
      </div>
      <p class="muted">狀態：<span class="chip dn">未連線（原型）</span>。接上雲端閘道後，佇列會即時送到控制卡。姓名一律遮一字，不公開者不播。</p></div>
  </div>`;
AFTER.led = () => {
  $('#ledtest').onclick = () => { S.led.unshift({ text: `測試：${S.temple.name} 字幕機連線測試`, time: new Date().toISOString(), status: '已送出' }); save(); go('led'); };
};

VIEWS.auto = () => {
  const R = [
    ['autoLed', '登記後自動送上字幕機', '不用按按鈕，確定收據的同時就上字幕機。'],
    ['autoRemind', '每年 11 月自動提醒待回流信眾', '去年有點燈、今年還沒來的，自動發簡訊。'],
    ['autoReport', '每月 1 日自動寄香火月報', '用 LINE 送給主委或管理人。'],
    ['autoBirthday', '信眾生日自動祝福簡訊', '需有生日資料。'],
  ];
  if (has('flagship')) R.push(['autoSync', '登記資料自動同步官網功德榜與 FB', '旗艦方案。']);
  return `<h2>全自動設定</h2><div class="card">${R.map(([k, t, d]) => `<label class="switch"><input type="checkbox" data-rule="${k}" ${S.rules[k] ? 'checked' : ''}><span><b>${t}</b><br><small class="muted">${d}</small></span></label>`).join('')}</div>`;
};

VIEWS.finance = () => {
  const rs = live(), y = new Date().getFullYear();
  const by = (yr) => { const o = {}; rs.filter(r => new Date(r.date).getFullYear() === yr).forEach(r => o[r.item] = (o[r.item] || 0) + r.amount); return o; };
  const a = by(y), b = by(y - 1);
  const items = Object.keys(ITEMS).filter(k => a[k] || b[k]);
  const max = Math.max(1, ...items.map(k => Math.max(a[k] || 0, b[k] || 0)));
  const months = Array.from({ length: 12 }, (_, m) => rs.filter(r => { const d = new Date(r.date); return d.getFullYear() === y && d.getMonth() === m; }).reduce((s, r) => s + r.amount, 0));
  const mm = Math.max(1, ...months);
  const tot = o => Object.values(o).reduce((s, v) => s + v, 0);
  return `<h2>財務分析</h2>
  <div class="tiles"><div class="tile"><span class="k">${y - 1911} 年累計</span><span class="v">${money(tot(a))}<small>元</small></span></div>
  <div class="tile"><span class="k">${y - 1912} 年全年</span><span class="v">${money(tot(b))}<small>元</small></span></div></div>
  <div class="card"><h3>各項收入：今年 vs 去年</h3><div class="legend"><span><i class="s1"></i>${y - 1911} 年</span><span><i class="s2"></i>${y - 1912} 年</span></div>
  ${items.map(k => `<div class="bar"><span class="bl">${k}</span><div class="bt"><div class="b s1" style="width:${(a[k] || 0) / max * 100}%" title="${y - 1911} 年 ${money(a[k] || 0)} 元"></div><em>${money(a[k] || 0)}</em>
  <div class="b s2" style="width:${(b[k] || 0) / max * 100}%" title="${y - 1912} 年 ${money(b[k] || 0)} 元"></div><em>${money(b[k] || 0)}</em></div></div>`).join('')}</div>
  <div class="card"><h3>${y - 1911} 年每月收入</h3><div class="cols">${months.map((v, m) => `<div class="col" title="${m + 1} 月 ${money(v)} 元"><div class="cb" style="height:${v / mm * 100}%"></div><span>${m + 1}</span></div>`).join('')}</div></div>`;
};

VIEWS.online = () => {
  const t = S.temple, o = S.online;
  const row = (k, n, d) => `<label class="switch"><input type="checkbox" data-online="${k}" ${o[k] ? 'checked' : ''}><span><b>${n}</b><br><small class="muted">${d}</small></span></label>`;
  return `<h2>官網・FB・金流</h2>
  <div class="row2"><div class="card">${row('web', '宮廟官網', '我們代建，活動、功德榜與系統同步。')}${row('fb', 'Facebook 粉絲專頁', '活動、法會、功德榜自動發文。')}${row('pay', 'LINE Pay 線上點燈', '信眾在 LINE 付款，自動入帳、開電子收據。')}${row('ai', 'AI 客服', 'LINE 上自動回答開放時間、點燈價格、法會日期。')}</div>
  <div class="card site"><div class="site-h">${esc(t.name)}</div><p>主祀 ${esc(t.deity)}｜${esc(t.address)}</p>
  <p><b>近期活動</b><br>${S.events.map(e => `${esc(e.name)}（${e.date}）`).join('<br>')}</p>
  <p><b>功德榜</b><br>${live().filter(r => r.show).slice(-5).reverse().map(r => `${mask(r.name)}　${r.item}`).join('<br>')}</p>
  <p class="muted">官網預覽（同步後自動更新）</p></div></div>`;
};

VIEWS.linebot = () => {
  const t = S.temple, r = [...live()].reverse().find(x => x.item.endsWith('燈')) || live()[0];
  const b = (who, txt) => `<div class="bub ${who}">${txt}</div>`;
  return `<h2>LINE 機器人</h2>
  <p class="muted">豪華方案起。信眾加入宮廟 LINE 官方帳號後，用手機號碼綁定一次，之後查詢都不用再打資料。</p>
  <div class="row2">
    <div class="card chat"><div class="chat-h">${esc(t.name)}</div>
      ${b('me', '查點燈')}
      ${b('bot', `${esc(mask(r.name))} 大德您好：<br>${new Date().getFullYear() - 1911} 年已登記「${r.item}」${r.qty > 1 ? '×' + r.qty : ''}，收據 ${r.no}。<br>${esc(t.deity)}保佑 闔家平安`)}
      ${b('me', '我要點明年光明燈')}
      ${b('bot', '已為您預約 1 盞光明燈，600 元。請到宮內櫃台付款，或回覆「付款」使用 LINE Pay（旗艦）。')}
      ${b('bot sys', `【主委日報】今日收入 ${money(live().filter(x => new Date(x.date).toDateString() === new Date().toDateString()).reduce((s, x) => s + x.amount, 0))} 元，${live().filter(x => new Date(x.date).toDateString() === new Date().toDateString()).length} 筆。`)}
    </div>
    <div class="card"><h3>功能</h3>
      <ul class="log"><li>信眾查點燈、查收據、查法會日期</li><li>線上預約點燈、法會登記（櫃台確認收款）</li><li>電子收據（省紙，也可再印紙本）</li><li>每日收入日報傳給主委、管理人</li><li>年底自動提醒續點（取代部分簡訊費）</li></ul>
      <p class="muted">訊息費：信眾先傳訊息、系統回覆是免費的；主動推播才會用到 LINE 官方帳號的月額度。系統預設走免費回覆，推播改成群組一則，盡量不花額度。</p></div>
  </div>`;
};

VIEWS.backup = () => SRV.on ? serverBackupView() : demoBackupView();
function demoBackupView() {
  let last = null; try { last = localStorage.getItem(KEY + ':lastBackup'); } catch (e) {}
  const online = navigator.onLine;
  return `<h2>備份・還原</h2>
  <div class="tiles">
    <div class="tile"><span class="k">上次備份</span><span class="v" style="font-size:18px">${last ? roc(last) + ' ' + new Date(last).toTimeString().slice(0, 5) : '尚未備份'}</span><span class="chip ${last && Date.now() - new Date(last) < 864e5 ? 'up' : 'dn'}">${last && Date.now() - new Date(last) < 864e5 ? '24 小時內' : '請立即備份'}</span></div>
    <div class="tile"><span class="k">網路</span><span class="v" style="font-size:18px">${online ? '有網路' : '沒有網路'}</span><span class="chip ${online ? 'up' : 'dn'}">${online ? '可加雲端加密備份' : '只備份到隨身碟'}</span></div>
    <div class="tile"><span class="k">資料筆數</span><span class="v">${S.records.length}<small>筆</small></span></div>
  </div>
  <div class="row2">
    <form class="card form" id="fbak"><h3 class="w2">建立加密備份</h3>
      <label class="w2">備份密碼（至少 8 碼）<input id="bk-pw" type="password" minlength="8" required autocomplete="new-password"></label>
      <p class="w2 muted">備份檔用 AES-256 加密，沒有密碼誰都打不開，包括我們公司。密碼請由主委與總幹事各自保管。</p>
      <div class="w2 act"><button class="btn pri">下載加密備份檔</button></div></form>
    <form class="card form" id="frst"><h3 class="w2">從備份還原（換機）</h3>
      <label class="w2">備份檔<input id="rs-file" type="file" accept=".tbak" required></label>
      <label class="w2">備份密碼<input id="rs-pw" type="password" required autocomplete="current-password"></label>
      <div class="w2 act"><button class="btn">還原</button><span class="muted" id="rs-msg"></span></div></form>
  </div>`;
};
AFTER.backup = () => {
  if (SRV.on) return serverBackupAfter();
  $('#fbak').onsubmit = async e => {
    e.preventDefault();
    try {
      const blob = await encryptBackup(JSON.stringify(S), $('#bk-pw').value);
      const t = new Date();
      downloadBlob(blob, `backup_${t.getFullYear() - 1911}${pad(t.getMonth() + 1)}${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}.tbak`);
      try { localStorage.setItem(KEY + ':lastBackup', t.toISOString()); } catch (e2) {}
      toast('已建立加密備份'); go('backup');
    } catch (err) { toast('備份失敗：' + err.message); }
  };
  $('#frst').onsubmit = async e => {
    e.preventDefault();
    const f = $('#rs-file').files[0];
    try {
      const data = JSON.parse(await decryptBackup(await f.arrayBuffer(), $('#rs-pw').value));
      if (!data.temple || !Array.isArray(data.records)) throw new Error('不是本系統的備份檔');
      S = data; save(); renderShell(); toast(`已還原：${S.temple.name}，${S.records.length} 筆`);
    } catch (err) { $('#rs-msg').textContent = err.name === 'OperationError' ? '密碼錯誤或檔案損毀' : err.message; }
  };
};

// 加密備份：PBKDF2(SHA-256, 310000 次) 衍生金鑰，AES-256-GCM 加密。檔頭 TBAK1 + salt(16) + iv(12) + 密文
async function deriveKey(pw, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptBackup(text, pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(pw, salt), new TextEncoder().encode(text));
  return new Blob([new TextEncoder().encode('TBAK1'), salt, iv, new Uint8Array(ct)], { type: 'application/octet-stream' });
}
async function decryptBackup(buf, pw) {
  const u = new Uint8Array(buf);
  if (new TextDecoder().decode(u.slice(0, 5)) !== 'TBAK1') throw new Error('不是本系統的備份檔');
  const salt = u.slice(5, 21), iv = u.slice(21, 33);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await deriveKey(pw, salt), u.slice(33));
  return new TextDecoder().decode(pt);
}

function eventView(kind) {
  const K = EVENT_KINDS[kind];
  const list = S.events.filter(e => e.kind === kind);
  return `<h2>${K.name}</h2>
  ${list.map(e => `<div class="card"><h3>${esc(e.name)}　<small class="muted">${e.date}</small></h3>
  <div class="tbl"><table><thead><tr><th>${K.role}</th><th>姓名</th><th class="n">金額（元）</th></tr></thead><tbody>
  ${e.roles.slice().sort((a, b) => b.amount - a.amount).map(r => `<tr><td>${esc(r.role)}</td><td>${esc(r.name)}</td><td class="n">${money(r.amount)}</td></tr>`).join('')}
  <tr><td><b>合計 ${e.roles.length} 筆</b></td><td></td><td class="n"><b>${money(e.roles.reduce((s, r) => s + r.amount, 0))}</b></td></tr></tbody></table></div>
  <form class="form" data-role="${e.id}"><label>${K.role}<input name="role" required list="rl-${kind}" placeholder="${K.roles[0]}"></label><label>姓名<input name="name" required></label><label>金額<input name="amount" type="number" min="0" required></label>
  <div class="act"><button class="btn pri">加入</button><button class="btn" type="button" data-poster="ev:${e.id}">一鍵輸出芳名錄海報</button></div></form></div>`).join('')}
  <datalist id="rl-${kind}">${K.roles.map(r => `<option value="${r}">`).join('')}</datalist>
  <form class="card form" data-newev="${kind}"><label class="w2">新增${K.name}<input name="name" required placeholder="${K.sample}"></label><label>日期<input name="date" type="date" required></label><div class="act"><button class="btn">建立</button></div></form>`;
}
VIEWS.fahui = () => eventView('fahui');
VIEWS.festival = () => eventView('festival');
VIEWS.jiao = () => eventView('jiao');

// ---------- 陣頭・廠商專區（豪華）----------
const VZ = { tab: 'vendors', type: '', region: '', cert: false, sort: 'rating' };
const ACCESS = { full: '完整開放', no_price: '已鎖定價格區間', blocked: '已停用專區' };
function vzAccess() { return S.vendorAccess || 'full'; }
function vzLog(action, detail) {
  S.vendorLog = [{ t: new Date().toISOString(), who: SRV.user || '櫃台', action, detail: detail || '' }].concat(S.vendorLog || []).slice(0, 100);
  save();
}
function stars(r) { const f = Math.round(r * 2) / 2; return '★'.repeat(Math.floor(f)) + (f % 1 ? '☆' : '') ; }

VIEWS.troupe = () => {
  const tabs = `<div class="tabs"><button class="btn${VZ.tab === 'vendors' ? ' pri' : ''}" data-vztab="vendors">廠商專區</button><button class="btn${VZ.tab === 'mine' ? ' pri' : ''}" data-vztab="mine">我的陣頭（${S.troupes.length}）</button><button class="btn${VZ.tab === 'log' ? ' pri' : ''}" data-vztab="log">查看紀錄</button></div>`;
  if (VZ.tab === 'mine') return `<h2>陣頭・廠商專區</h2>${tabs}<div class="card"><div class="tbl"><table><thead><tr><th>團名</th><th>類別</th><th>聯絡人</th><th>電話</th><th>出陣日</th><th>評價</th></tr></thead><tbody>
  ${S.troupes.map((t, i) => `<tr><td>${esc(t.name)}</td><td>${esc(t.type)}</td><td>${esc(t.contact || '')}</td><td>${esc(t.phone || '')}</td><td>${esc(t.date || '')}</td><td>${t.vendorId ? (t.myRating ? stars(t.myRating) : `<span class="rate" data-ti="${i}">${[1, 2, 3, 4, 5].map(n => `<button class="btn sm" data-rate="${n}">${n}★</button>`).join('')}</span>`) : '—'}</td></tr>`).join('')}</tbody></table></div>
  <form class="form" id="ftr"><label>團名<input name="name" required></label><label>類別<select name="type">${VENDOR_TYPES.map(t => `<option>${t}</option>`).join('')}<option>其他</option></select></label><label>聯絡人<input name="contact"></label><label>電話<input name="phone"></label><label>出陣日<input name="date" type="date"></label><div class="act"><button class="btn pri">自行新增陣頭</button></div></form></div>`;
  if (VZ.tab === 'log') return `<h2>陣頭・廠商專區</h2>${tabs}<div class="card"><p class="muted">專區的每次查看、截圖鍵、複製都會記錄，並同步回平台。</p>${(S.vendorLog || []).length ? `<div class="tbl"><table><thead><tr><th>時間</th><th>人員</th><th>動作</th><th>內容</th></tr></thead><tbody>${S.vendorLog.map(l => `<tr><td>${roc(l.t)} ${new Date(l.t).toTimeString().slice(0, 5)}</td><td>${esc(l.who)}</td><td>${esc(l.action)}</td><td>${esc(l.detail)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">尚無紀錄。</p>'}</div>`;

  const acc = vzAccess();
  if (acc === 'blocked') return `<h2>陣頭・廠商專區</h2>${tabs}<div class="locked"><h2>專區已停用</h2><p>平台偵測到本專區資料外流，已暫停您的使用權限。</p><p class="muted">請聯絡譽昇光電客服說明處理。</p></div>${platformDemo()}`;
  let list = SAMPLE_VENDORS.filter(v => (!VZ.type || v.type === VZ.type) && (!VZ.region || v.region === VZ.region) && (!VZ.cert || v.certified));
  list.sort((a, b) => VZ.sort === 'price' ? a.min - b.min : VZ.sort === 'reviews' ? b.reviews - a.reviews : b.rating - a.rating);
  const t = S.temple, id = t.memberId || '0000';
  return `<h2>陣頭・廠商專區</h2>${tabs}
  <div class="card form vz-filter">
    <label>類別<select id="vz-type"><option value="">全部</option>${VENDOR_TYPES.map(x => `<option ${x === VZ.type ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label>地區<select id="vz-region"><option value="">全部</option>${VENDOR_REGIONS.map(x => `<option ${x === VZ.region ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label>排序<select id="vz-sort"><option value="rating" ${VZ.sort === 'rating' ? 'selected' : ''}>評價最高</option><option value="reviews" ${VZ.sort === 'reviews' ? 'selected' : ''}>評價最多</option><option value="price" ${VZ.sort === 'price' ? 'selected' : ''}>價格由低到高</option></select></label>
    <label class="chk"><input type="checkbox" id="vz-cert" ${VZ.cert ? 'checked' : ''}> 只看譽昇認證</label>
  </div>
  ${acc === 'no_price' ? '<div class="card warnbox"><b>價格區間已暫停顯示。</b>平台偵測到本專區截圖外流，請聯絡譽昇光電客服恢復。</div>' : ''}
  <div class="vz" id="vz" data-mid="${esc(id)}">
    <div class="vz-wm" aria-hidden="true"></div>
    <div class="vz-grid">${list.map(v => `<div class="vcard">
      <div class="vh"><b>${esc(v.name)}</b>${v.certified ? '<span class="cert">譽昇認證</span>' : ''}</div>
      <div class="muted">${v.type}・${v.region}・${v.size}・創立 ${v.since}</div>
      <div class="vr"><span class="st">${stars(v.rating)}</span> ${v.rating.toFixed(1)}　<span class="muted">${v.reviews} 間宮廟評價</span></div>
      <div class="vp">${acc === 'full' ? `出陣價格區間 <b class="price">${money(v.min)}～${money(v.max)} 元</b>` : '<span class="muted">價格區間已鎖定</span>'}</div>
      ${v.note ? `<div class="muted">${esc(v.note)}</div>` : ''}
      <div class="act"><button class="btn sm" data-vadd="${v.id}">加入我的陣頭</button></div>
      <div class="vid">用戶 #${esc(id)}</div></div>`).join('') || '<p class="muted">沒有符合的陣頭。</p>'}</div>
  </div>
  <p class="muted">價格區間為各宮廟回報的實際成交行情，僅供豪華版用戶參考。本頁含用戶編號浮水印，截圖、翻拍外流可追查來源，並會停止價格區間顯示。</p>
  ${platformDemo()}`;
};

function platformDemo() {
  return `<details class="card"><summary>平台端操作示範（正式版只有譽昇後台看得到）</summary>
  <div class="form" style="margin-top:10px"><label>這間宮廟的專區權限<select id="vz-acc">${Object.entries(ACCESS).map(([k, v]) => `<option value="${k}" ${k === vzAccess() ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
  <label class="w2">貼上外流文字，查出是哪間宮廟<textarea id="vz-trace" rows="2" placeholder="把在網路上看到、從專區複製出去的文字貼在這裡"></textarea></label><p class="w2" id="vz-trace-out"></p></div></details>`;
}

function vzWatermark() {
  const box = $('#vz'); if (!box) return;
  const t = S.temple, d = new Date();
  const label = `${t.name} 用戶編號 ${t.memberId || '0000'} ${d.getFullYear() - 1911}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${SRV.user || ''}`;
  const apply = () => {
    let wm = box.querySelector('.vz-wm');
    if (!wm) { wm = document.createElement('div'); wm.className = 'vz-wm'; box.prepend(wm); }
    wm.setAttribute('style', `background-image:${watermarkCSS(label, t.memberId || '0000')} !important;display:block !important;opacity:1 !important`);
    box.querySelectorAll('.vcard').forEach(c => c.style.backgroundImage = watermarkCSS('#' + (t.memberId || '0000'), t.memberId || '0000').split(', ')[1]);
  };
  apply();
  // 有人用開發者工具刪掉浮水印 → 立刻補回並記錄
  if (vzWatermark.mo) vzWatermark.mo.disconnect();
  vzWatermark.mo = new MutationObserver(() => { const wm = box.querySelector('.vz-wm'); if (!wm || !/svg/.test(wm.getAttribute('style') || '')) { vzWatermark.mo.disconnect(); apply(); vzLog('浮水印被移除', '已自動補回'); vzWatermark.mo.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] }); } });
  vzWatermark.mo.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
}

AFTER.troupe = () => {
  document.querySelectorAll('[data-vztab]').forEach(b => b.onclick = () => { VZ.tab = b.dataset.vztab; go('troupe'); });
  if ($('#vz-acc')) $('#vz-acc').onchange = e => { S.vendorAccess = e.target.value; save(); go('troupe'); toast('權限已改為：' + ACCESS[e.target.value]); };
  if ($('#vz-trace')) $('#vz-trace').oninput = e => { const id = zwDecode(e.target.value); $('#vz-trace-out').innerHTML = id ? `<span class="chip dn">來源：用戶編號 ${esc(id)}</span>` : (e.target.value ? '這段文字沒有本平台的隱藏編號（可能是手打或翻拍）' : ''); };
  document.querySelectorAll('.rate [data-rate]').forEach(b => b.onclick = () => {
    const tr = S.troupes[b.closest('.rate').dataset.ti]; tr.myRating = Number(b.dataset.rate); save(); toast('感謝評價，平台審核後列入'); go('troupe');
  });
  if (!$('#vz')) return;
  vzLog('查看專區', [VZ.type, VZ.region].filter(Boolean).join('・') || '全部');
  vzWatermark();
  const re = () => go('troupe');
  $('#vz-type').onchange = e => { VZ.type = e.target.value; re(); };
  $('#vz-region').onchange = e => { VZ.region = e.target.value; re(); };
  $('#vz-sort').onchange = e => { VZ.sort = e.target.value; re(); };
  $('#vz-cert').onchange = e => { VZ.cert = e.target.checked; re(); };
  document.querySelectorAll('[data-vadd]').forEach(b => b.onclick = () => {
    const v = SAMPLE_VENDORS.find(x => x.id === b.dataset.vadd);
    S.troupes.push({ name: v.name, type: v.type, contact: '', phone: '', date: '', vendorId: v.id });
    vzLog('加入我的陣頭', v.name); save(); toast('已加入，請到「我的陣頭」填出陣日');
  });
};

// 專區防護：截圖鍵、切換視窗、複製
document.addEventListener('keyup', e => {
  if (e.key === 'PrintScreen' && $('#vz')) { $('#vz').classList.add('shield'); setTimeout(() => $('#vz') && $('#vz').classList.remove('shield'), 3000); vzLog('按下截圖鍵', ''); toast('專區內容受保護，截圖動作已記錄'); }
});
window.addEventListener('blur', () => { if ($('#vz')) $('#vz').classList.add('shield'); });
window.addEventListener('focus', () => { if ($('#vz')) $('#vz').classList.remove('shield'); });
document.addEventListener('copy', e => {
  const box = $('#vz'); const sel = String(window.getSelection() || '');
  if (!box || !sel || !box.contains(window.getSelection().anchorNode)) return;
  const id = S.temple.memberId || '0000';
  e.clipboardData.setData('text/plain', `${sel}\n— 資料來源：宮廟雲陣頭專區・用戶編號 ${id}・禁止轉傳${zwEncode(id)}`);
  e.preventDefault(); vzLog('複製專區文字', sel.slice(0, 20));
});

VIEWS.charter = () => {
  const t = S.temple, ty = TEMPLE_TYPES[t.type], org = ORG_TYPES[t.org], p = charterParams(t);
  const doc = buildCharter(t), rules = buildRules(t, S.tier);
  const numbered = (chs) => { let n = 0; return chs.map(c => `<h4>${c.title}</h4>${c.articles.map(a => `<p><b>第 ${++n} 條</b>　${esc(a)}</p>`).join('')}`).join(''); };
  const kind = t.org === 'clan' ? '規約' : '組織章程';
  return `<h2>章程・管理辦法</h2>
  <div class="card form">
    <label>宮廟類型<select id="c-type">${Object.keys(TEMPLE_TYPES).map(k => `<option value="${k}" ${k === t.type ? 'selected' : ''}>${k}：${TEMPLE_TYPES[k].desc}</option>`).join('')}</select></label>
    <label>組織型態<select id="c-org">${ty.orgs.map(k => `<option value="${k}" ${k === t.org ? 'selected' : ''}>${ORG_TYPES[k].name}</option>`).join('')}</select></label>
    ${org.hasCommittee && t.org !== 'clan' && t.org !== 'abbot' ? `<label>委員人數<input type="number" data-cp="members" value="${p.members}" min="3"></label><label>監察委員<input type="number" data-cp="supervisors" value="${p.supervisors}" min="1"></label>` : ''}
    <label>任期（年）<input type="number" data-cp="term" value="${p.term}" min="1" max="6"></label>
    <label>${p.member}年齡下限<input type="number" data-cp="age" value="${p.age}" min="18"></label>
    <p class="w2 muted">依據：${org.basis}。${t.org === 'manager' ? '沒有委員會的小廟、神壇適用，由管理人一人負責。' : ''}${t.org === 'clan' ? '祠堂多屬祭祀公業，適用祭祀公業條例，文件稱「規約」。' : ''}送件前請所在地民政單位確認。</p>
    <div class="w2 act"><button class="btn pri" data-printdoc="1">列印章程與管理辦法</button></div>
  </div>
  <div class="card doc" id="doc"><h3 class="doct">${esc(p.name)}${kind}</h3>${numbered(doc)}
  <h3 class="doct">${esc(rules[0].title)}</h3>${numbered(rules)}</div>`;
};
AFTER.charter = () => {
  $('#c-type').onchange = e => { S.temple.type = e.target.value; const o = TEMPLE_TYPES[S.temple.type].orgs; if (!o.includes(S.temple.org)) S.temple.org = o[0]; save(); renderShell(); };
  $('#c-org').onchange = e => { S.temple.org = e.target.value; save(); renderShell(); };
  document.querySelectorAll('[data-cp]').forEach(i => i.onchange = () => { S.temple.charter = S.temple.charter || {}; S.temple.charter[i.dataset.cp] = Number(i.value); save(); go('charter'); });
};

VIEWS.plans = () => {
  const rows = [
    ['部署方式', '單機（我們提供主機）', '雲端', '雲端', '雲端'],
    ['沒有網路也能用', '✔', '斷線暫存', '斷線暫存', '斷線暫存'],
    ['油香・點燈登記、自動列印收據、查詢補印', '✔', '✔', '✔', '✔'],
    ['章程・管理辦法套版', '✔', '✔', '✔', '✔'],
    ['芳名錄海報・帆布輸出', '油香名單', '油香名單', '＋法會・慶典', '＋建醮'],
    ['加密備份', '隨身碟（有網路可加雲端）', '雲端每日＋隨身碟', '雲端每日＋隨身碟', '雲端每日＋隨身碟'],
    ['雲端信眾管理（CRM）', '', '✔', '✔', '✔'],
    ['手機 PWA（登記・查詢）', '', '✔', '✔', '✔'],
    ['簡訊推播', '', '手動', '自動排程', '自動排程'],
    ['字幕機・電視牆播報', '加購（區網）', '按鈕推送', '登記即自動上', '登記即自動上'],
    ['LINE 機器人（查燈・預約・電子收據・主委日報）', '', '', '✔', '✔'],
    ['財務分析・香火月報自動寄送', '', '', '✔', '✔'],
    ['法會・慶典', '', '', '✔', '✔'],
    ['官網建置・FB 同步', '', '', '', '✔'],
    ['LINE Pay 線上點燈・AI 客服', '', '', '', '✔'],
    ['陣頭廠商專區（評價・價格區間・認證）', '', '', '✔', '✔'],
    ['建醮', '', '', '加購', '✔'],
  ];
  const keys = Object.keys(TIERS);
  return `<h2>方案比較</h2><div class="card"><div class="tbl"><table class="plans"><thead><tr><th></th>${keys.map(k => `<th class="${k === S.tier ? 'cur' : ''}">${TIERS[k].hot ? '<span class="hot">最多廟選擇</span><br>' : ''}${TIERS[k].name}<br><small>${TIERS[k].tag}</small></th>`).join('')}</tr></thead><tbody>
  <tr class="price"><td>買斷價（未稅）</td>${keys.map(k => `<td class="${k === S.tier ? 'cur' : ''}"><b>${money(TIERS[k].price)}</b> 元</td>`).join('')}</tr>
  <tr><td>雲端服務年費（第 2 年起）</td>${keys.map(k => `<td class="${k === S.tier ? 'cur' : ''}">${YEARLY[k] ? money(YEARLY[k]) + ' 元' : '免'}</td>`).join('')}</tr>
  ${rows.map(r => `<tr><td>${r[0]}</td>${r.slice(1).map((c, i) => `<td class="${keys[i] === S.tier ? 'cur' : ''}">${c || '—'}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div>
  <p class="muted">升級只補差價：已付金額全額抵扣，例如入門升豪華補 ${money(TIERS.deluxe.price - TIERS.basic.price)} 元。購買譽昇字幕機可再折抵。價格為草案。</p></div>`;
};

VIEWS.settings = () => {
  const t = S.temple;
  return `<h2>宮廟設定</h2><form class="card form" id="fset">
  <label>宮廟名稱<input name="name" value="${esc(t.name)}" required></label>
  <label>平台用戶編號<input value="${esc(t.memberId || '尚未開通')}" disabled></label>
  <label>主祀神明<input name="deity" value="${esc(t.deity)}"></label>
  <label class="w2">地址<input name="address" value="${esc(t.address)}"></label>
  <label>電話<input name="phone" value="${esc(t.phone)}"></label>
  <label>負責人<input name="head" value="${esc(t.head)}"></label>
  <div class="w2 act"><button class="btn pri">儲存</button>${SRV.on ? '' : '<button class="btn" type="button" id="reset">清除並重新載入範例資料</button>'}</div></form>
  ${SRV.on && SRV.rank >= 4 ? '<div class="card" id="users"></div>' : ''}`;
};
AFTER.settings = () => {
  $('#fset').onsubmit = e => { e.preventDefault(); const fd = new FormData(e.target); for (const [k, v] of fd) S.temple[k] = v; save(); renderShell(); toast('已儲存'); };
  usersPanel();
  if ($('#reset')) $('#reset').onclick = () => { if ($('#reset').dataset.ok) { S = seed(); save(); renderShell(); toast('已重設'); } else { $('#reset').dataset.ok = 1; $('#reset').textContent = '再按一次確認清除'; } };
};


// ---------- 海報・帆布 ----------
let posterSrc = null;
const PO = { size: 'b90', theme: 'red', layout: 'v', showAmount: true, item: '', dpi: 100, title: '' };
function posterSources() {
  const years = [...new Set(live().map(r => new Date(r.date).getFullYear()))].sort((a, b) => b - a);
  const src = years.map(y => ({ id: 'don:' + y, name: `油香・點燈 ${y - 1911} 年`, title: '功德芳名錄' }));
  S.events.filter(e => has(MODULES.find(m => m.id === e.kind).tier)).forEach(e => src.push({ id: 'ev:' + e.id, name: `${EVENT_KINDS[e.kind].name}：${e.name}`, title: e.kind === 'fahui' ? '法會功德芳名' : e.kind === 'jiao' ? '建醮芳名錄' : '慶典贊助芳名' }));
  return src;
}
function posterEntries(id) {
  if (id.startsWith('ev:')) {
    const e = S.events.find(x => x.id == id.slice(3));
    return e ? e.roles.slice().sort((a, b) => b.amount - a.amount) : [];
  }
  const y = Number(id.slice(4)), map = new Map();
  live().filter(r => r.show && new Date(r.date).getFullYear() === y && (!PO.item || r.item === PO.item))
    .forEach(r => map.set(r.name, (map.get(r.name) || 0) + r.amount));
  return [...map].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
}
function posterOpt(src) {
  const sz = POSTER_SIZES[PO.size], t = new Date();
  const ev = src.id.startsWith('ev:') ? S.events.find(x => x.id == src.id.slice(3)) : null;
  return { w: sz.w, h: sz.h, theme: PO.theme, layout: PO.layout, showAmount: PO.showAmount,
    title: PO.title || src.title,
    subtitle: ev ? `${S.temple.name}　${ev.name}` : `${S.temple.name}　${src.name.replace('油香・點燈 ', '')}${PO.item ? '　' + PO.item : ''}`,
    footer: `中華民國 ${t.getFullYear() - 1911} 年 ${t.getMonth() + 1} 月 ${t.getDate()} 日　${S.temple.name} 敬謝` };
}
VIEWS.poster = () => {
  const srcs = posterSources();
  if (!posterSrc || !srcs.find(s => s.id === posterSrc)) posterSrc = srcs[0] && srcs[0].id;
  const sel = (id, obj, cur) => `<select id="${id}">${Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v.name || v}</option>`).join('')}</select>`;
  return `<h2>海報・帆布輸出</h2>
  <p class="muted">選名單、選尺寸，一鍵產生芳名錄。SVG 是向量檔，可直接交給輸出中心印大圖帆布；PNG 給一般印表機或 LINE 分享。只列出同意公開姓名的信眾。</p>
  <div class="card form">
    <label class="w2">名單<select id="p-src">${srcs.map(s => `<option value="${s.id}" ${s.id === posterSrc ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <label>油香項目<select id="p-item" ${posterSrc && posterSrc.startsWith('ev:') ? 'disabled' : ''}><option value="">全部項目</option>${Object.keys(ITEMS).map(k => `<option ${k === PO.item ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
    <label>尺寸${sel('p-size', POSTER_SIZES, PO.size)}</label>
    <label>版面${sel('p-layout', { v: '直式（由右至左）', h: '橫式' }, PO.layout)}</label>
    <label>配色${sel('p-theme', POSTER_THEMES, PO.theme)}</label>
    <label>標題<input id="p-title" value="${esc(PO.title)}" placeholder="預設：功德芳名錄"></label>
    <label>PNG 解析度${sel('p-dpi', { 72: '72 dpi（帆布一般）', 100: '100 dpi（帆布精細）', 150: '150 dpi（海報）', 300: '300 dpi（A4／A3 印刷）' }, String(PO.dpi))}</label>
    <label class="chk"><input id="p-amt" type="checkbox" ${PO.showAmount ? 'checked' : ''}> 顯示金額（國字大寫）</label>
    <div class="w2 act"><button class="btn pri" id="p-svg">下載 SVG（輸出中心）</button><button class="btn" id="p-png">下載 PNG</button><button class="btn" id="p-print">直接列印</button><span class="muted" id="p-info"></span></div>
  </div>
  <div class="card poster-prev" id="p-prev"></div>`;
};
AFTER.poster = () => {
  const cur = () => posterSources().find(s => s.id === posterSrc);
  const draw = () => {
    const src = cur(); if (!src) { $('#p-prev').innerHTML = '<p class="muted">沒有可用的名單。</p>'; return; }
    const ents = posterEntries(src.id), sz = POSTER_SIZES[PO.size];
    const box = $('#p-prev');
    box.innerHTML = posterSVG(posterOpt(src), ents);
    const svg = box.querySelector('svg'), maxW = box.clientWidth - 32, maxH = window.innerHeight * 0.75;
    const k = Math.min(maxW / sz.w, maxH / sz.h);
    svg.setAttribute('width', Math.round(sz.w * k)); svg.setAttribute('height', Math.round(sz.h * k));
    $('#p-info').textContent = `${ents.length} 位・合計 ${money(ents.reduce((s, e) => s + e.amount, 0))} 元・${sz.w / 10}×${sz.h / 10} cm`;
  };
  const bind = (id, key, fn = v => v) => $(id).onchange = e => { PO[key] = fn(e.target.type === 'checkbox' ? e.target.checked : e.target.value); draw(); };
  $('#p-src').onchange = e => { posterSrc = e.target.value; go('poster'); };
  bind('#p-item', 'item'); bind('#p-size', 'size'); bind('#p-layout', 'layout'); bind('#p-theme', 'theme'); bind('#p-amt', 'showAmount'); bind('#p-dpi', 'dpi', Number);
  $('#p-title').oninput = e => { PO.title = e.target.value.trim(); draw(); };
  const fname = ext => { const t = new Date(), sz = POSTER_SIZES[PO.size];
    return `poster_${cur().id.replace(':', '-')}_${sz.w / 10}x${sz.h / 10}cm_${t.getFullYear() - 1911}${pad(t.getMonth() + 1)}${pad(t.getDate())}.${ext}`; };
  const svgNow = () => posterSVG(posterOpt(cur()), posterEntries(cur().id));
  $('#p-svg').onclick = () => { downloadBlob(new Blob([svgNow()], { type: 'image/svg+xml' }), fname('svg')); toast('已下載 SVG'); };
  $('#p-png').onclick = () => {
    const sz = POSTER_SIZES[PO.size]; toast('轉檔中…');
    svgToPng(svgNow(), sz.w, sz.h, PO.dpi).then(r => { downloadBlob(r.blob, fname('png')); toast(`已下載 PNG（${r.pw}×${r.ph} 像素）`); }).catch(e => toast(e.message));
  };
  $('#p-print').onclick = () => {
    const sz = POSTER_SIZES[PO.size];
    $('#print').innerHTML = `<style>@page{size:${sz.w}mm ${sz.h}mm;margin:0}</style><div class="poster-print">${svgNow()}</div>`;
    try { window.print(); } catch (e) {}
  };
  draw();
};

// ---------- printing ----------
function printReceipt(r) {
  const t = S.temple;
  $('#print').innerHTML = `<div class="rcpt"><h1>${esc(t.name)}</h1><p>收　據</p>
  <table><tr><th>收據編號</th><td>${r.no}</td></tr><tr><th>日期</th><td>中華民國 ${roc(r.date)}</td></tr>
  <tr><th>信眾</th><td>${esc(r.name)} 大德</td></tr><tr><th>地址</th><td>${esc(r.addr)}</td></tr>
  <tr><th>項目</th><td>${r.item}${r.qty > 1 ? ' ×' + r.qty : ''}</td></tr><tr><th>金額</th><td>新臺幣 ${money(r.amount)} 元整</td></tr>
  ${r.note ? `<tr><th>備註</th><td>${esc(r.note)}</td></tr>` : ''}</table>
  <p class="bless">${esc(t.deity)}庇佑　闔家平安　萬事如意</p><p class="sm">${esc(t.address)}　${esc(t.phone)}　經手人：________</p></div>`;
  try { window.print(); } catch (e) {}
}
function printDoc() { $('#print').innerHTML = $('#doc').outerHTML; try { window.print(); } catch (e) {} }


// ---------- 本機伺服器（入門正式版）----------
const SRV = { on: false, token: null, user: null, role: null, rank: 0, status: null, users: [] };
const RANK = { counter: 1, accountant: 2, chair: 3, admin: 4 };

async function api(method, p, body) {
  const r = await fetch(p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, SRV.token ? { Authorization: 'Bearer ' + SRV.token } : {}), body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && SRV.token && p !== '/api/login') { SRV.token = null; try { sessionStorage.removeItem('tc-token'); } catch (e) {} showLogin('閒置太久，請重新登入'); }
  if (!r.ok) throw new Error(j.error || '連線錯誤 ' + r.status);
  return j;
}
async function pushState() {
  const st = Object.assign({}, S); delete st.records;
  try { await api('PUT', '/api/state', { state: st }); } catch (e) { toast('存檔失敗：' + e.message); }
}

async function boot() {
  if (location.protocol.startsWith('http')) {
    try { const st = await (await fetch('/api/status')).json(); if (st.server) { SRV.on = true; SRV.status = st; } } catch (e) {}
  }
  if (!SRV.on) { load(); renderShell(); setLight(); return; }
  if (!SRV.status.setup) return showSetup();
  try { const saved = JSON.parse(sessionStorage.getItem('tc-token') || 'null'); if (saved) { Object.assign(SRV, saved); return await afterLogin(); } } catch (e) {}
  showLogin();
}

function gate(html) { const g = $('#gate'); g.innerHTML = `<div class="gate-in">${html}</div>`; g.hidden = false; }
function ungate() { $('#gate').hidden = true; $('#gate').innerHTML = ''; }

function showSetup() {
  gate(`<h2>宮廟雲 入門版：第一次啟用</h2><p class="muted">這台主機還沒有資料。新廟請選「新主機設定」；換機或主機故障請選「從備份還原」。</p>
  <div class="row2">
    <form class="card form" id="g-setup"><h3 class="w2">新主機設定</h3>
      <label class="w2">宮廟名稱<input name="templeName" required></label>
      <label>管理員姓名<input name="adminName" required></label>
      <label>管理員 PIN（4～8 位數字）<input name="adminPin" inputmode="numeric" pattern="\\d{4,8}" required type="password" autocomplete="new-password"></label>
      <label>備份密碼（至少 8 碼）<input name="backupPassword" type="password" minlength="8" required autocomplete="new-password"></label>
      <label>再輸入一次<input name="backupPassword2" type="password" minlength="8" required autocomplete="new-password"></label>
      <p class="w2 muted">備份密碼用來加密所有備份檔，請寫下來由主委與總幹事各保管一份。忘記密碼，備份就無法還原，我們也打不開。</p>
      <div class="w2 act"><button class="btn pri">開始使用</button><span class="muted" id="g-msg1"></span></div></form>
    <form class="card form" id="g-restore"><h3 class="w2">從備份還原（換機）</h3>
      <label class="w2">備份檔（隨身碟 TempleBackup 資料夾裡最新的 .tbak）<input name="file" type="file" accept=".tbak" required></label>
      <label class="w2">備份密碼<input name="password" type="password" required autocomplete="current-password"></label>
      <p class="w2 muted">人員、PIN、所有收據與設定都會一起還原，原本的備份隨身碟可以直接繼續用。</p>
      <div class="w2 act"><button class="btn">還原</button><span class="muted" id="g-msg2"></span></div></form>
  </div>`);
  $('#g-setup').onsubmit = async e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    if (f.backupPassword !== f.backupPassword2) { $('#g-msg1').textContent = '兩次備份密碼不一樣'; return; }
    try {
      await api('POST', '/api/setup', f);
      SRV.status = await (await fetch('/api/status')).json();
      await doLogin(f.adminName, f.adminPin);
    } catch (err) { $('#g-msg1').textContent = err.message; }
  };
  $('#g-restore').onsubmit = async e => {
    e.preventDefault(); const fd = new FormData(e.target), file = fd.get('file');
    $('#g-msg2').textContent = '還原中…';
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const r = await api('POST', '/api/setup/restore', { file: btoa(bin), password: fd.get('password') });
      SRV.status = await (await fetch('/api/status')).json();
      toast(`還原完成：${r.records} 筆收據`); showLogin('還原完成，請用原本的帳號登入');
    } catch (err) { $('#g-msg2').textContent = err.message; }
  };
}

async function showLogin(msg) {
  try { SRV.users = await api('GET', '/api/users/public'); } catch (e) { SRV.users = []; }
  let pick = SRV.users[0] ? SRV.users[0].name : '';
  const draw = () => {
    gate(`<h2>${esc(SRV.status.templeName || '宮廟雲')}</h2><p class="muted">${esc(msg || '請選擇您的名字並輸入 PIN')}</p>
    <div class="who-list">${SRV.users.map(u => `<button class="btn${u.name === pick ? ' pri' : ''}" data-who="${esc(u.name)}">${esc(u.name)}<br><small>${u.roleName}</small></button>`).join('')}</div>
    <form id="g-login" class="pin"><input id="g-pin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="PIN" aria-label="PIN">
      <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '清除', 0, '確定'].map(k => `<button type="${k === '確定' ? 'submit' : 'button'}" class="btn" data-k="${k}">${k}</button>`).join('')}</div>
      <p class="muted" id="g-err"></p></form>`);
    $('#gate').querySelectorAll('[data-who]').forEach(b => b.onclick = () => { pick = b.dataset.who; draw(); });
    $('#gate').querySelectorAll('[data-k]').forEach(b => b.onclick = () => { const k = b.dataset.k, i = $('#g-pin'); if (k === '清除') i.value = ''; else if (k !== '確定') i.value += k; });
    $('#g-login').onsubmit = async e => { e.preventDefault(); try { await doLogin(pick, $('#g-pin').value); } catch (err) { $('#g-err').textContent = err.message; $('#g-pin').value = ''; } };
    $('#g-pin').focus();
  };
  draw();
}

async function doLogin(name, pin) {
  const r = await api('POST', '/api/login', { name, pin });
  Object.assign(SRV, { token: r.token, user: r.user, role: r.role, rank: RANK[r.role] });
  try { sessionStorage.setItem('tc-token', JSON.stringify({ token: r.token, user: r.user, role: r.role, rank: RANK[r.role] })); } catch (e) {}
  await afterLogin();
}

async function afterLogin() {
  const d = await api('GET', '/api/state');
  try { SRV.users = await api('GET', '/api/users/public'); } catch (e) {}
  S = d.state || blankState(SRV.status.templeName);
  S.records = d.records;
  if (!d.state) await pushState();
  ungate(); renderShell(); setLight(); idleWatch();
  clearInterval(afterLogin.poll); afterLogin.poll = setInterval(refreshStatus, 60000);
}

async function logout(msg) {
  try { await api('POST', '/api/logout'); } catch (e) {}
  SRV.token = null; try { sessionStorage.removeItem('tc-token'); } catch (e) {}
  showLogin(msg);
}

let lastAct = Date.now();
function idleWatch() {
  if (idleWatch.on) return; idleWatch.on = true;
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { lastAct = Date.now(); }, true));
  setInterval(() => { if (SRV.token && Date.now() - lastAct > 15 * 60000) logout('閒置 15 分鐘，畫面已自動鎖定'); }, 30000);
}

async function refreshStatus() { try { SRV.status = await (await fetch('/api/status')).json(); setLight(); } catch (e) { setLight('down'); } }
function setLight(force) {
  const el = $('#blight'), who = $('#who');
  if (!el) return;
  if (!SRV.on) { el.className = 'blight gray'; el.textContent = '展示模式：資料存在瀏覽器'; who.hidden = true; return; }
  const b = SRV.status && SRV.status.backup, fresh = b && b.last && Date.now() - new Date(b.last) < 864e5;
  let cls = 'red', txt = '尚未備份';
  if (force === 'down') { txt = '伺服器沒有回應'; }
  else if (SRV.status && SRV.status.integrity === false) txt = '資料庫檢查異常，請聯絡維修';
  else if (b && b.ok && fresh) { cls = 'green'; txt = `已備份 ${new Date(b.last).toTimeString().slice(0, 5)}・隨身碟 ${b.plugged}`; }
  else if (b && b.last && fresh) { cls = 'yellow'; txt = b.plugged ? '備份到隨身碟失敗' : '沒插備份隨身碟'; }
  else if (b && b.last) txt = '超過 24 小時沒備份';
  el.className = 'blight ' + cls; el.textContent = txt;
  who.hidden = false; who.textContent = `${SRV.user}・登出`;
}

function showVoid(r) {
  const approvers = SRV.on ? SRV.users.filter(u => RANK[u.role] >= 2) : [];
  gate(`<h2>作廢收據 ${r.no}</h2><p>${esc(r.name)}・${r.item}・${money(r.amount)} 元</p>
  <form class="card form" id="g-void"><label class="w2">作廢原因<input name="reason" required placeholder="例：金額打錯，重開 ${r.no.slice(0, 7)}-xxxx"></label>
  ${SRV.on ? `<label>核准人（會計、主委或管理員）<select name="name">${approvers.map(u => `<option>${esc(u.name)}</option>`).join('')}</select></label>
  <label>核准人 PIN<input name="pin" type="password" inputmode="numeric" required autocomplete="off"></label>` : '<p class="w2 muted">展示模式不需核准；正式版需要主管 PIN。</p>'}
  <p class="w2 muted">作廢後保留原號，操作紀錄會記下原因與核准人。</p>
  <div class="w2 act"><button class="btn pri">確定作廢</button><button class="btn" type="button" id="g-cancel">取消</button><span class="muted" id="g-verr"></span></div></form>`);
  $('#g-cancel').onclick = ungate;
  $('#g-void').onsubmit = async e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    try {
      if (SRV.on) Object.assign(r, (await api('POST', '/api/records/void', { id: r.id, reason: f.reason, approver: { name: f.name, pin: f.pin } })).record);
      else { r.void = true; r.voidReason = f.reason; save(); }
      ungate(); go('search'); toast('收據 ' + r.no + ' 已作廢（保留原號）');
    } catch (err) { $('#g-verr').textContent = err.message; }
  };
}

function backupTiles() {
  const b = (SRV.status && SRV.status.backup) || {};
  return `
    <div class="tile"><span class="k">上次備份</span><span class="v" style="font-size:18px">${b.last ? roc(b.last) + ' ' + new Date(b.last).toTimeString().slice(0, 5) : '尚未備份'}</span><span class="chip ${b.ok ? 'up' : 'dn'}">${b.ok ? '成功' : esc(b.error || '請立即備份')}</span></div>
    <div class="tile"><span class="k">插著的備份隨身碟</span><span class="v">${b.plugged || 0}<small>支</small></span><span class="chip ${b.plugged ? 'up' : 'dn'}">${b.plugged ? '正常' : '請插上備份碟'}</span></div>
    <div class="tile"><span class="k">雲端備份</span><span class="v" style="font-size:18px">${esc(b.cloud || '未啟用')}</span></div>`;
}
function serverBackupView() {
  return `<h2>備份・還原</h2>
  <div class="tiles" id="bk-tiles">${backupTiles()}</div>
  <div class="card"><h3>自動備份時機</h3><p>每次關帳、每 50 筆登記、有異動時每小時一次、關機前。每份都寫到本機快照與所有插著的備份碟，並保留 30 天每日與 12 個月每月的版本。</p>
    <div class="act"><button class="btn pri" id="bk-now">立即備份</button>${SRV.rank >= 2 ? '<button class="btn" id="bk-close">今日關帳</button>' : ''}</div><div id="bk-out"></div></div>
  ${SRV.rank >= 3 ? `<form class="card form" id="bk-usb"><h3 class="w2">設定新的備份隨身碟</h3><label class="w2">隨身碟位置<input name="path" required placeholder="例：E:\\"></label>
    <p class="w2 muted">建議準備兩支：一支常插，一支每週交換帶回家。設定後會在隨身碟放一個識別檔，系統只會備份到本廟的碟。</p><div class="w2 act"><button class="btn">設定為備份碟</button></div></form>` : ''}
  <div class="card"><h3>換機或主機故障</h3><ol class="log"><li>先改用手寫收據（H 開頭編號），之後在「油香登記」補登。</li><li>在備用主機開啟系統，選「從備份還原」。</li><li>選隨身碟 TempleBackup 資料夾裡最新的檔案，輸入備份密碼。</li></ol></div>`;
}
function serverBackupAfter() {
  const out = $('#bk-out');
  const tiles = () => refreshStatus().then(() => { if ($('#bk-tiles')) $('#bk-tiles').innerHTML = backupTiles(); });
  tiles();
  $('#bk-now').onclick = async () => { out.textContent = '備份中…'; try { const r = await api('POST', '/api/backup/run'); await tiles(); out.textContent = ''; toast(r.targets.length ? `已備份到 ${r.targets.length} 支隨身碟` : '已備份到本機（沒有插備份碟）'); } catch (e) { out.textContent = e.message; } };
  if ($('#bk-close')) $('#bk-close').onclick = async () => {
    out.textContent = '關帳中…';
    try {
      const r = await api('POST', '/api/close-day', {}); await tiles();
      out.innerHTML = `<div class="card ok"><b>${r.day} 關帳完成</b>：${r.count} 筆，${money(r.total)} 元（作廢 ${r.voided} 筆）<br>${Object.entries(r.byItem).map(([k, v]) => `${k} ${money(v)} 元`).join('、') || '今日無收入'}<br><small>核對碼 ${r.chainHead}（印在日報上，日後可比對紀錄有沒有被改過）</small></div>`;
      setLight();
    } catch (e) { out.textContent = e.message; }
  };
  if ($('#bk-usb')) $('#bk-usb').onsubmit = async e => { e.preventDefault(); try { const r = await api('POST', '/api/backup/prepare-usb', { path: new FormData(e.target).get('path') }); await refreshStatus(); toast(`已設定，目前 ${r.targets.length} 支備份碟`); go('backup'); } catch (err) { toast(err.message); } };
}

const ACTIONS = { setup: '初次設定', restore: '從備份還原', login: '登入', login_fail: 'PIN 錯誤', update_state: '修改設定', record_create: '登記', record_manual: '補登手寫收據', record_void: '作廢', close_day: '關帳', prepare_usb: '設定備份碟', user_add: '新增人員', user_pin: '重設 PIN', user_active: '啟用／停用人員' };
VIEWS.audit = () => !SRV.on ? `<h2>操作紀錄</h2><div class="card"><p>正式版（本機伺服器）會記下每一筆登記、作廢、修改、登入，並用雜湊鏈串起來，任何人事後改資料庫都會被發現。</p><p class="muted">目前是展示模式，沒有操作紀錄。</p></div>`
  : SRV.rank < 2 ? `<h2>操作紀錄</h2><div class="card"><p>需要會計、主委或管理員權限。</p></div>`
  : `<h2>操作紀錄</h2><div class="card"><div class="act"><button class="btn pri" id="au-verify">檢查紀錄有沒有被竄改</button><span id="au-res" class="muted"></span></div></div><div class="card" id="au-list">載入中…</div>`;
AFTER.audit = async () => {
  if (!SRV.on || SRV.rank < 2) return;
  $('#au-verify').onclick = async () => { const v = await api('GET', '/api/audit/verify'); $('#au-res').innerHTML = v.ok ? `<span class="chip up">完整</span> 共 ${v.checked} 筆，沒有被修改` : `<span class="chip dn">異常</span> 第 ${v.brokenAt} 筆之後的紀錄被改過，請聯絡維修`; };
  const list = await api('GET', '/api/audit');
  $('#au-list').innerHTML = `<div class="tbl"><table><thead><tr><th>時間</th><th>人員</th><th>動作</th><th>內容</th></tr></thead><tbody>${list.map(a => `<tr><td>${roc(a.ts)} ${new Date(a.ts).toTimeString().slice(0, 5)}</td><td>${esc(a.user)}</td><td>${ACTIONS[a.action] || esc(a.action)}</td><td>${esc([a.detail.no, a.detail.name, a.detail.item, a.detail.amount != null ? money(a.detail.amount) + ' 元' : '', a.detail.reason ? '原因：' + a.detail.reason : '', a.detail.approvedBy ? '核准：' + a.detail.approvedBy : '', a.detail.keys ? a.detail.keys.join('、') : '', a.detail.day || ''].filter(Boolean).join('　'))}</td></tr>`).join('')}</tbody></table></div>`;
};

async function usersPanel() {
  const el = $('#users'); if (!el) return;
  const list = await api('GET', '/api/admin/users');
  const roleName = { counter: '櫃台', accountant: '會計', chair: '主委／管理人', admin: '系統管理員' };
  el.innerHTML = `<h3>人員與 PIN</h3><div class="tbl"><table><thead><tr><th>姓名</th><th>角色</th><th>狀態</th><th></th></tr></thead><tbody>${list.map(u => `<tr><td>${esc(u.name)}</td><td>${roleName[u.role]}</td><td>${u.active ? '啟用' : '停用'}</td><td class="act"><button class="btn sm" data-upin="${u.id}">重設 PIN</button><button class="btn sm" data-uact="${u.id}" data-on="${u.active ? 0 : 1}">${u.active ? '停用' : '啟用'}</button></td></tr>`).join('')}</tbody></table></div>
  <form class="form" id="u-add"><label>姓名<input name="name" required></label><label>角色<select name="role"><option value="counter">櫃台</option><option value="accountant">會計</option><option value="chair">主委／管理人</option><option value="admin">系統管理員</option></select></label><label>PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" required autocomplete="new-password"></label><div class="act"><button class="btn pri">新增人員</button></div></form>`;
  $('#u-add').onsubmit = async e => { e.preventDefault(); try { await api('POST', '/api/admin/users', Object.assign({ action: 'add' }, Object.fromEntries(new FormData(e.target)))); toast('已新增'); usersPanel(); } catch (err) { toast(err.message); } };
  el.querySelectorAll('[data-uact]').forEach(b => b.onclick = async () => { await api('POST', '/api/admin/users', { action: 'active', id: b.dataset.uact, active: b.dataset.on === '1' }); usersPanel(); });
  el.querySelectorAll('[data-upin]').forEach(b => b.onclick = () => {
    b.outerHTML = `<input type="password" inputmode="numeric" class="pinin" placeholder="新 PIN" data-pid="${b.dataset.upin}" autocomplete="new-password">`;
    const i = el.querySelector(`[data-pid="${b.dataset.upin}"]`); i.focus();
    i.onchange = async () => { try { await api('POST', '/api/admin/users', { action: 'pin', id: i.dataset.pid, pin: i.value }); toast('PIN 已更新'); usersPanel(); } catch (err) { toast(err.message); } };
  });
}

// ---------- events ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-go],[data-tier],[data-print],[data-void],[data-led],[data-printdoc],[data-poster]');
  if (!b) return;
  if (b.dataset.poster) { posterSrc = b.dataset.poster; go('poster'); }
  else if (b.dataset.go) go(b.dataset.go);
  else if (b.dataset.tier) { S.tier = b.dataset.tier; save(); renderShell(); }
  else if (b.dataset.print) printReceipt(S.records.find(r => r.id == b.dataset.print));
  else if (b.dataset.void) showVoid(S.records.find(x => x.id == b.dataset.void));
  else if (b.dataset.led) { pushLed(S.records.find(r => r.id == b.dataset.led)); save(); toast('已推上字幕機'); b.remove(); }
  else if (b.dataset.printdoc) printDoc();
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.rule) { S.rules[el.dataset.rule] = el.checked; save(); toast(el.checked ? '已開啟' : '已關閉'); }
  if (el.dataset.online) { S.online[el.dataset.online] = el.checked; save(); toast(el.checked ? '已啟用（原型）' : '已停用'); }
});
document.addEventListener('submit', e => {
  const f = e.target;
  if (f.dataset.role) {
    e.preventDefault(); const fd = new FormData(f);
    S.events.find(x => x.id == f.dataset.role).roles.push({ role: fd.get('role'), name: fd.get('name'), amount: Number(fd.get('amount')) });
    save(); go(current);
  } else if (f.dataset.newev) {
    e.preventDefault(); const fd = new FormData(f);
    S.events.push({ id: Math.max(0, ...S.events.map(x => x.id)) + 1, kind: f.dataset.newev, name: fd.get('name'), date: fd.get('date'), roles: [] });
    save(); go(current);
  } else if (f.id === 'ftr') {
    e.preventDefault(); const fd = new FormData(f); S.troupes.push(Object.fromEntries(fd)); save(); VZ.tab = 'mine'; go('troupe');
  }
});
$('#tier').onchange = e => { S.tier = e.target.value; save(); renderShell(); toast('已切換到' + TIERS[S.tier].name + '方案'); };

document.addEventListener('click', e => { if (e.target.id === 'who') logout('已登出'); });
boot();
