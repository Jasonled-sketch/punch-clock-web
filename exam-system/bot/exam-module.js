'use strict';
/**
 * JR 家庭考卷系統 — 核心模組
 * 純邏輯 + Ragic 讀寫，不依賴 Express / LINE SDK，方便接進現有 index.js。
 * 所有金鑰從 process.env 讀，程式碼不寫死。
 */
const crypto = require('crypto');

/* ===== 建表後用 probe-fields.js 取得，填在這裡 ===== */
const FIELDS = {
  exams:    { sheet:'bookkeeping/7', 考卷編號:'TODO', 科目:'TODO', 標題:'TODO', 單元:'TODO',
              題數:'TODO', 指派日:'TODO', 狀態:'TODO', 題庫JSON:'TODO', 建立時間:'TODO' },
  attempts: { sheet:'bookkeeping/8', 作答時間:'TODO', 時間戳:'TODO', 學生:'TODO', 考卷編號:'TODO',
              考卷標題:'TODO', 科目:'TODO', 分數:'TODO', 答對題數:'TODO', 總題數:'TODO',
              獎章:'TODO', 答錯清單:'TODO', 重出次數:'TODO' },
  reviews:  { sheet:'bookkeeping/9', 鍵值:'TODO', 學生:'TODO', 考卷編號:'TODO',
              狀態JSON:'TODO', 最近更新:'TODO' }
};

const RAGIC_BASE = process.env.RAGIC_BASE || 'https://ap10.ragic.com/Fan28';
const RAGIC_KEY  = process.env.RAGIC_KEY;
const EXAM_SECRET = process.env.EXAM_SECRET;

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
async function ragicGet(sheet, params = {}) {
  const q = new URLSearchParams(Object.assign({ api:'', naming:'fid' }, params)).toString();
  const r = await fetch(`${RAGIC_BASE}/${sheet}?${q}`, {
    headers: { Authorization: 'Basic ' + RAGIC_KEY }
  });
  if (!r.ok) throw new Error(`Ragic GET ${sheet} ${r.status}`);
  const j = await r.json();
  return Object.values(j || {});
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
async function listPapers() {
  const F = FIELDS.exams;
  const rows = await ragicGet(F.sheet);
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
  return ragicPost(F.sheet, {
    [F.考卷編號]: paper.id, [F.科目]: paper.subject, [F.標題]: paper.title,
    [F.單元]: paper.unit || '', [F.題數]: String(paper.bank.length),
    [F.指派日]: paper.assigned ? paper.assigned.replace(/-/g, '/') : ragicDay(),
    [F.狀態]: paper.status || '待審核',
    [F.題庫JSON]: JSON.stringify({ parts: paper.parts || null, bank: paper.bank }),
    [F.建立時間]: ragicDay()
  }, paper._rid);
}
async function setPaperStatus(paper, status) {
  return ragicPost(FIELDS.exams.sheet, { [FIELDS.exams.狀態]: status }, paper._rid);
}

/* ===== 作答紀錄 ===== */
async function listAttempts(student, limit = 300) {
  const F = FIELDS.attempts;
  const rows = await ragicGet(F.sheet, { limit: String(limit) });
  return rows
    .filter(r => !student || r[F.學生] === student)
    .map(r => ({
      at: Number(r[F.時間戳]) || 0, student: r[F.學生], paperId: r[F.考卷編號],
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
    [F.作答時間]: ragicDay(a.at), [F.時間戳]: String(a.at), [F.學生]: a.student,
    [F.考卷編號]: a.paperId, [F.考卷標題]: a.title || '', [F.科目]: a.subject || '',
    [F.分數]: String(a.score), [F.答對題數]: String(a.right), [F.總題數]: String(a.total),
    [F.獎章]: a.medal, [F.答錯清單]: (a.wrong || []).join(','), [F.重出次數]: String(a.resets || 0)
  });
}

/* ===== 複習排程 ===== */
async function loadReviews(student) {
  const F = FIELDS.reviews;
  const rows = await ragicGet(F.sheet);
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
  FIELDS, PASS, N_PER_EXAM, REVIEW_MAX, INTERVALS, TIERS, tierOf,
  isoDay, ragicDay, fromIso, weekStart, DAY,
  signStudent, verifyStudent, examUrl,
  ragicGet, ragicPost,
  listPapers, savePaper, setPaperStatus,
  listAttempts, saveAttempt,
  loadReviews, saveReview, bumpCell, dueQuestions,
  buildExam, buildReviewExam, grade,
  weekBoard, weekBoardText
};
