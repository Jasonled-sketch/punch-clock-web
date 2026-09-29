'use strict';
/**
 * JR 家庭考卷系統 — 核心模組
 * 純邏輯 + Ragic 讀寫，不依賴 Express / LINE SDK，方便接進現有 index.js。
 * 所有金鑰從 process.env 讀，程式碼不寫死。
 */
const crypto = require('crypto');

/* ===== 2026-09-24 實測取得（Ragic 建表當下自動編號，不可沿用別張表的） ===== */
const FIELDS = {
  exams:    { sheet:'bookkeeping/8', 考卷編號:'1003363', 科目:'1003364', 標題:'1003365', 單元:'1003366',
              題數:'1003367', 指派日:'1003368', 狀態:'1003369', 題庫JSON:'1003370', 建立時間:'1003371' },
  attempts: { sheet:'bookkeeping/9', 作答時間:'1003373', 時間戳:'1003374', 學生:'1003375', 考卷編號:'1003376',
              考卷標題:'1003377', 科目:'1003378', 分數:'1003379', 答對題數:'1003380', 總題數:'1003381',
              獎章:'1003382', 答錯清單:'1003383', 重出次數:'1003384' },
  reviews:  { sheet:'bookkeeping/10', 鍵值:'1003386', 學生:'1003387', 考卷編號:'1003388',
              狀態JSON:'1003389', 最近更新:'1003390' }
};

const RAGIC_BASE = process.env.RAGIC_BASE || 'https://ap10.ragic.com/Fan28';
const RAGIC_KEY  = process.env.RAGIC_KEY;
/**
 * 簽作答連結用的金鑰。
 * 有設 EXAM_SECRET 就用它；沒設就從服務既有的 LINE_CHANNEL_SECRET 單向推導一把出來
 * （HMAC 是單向的，推不回原本的 LINE 金鑰）。
 * 這樣不必另外保管一把新祕密，重開機也不會變，連結不會失效。
 * ⚠️ LINE_CHANNEL_SECRET 若輪替，舊的作答連結會失效——叫 bot 重發一條即可。
 */
const EXAM_SECRET = process.env.EXAM_SECRET
  || (process.env.LINE_CHANNEL_SECRET
      ? crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update('exam-link-key-v1').digest('hex')
      : '');

/* ===== 規則 ===== */
const PASS = 85;
const N_PER_EXAM = 25;
const REVIEW_MAX = 20;
const INTERVALS = [1, 3, 7, 14, 30];           // 熟練度 0~4 對應天數，5 = 畢業
const TIERS = [
  { min:95, name:'超級獎盃', emoji:'🏆' }, { min:90, name:'鑽石', emoji:'💎' },
  { min:85, name:'金牌',   emoji:'🥇' }, { min:80, name:'銀牌', emoji:'🥈' },
  { min:70, name:'銅牌',   emoji:'🥉' }, { min:60, name:'獎狀', emoji:'📜' },
  { min:0,  name:'豬頭',   emoji:'🐷' }
];
const tierOf = s => TIERS.find(t => s >= t.min);

/**
 * 學生代號 → 顯示名稱。代號刻意用英文(寫進 Railway 變數、網址、Ragic 都不怕亂碼)，
 * 給人看的地方一律走這裡換成中文。要加小孩就在這裡加一行。
 */
const STUDENT_NAMES = { ayu: '阿宇' };
const displayName = id => STUDENT_NAMES[id] || String(id || '');

/* ===== 日期 ===== */
const DAY = 864e5;
const pad = n => String(n).padStart(2, '0');
/** 給程式內部比較用：2026-09-24 */
function isoDay(t = Date.now()) {
  const d = new Date(t);
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}
/** 給 Ragic 寫入用：2026/09/24。用短線寫不進去。 */
const ragicDay = t => isoDay(t).replace(/-/g, '/');
/** 給 Ragic 日期時間欄寫入用：2026/09/24 14:35 */
function ragicDateTime(t = Date.now()) {
  const d = new Date(t);
  return ragicDay(t) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
/**
 * 讀回 Ragic 日期欄 → 毫秒。吃 2026/09/24 與 2026/09/24 14:35(:00) 兩種。
 * ⚠️ 2026-09-24 實測：「時間戳」欄被建成日期型態，寫毫秒進去會被吞成空字串，
 * 所以排序時間改以「作答時間」為主，時間戳只當備援。
 */
function parseRagicTime(s) {
  const m = String(s || '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
}
const fromIso = s => new Date(s + 'T00:00:00').getTime();
/** 本週一 00:00 */
function weekStart(t = Date.now()) {
  const d = new Date(t); d.setHours(0,0,0,0);
  return +d - ((d.getDay() + 6) % 7) * DAY;
}

/* ===== 作答連結簽章 ===== */
function signStudent(studentId) {
  if (!EXAM_SECRET) throw new Error('EXAM_SECRET 未設定');
  return crypto.createHmac('sha256', EXAM_SECRET).update(String(studentId)).digest('hex').slice(0, 16);
}
function verifyStudent(studentId, token) {
  if (!studentId || !token) return false;
  const want = Buffer.from(signStudent(studentId));
  const got  = Buffer.from(String(token));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function examUrl(studentId) {
  const base = (process.env.EXAM_WEB_BASE || '').replace(/\/$/, '');
  return `${base}/?s=${encodeURIComponent(studentId)}&t=${signStudent(studentId)}`;
}

/* ===== Ragic ===== */
/**
 * ⚠️ 2026-09-24 實測：這幾張表即使帶 naming=fid，Ragic 還是回「中文欄名」當 key。
 * 所以讀回來先照 FIELDS 把中文名補成欄位代號，下游一律用 r[F.欄位] 取值，
 * 兩種命名都吃得下（Ragic 哪天改回 fid 也不會壞）。
 * @param fmap FIELDS.exams / FIELDS.attempts / FIELDS.reviews
 */
function normalizeRow(row, fmap) {
  if (!fmap) return row;
  for (const [cname, fid] of Object.entries(fmap)) {
    if (cname === 'sheet') continue;
    if (row[fid] === undefined && row[cname] !== undefined) row[fid] = row[cname];
  }
  return row;
}
async function ragicGet(sheet, params = {}, fmap = null) {
  // ⚠️ 金鑰沒設/設錯時 Ragic 不會回 401，而是回 200 + 空資料（低權限訪客）。
  // 那會變成「網頁打得開但一張考卷都沒有」的無頭公案，所以缺金鑰直接吵。
  if (!RAGIC_KEY) throw new Error('RAGIC_KEY 未設定，Ragic 會靜默回空資料');
  const q = new URLSearchParams(Object.assign({ api:'', naming:'fid' }, params)).toString();
  const r = await fetch(`${RAGIC_BASE}/${sheet}?${q}`, {
    headers: { Authorization: 'Basic ' + RAGIC_KEY }
  });
  if (!r.ok) throw new Error(`Ragic GET ${sheet} ${r.status}`);
  const j = await r.json();
  // 清單回應是「以 ragicId 為 key 的 map」，沒有 .data 包裝；仍保留雙容錯
  return Object.values(j.data || j || {}).map(row => normalizeRow(row, fmap));
}
async function ragicPost(sheet, fields, recordId) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.append(k, v == null ? '' : String(v));
  const url = `${RAGIC_BASE}/${sheet}${recordId ? '/' + recordId : ''}?api`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + RAGIC_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error(`Ragic POST ${sheet} ${r.status}`);
  return r.json();
}

/* ===== 考卷 ===== */
/**
 * 考卷清單快取 60 秒。題庫 JSON 很大（每份幾十題、隨考卷越變越多），
 * 原本開首頁、開考卷、交卷每一步都重撈整張表，網頁會卡。
 * 本程式上架/下架/新增後會立刻清掉；有人直接在 Ragic 改，最慢 60 秒生效。
 * ⚠️ 回傳的是共用物件，呼叫端只能讀不能改（buildExam/grade/dueQuestions 目前都只讀）。
 */
const PAPER_TTL = 60e3;
let paperCache = null;
const clearPaperCache = () => { paperCache = null; };
async function listPapers() {
  if (paperCache && Date.now() - paperCache.at < PAPER_TTL) return paperCache.list;
  const list = await fetchPapers();
  paperCache = { at: Date.now(), list };
  return list;
}
async function fetchPapers() {
  const F = FIELDS.exams;
  const rows = await ragicGet(F.sheet, {}, F);
  return rows
    .filter(r => r[F.狀態] === '已上架')
    .map(r => {
      let bank = [], parts = null;
      try {
        const raw = JSON.parse(r[F.題庫JSON] || '{}');
        bank = Array.isArray(raw) ? raw : (raw.bank || []);
        parts = Array.isArray(raw) ? null : (raw.parts || null);
      } catch (e) { /* 題庫壞掉就當空卷，不要讓整個清單爆掉 */ }
      return {
        id: r[F.考卷編號], subject: r[F.科目], title: r[F.標題], unit: r[F.單元],
        assigned: String(r[F.指派日] || '').replace(/\//g, '-'),
        bank, parts, _rid: r._ragicId
      };
    })
    .filter(p => p.id && p.bank.length);
}
async function savePaper(paper) {
  const F = FIELDS.exams;
  try {
    return await ragicPost(F.sheet, {
      [F.考卷編號]: paper.id, [F.科目]: paper.subject, [F.標題]: paper.title,
      [F.單元]: paper.unit || '', [F.題數]: String(paper.bank.length),
      [F.指派日]: paper.assigned ? paper.assigned.replace(/-/g, '/') : ragicDay(),
      [F.狀態]: paper.status || '待審核',
      [F.題庫JSON]: JSON.stringify({ parts: paper.parts || null, bank: paper.bank }),
      [F.建立時間]: ragicDay()
    }, paper._rid);
  } finally { clearPaperCache(); }
}
async function setPaperStatus(paper, status) {
  try { return await ragicPost(FIELDS.exams.sheet, { [FIELDS.exams.狀態]: status }, paper._rid); }
  finally { clearPaperCache(); }
}

/* ===== 作答紀錄 ===== */
async function listAttempts(student, limit = 300) {
  const F = FIELDS.attempts;
  const rows = await ragicGet(F.sheet, { limit: String(limit) }, F);
  return rows
    .filter(r => !student || r[F.學生] === student)
    .map(r => ({
      at: Number(r[F.時間戳]) || parseRagicTime(r[F.作答時間]), student: r[F.學生], paperId: r[F.考卷編號],
      title: r[F.考卷標題], subject: r[F.科目], score: Number(r[F.分數]) || 0,
      right: Number(r[F.答對題數]) || 0, total: Number(r[F.總題數]) || 0,
      medal: r[F.獎章], wrong: String(r[F.答錯清單] || '').split(',').filter(Boolean),
      resets: Number(r[F.重出次數]) || 0
    }))
    .sort((a, b) => b.at - a.at);
}
async function saveAttempt(a) {
  const F = FIELDS.attempts;
  return ragicPost(F.sheet, {
    [F.作答時間]: ragicDateTime(a.at), [F.時間戳]: String(a.at), [F.學生]: a.student,
    [F.考卷編號]: a.paperId, [F.考卷標題]: a.title || '', [F.科目]: a.subject || '',
    [F.分數]: String(a.score), [F.答對題數]: String(a.right), [F.總題數]: String(a.total),
    [F.獎章]: a.medal, [F.答錯清單]: (a.wrong || []).join(','), [F.重出次數]: String(a.resets || 0)
  });
}

/* ===== 複習排程 ===== */
async function loadReviews(student) {
  const F = FIELDS.reviews;
  const rows = await ragicGet(F.sheet, {}, F);
  const out = {};
  for (const r of rows) {
    if (r[F.學生] !== student) continue;
    try { out[r[F.考卷編號]] = { state: JSON.parse(r[F.狀態JSON] || '{}'), _rid: r._ragicId }; }
    catch (e) { out[r[F.考卷編號]] = { state: {}, _rid: r._ragicId }; }
  }
  return out;
}
async function saveReview(student, paperId, state, rid) {
  const F = FIELDS.reviews;
  return ragicPost(F.sheet, {
    [F.鍵值]: `${student}_${paperId}`, [F.學生]: student, [F.考卷編號]: paperId,
    [F.狀態JSON]: JSON.stringify(state), [F.最近更新]: ragicDay()
  }, rid);
}
/** 答對升一級，答錯一律掉回第 0 級。回傳新的 cell，null = 畢業要刪掉。 */
function bumpCell(cell, ok) {
  const c = Object.assign({ lv:0, ok:0, ng:0 }, cell || {});
  if (ok) { c.ok++; c.lv = Math.min(5, c.lv + 1); } else { c.ng++; c.lv = 0; }
  if (c.lv >= 5) return null;
  c.due = isoDay(Date.now() + INTERVALS[c.lv] * DAY);
  c.last = isoDay();
  return c;
}
/** 跨考卷收集今天到期的題目 */
function dueQuestions(papers, reviews, today = isoDay()) {
  const out = [];
  for (const p of papers) {
    const st = (reviews[p.id] || {}).state || {};
    for (const qid of Object.keys(st)) {
      if (st[qid].due && st[qid].due <= today) {
        const q = p.bank.find(x => String(x.id) === String(qid));
        if (q) out.push({ paper:p, q });
      }
    }
  }
  return out;
}

/* ===== 出題 ===== */
const shuffle = a => { for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
/** 出一份新卷：上次答錯的優先，再 r1 題庫，再全部補滿 */
function buildExam(paper, reviewState = {}) {
  const bank = paper.bank || [];
  const ids = [];
  const push = list => { for (const id of list) { if (ids.length >= N_PER_EXAM) break; if (!ids.includes(id)) ids.push(id); } };
  push(shuffle(bank.filter(q => reviewState[q.id] && reviewState[q.id].lv === 0).map(q => q.id)));
  push(shuffle(bank.filter(q => q.r1).map(q => q.id)));
  push(shuffle(bank.map(q => q.id)));
  const list = shuffle(ids).map(id => bank.find(q => String(q.id) === String(id))).filter(Boolean);
  if (paper.parts) list.sort((a, b) => (a.p || 0) - (b.p || 0));
  return list;
}
function buildReviewExam(papers, reviews) {
  return shuffle(dueQuestions(papers, reviews)).slice(0, REVIEW_MAX);
}

/* ===== 評分 ===== */
/**
 * @param answers [{paperId, qid, pick}]  pick 為選項索引，null = 未作答
 * @returns {score,right,total,medal,wrong,byPaper}
 */
function grade(answers, papers) {
  let right = 0; const wrong = []; const byPaper = {};
  for (const a of answers) {
    const p = papers.find(x => x.id === a.paperId);
    const q = p && p.bank.find(x => String(x.id) === String(a.qid));
    if (!q) continue;
    const ok = a.pick != null && Number(a.pick) === q.a;
    if (ok) right++; else wrong.push(`${a.paperId}:${a.qid}`);
    (byPaper[a.paperId] = byPaper[a.paperId] || []).push({ qid:a.qid, ok });
  }
  const total = answers.length;
  const score = total ? Math.round(right / total * 100) : 0;
  return { score, right, total, medal: tierOf(score).name, wrong, byPaper };
}

/* ===== 週曆 ===== */
/** 回傳週一到週日七格，每格取當天最高分 */
function weekBoard(attempts, now = Date.now()) {
  const ws = weekStart(now), best = {};
  for (const a of attempts) {
    const d = isoDay(a.at);
    if (!(d in best) || a.score > best[d]) best[d] = a.score;
  }
  const names = ['星期一','星期二','星期三','星期四','星期五','星期六','星期日'];
  return names.map((name, i) => {
    const day = isoDay(ws + i * DAY), score = best[day];
    return {
      name, day, score: score == null ? null : score,
      medal: score == null ? null : tierOf(score).name,
      emoji: score == null ? '⬜' : tierOf(score).emoji,
      today: day === isoDay(now)
    };
  });
}
/** 七點推播用的純文字 */
function weekBoardText(board, student) {
  const line = board.map(d => d.emoji).join(' ');
  const detail = board.filter(d => d.score != null)
    .map(d => `${d.name.slice(2)} ${d.emoji}${d.medal} ${d.score}分`).join('\n');
  const done = board.filter(d => d.score != null).length;
  return `🏆 ${student} 本週考試獎勵\n\n${line}\n一 二 三 四 五 六 日\n\n`
       + (detail || '本週還沒有作答紀錄')
       + `\n\n本週完成 ${done} / 7 天`;
}

module.exports = {
  FIELDS, PASS, N_PER_EXAM, REVIEW_MAX, INTERVALS, TIERS, tierOf, displayName,
  isoDay, ragicDay, ragicDateTime, parseRagicTime, fromIso, weekStart, DAY,
  signStudent, verifyStudent, examUrl,
  ragicGet, ragicPost,
  listPapers, clearPaperCache, savePaper, setPaperStatus,
  listAttempts, saveAttempt,
  loadReviews, saveReview, bumpCell, dueQuestions,
  buildExam, buildReviewExam, grade,
  weekBoard, weekBoardText
};
