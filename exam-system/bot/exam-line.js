'use strict';
/**
 * JR 家庭考卷系統 — LINE 這一側（JR 版）
 *
 * ⚠️ 這支是照 jr-family-bot 的風格重寫的，不是交接包裡那支。
 *    交接包那支假設專案有 @line/bot-sdk（client.replyMessage(...)），
 *    本專案沒有裝 SDK，一律用 fetch 打 LINE API，所以整支重寫。
 *
 * 兩個入口：
 *   一對一：傳照片 → 「認不出」卡片上按「📚 這是考試範圍」
 *   家庭群組：小朋友把講義照片丟群組（bot 不出聲、不跑 AI），再打「出考卷」
 *
 * 防濫用／防誤判：
 *   - 群組照片只記訊息編號，不下載、不跑 AI；沒人打「出考卷」就 30 分鐘後忘掉
 *   - 只認 EXAM_GROUP_ID 那一個群組
 *   - 每天出題上限 EXAM_DAILY_MAX（預設 3 份），同時只跑一份
 *   - AI 先判斷是不是課本／講義，不是就不出題
 *   - 上架／重出／丟掉只有爸爸（EXAM_PARENT_ID）按得動
 *
 * 省額度原則（照 skill line-quota-saving）：
 *   小朋友打字、按按鈕 → 一律 reply，免費。
 *   只有「出題太久超過 reply 時限」「上架公告」「每晚七點週曆」才動用 push。
 *   推到群組，群裡幾個人都只算 1 則。
 */
const fs = require('fs');
const path = require('path');
const X = require('./exam-module');
const routes = require('./exam-routes');

const PROMPT = fs.readFileSync(path.join(__dirname, 'prompt-quiz.txt'), 'utf8');
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const STUDENT = process.env.EXAM_STUDENT_ID || 'kid';
const STUDENT_NAME = process.env.EXAM_STUDENT_NAME || X.displayName(STUDENT);

const MAX_IMGS = 8;                 // 一份考卷最多吃幾張照片
const BUF_TTL = 30 * 60e3;          // 群組照片等「出考卷」最多等多久
/** 每天 bot 自動出題上限。設 0 ＝ 關掉 bot 出題（改由爸爸把照片轉給 Claude 出，不另外花 API 費） */
const DAILY_MAX = (() => {
  const n = parseInt(process.env.EXAM_DAILY_MAX ?? '3', 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();

/** 等 Jason 審核的卷。重開機會掉，屆時請小朋友重傳。 */
const papersPending = new Map();
/** 群組裡剛丟的照片：`群組:使用者` → { ids:[訊息編號], ts } */
const groupBuf = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of papersPending) if (now - v.ts > 6 * 3600e3) papersPending.delete(k);
  for (const [k, v] of groupBuf) if (now - v.ts > BUF_TTL) groupBuf.delete(k);
}, 10 * 60e3);

/* ===== 出題配額：每天上限 + 同時只跑一份 ===== */
const twDay = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const quota = { day: '', n: 0 };
let busy = false;
function quotaLeft() {
  if (quota.day !== twDay()) { quota.day = twDay(); quota.n = 0; }
  return DAILY_MAX - quota.n;
}
const takeQuota = () => { if (quotaLeft() <= 0) return false; quota.n++; return true; };
const refundQuota = () => { if (quota.n > 0) quota.n--; };

/* ===== LINE helpers（JR 沒有 push，只有 reply，這裡補上）===== */
async function reply(replyToken, messages) {
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ replyToken, messages: Array.isArray(messages) ? messages : [messages] }),
  });
  if (!r.ok) console.error('[exam] reply fail', r.status, (await r.text()).slice(0, 200));
}
async function push(to, messages) {
  if (!to) { console.warn('[exam] push 略過：收件者未設定'); return; }
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ to, messages: Array.isArray(messages) ? messages : [messages] }),
  });
  if (!r.ok) console.error('[exam] push fail', r.status, (await r.text()).slice(0, 200));
}
async function getLineImage(messageId) {
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  if (!r.ok) throw new Error('image download ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}
const text = (t, quickItems) => {
  const m = { type: 'text', text: t };
  if (quickItems) m.quickReply = { items: quickItems };
  return m;
};
const qrPostback = (label, data) => ({ type: 'action', action: { type: 'postback', label, data, displayText: label } });
const qrUri = (label, uri) => ({ type: 'action', action: { type: 'uri', label, uri } });

/** 這些 env 在跑的時候才讀，部署改值不用改 code */
const groupId  = () => process.env.EXAM_GROUP_ID || '';
const parentId = () => process.env.EXAM_PARENT_ID || '';
const isParent = ev => !parentId() || (ev.source && ev.source.userId === parentId());

/* ===== 1. 出題（接 JR 現有的 Claude 呼叫方式：直接 fetch，不走 SDK）===== */
async function askClaudeForQuiz(imageBufs) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY 未設定');
  const content = imageBufs.slice(0, MAX_IMGS).map(b => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: b.toString('base64') },
  }));
  content.push({ type: 'text', text: PROMPT });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 170000); // 出題比讀收據久，給到近 3 分鐘
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 32000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content }],
      }),
    });
    if (!r.ok) throw new Error('anthropic http ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    // 實際花費記進日誌（Sonnet 5：輸入 $2、輸出 $10 / 每百萬 token；匯率抓 32）
    const u = j.usage || {};
    const usd = ((u.input_tokens || 0) * 2 + (u.output_tokens || 0) * 10) / 1e6;
    console.log(`[exam] AI 用量 照片${imageBufs.length}張 輸入${u.input_tokens || 0} 輸出${u.output_tokens || 0} ≈ US$${usd.toFixed(3)} ≈ NT$${(usd * 32).toFixed(1)}`);
    if (j.stop_reason === 'max_tokens') throw new Error('題目太多被截斷，請分兩次拍');
    const block = (j.content || []).find(c => c.type === 'text');
    if (!block) throw new Error('模型沒有回文字');
    return block.text;
  } finally { clearTimeout(timer); }
}

/**
 * 出題主流程（一對一、群組共用）。
 * @param bufs 照片
 * @param notifyTo 出錯或「不是課本」時通知誰（群組 ID 或個人 userId）
 * @returns 出好的 paper，失敗回 null
 */
async function runExam(bufs, notifyTo) {
  let paper;
  try {
    const raw = await askClaudeForQuiz(bufs);
    const clean = String(raw).replace(/```json/g, '').replace(/```/g, '').trim();
    const j = JSON.parse(clean);
    if (j.notTextbook) {
      const many = bufs.length > 1 ? '這些' : '這張';
      await push(notifyTo, text(`🤔 ${many}照片看起來不是課本或講義${j.reason ? '（' + String(j.reason).slice(0, 40) + '）' : ''}，所以沒有出題。\n要出考卷請拍課本、講義或習題，整頁入鏡。`));
      return null;
    }
    if (!j.bank || !j.bank.length) throw new Error('題庫是空的');
    paper = {
      id: `${j.subject || 'x'}-${Date.now().toString(36)}`.replace(/[^\w.-]/g, ''),
      subject: j.subject || '未分類', title: j.title || '未命名考卷',
      unit: j.unit || '', parts: j.parts || null, bank: j.bank,
      assigned: '', status: '待審核',
    };
    await X.savePaper(paper);
  } catch (e) {
    console.error('[exam] 出題失敗', e.message);
    await push(notifyTo, text('😅 出題失敗了，可能是照片太模糊或只拍到半頁。麻煩整頁重拍一次。'));
    return null;
  }

  papersPending.set(paper.id, { paper, ts: Date.now() });
  const quick = [
    qrPostback('✅ 上架', `exam_pub|${paper.id}`),
    qrPostback('🔄 重出', `exam_redo|${paper.id}`),
    qrPostback('🗑 丟掉', `exam_drop|${paper.id}`),
  ];
  await push(parentId() || notifyTo, text(
    `📝 新考卷待審核\n\n${paper.title}\n${paper.subject}・${paper.unit || '—'}\n題庫 ${paper.bank.length} 題（出自 ${bufs.length} 張照片）\n\n`
    + `第一題長這樣：\n${String(paper.bank[0].s).slice(0, 60)}\n\n👇 看過沒問題就上架：`, quick));
  return paper;
}

/** 共用的「能不能出題」檢查。可以就佔掉一個名額並回 true；不行就 reply 原因回 false。 */
async function claimSlot(ev) {
  if (DAILY_MAX === 0) {
    await reply(ev.replyToken, text('📚 收到！出考卷由爸爸處理：照片留在群組就好，爸爸會幫你出好上架。'));
    return false;
  }
  if (busy) { await reply(ev.replyToken, text('⏳ 上一份還在出題中，等它好了再試一次。')); return false; }
  if (!takeQuota()) { await reply(ev.replyToken, text(`今天已經出了 ${DAILY_MAX} 份考卷，明天再來 🙏`)); return false; }
  busy = true;
  return true;
}

/* ===== 2a. 一對一：按下「這是考試範圍」→ 出題 ===== */
async function makeExam(ev, p) {
  const bufs = (p.examBufs && p.examBufs.length) ? p.examBufs : (p.rawBuf ? [p.rawBuf] : []);
  if (!bufs.length) return reply(ev.replyToken, text('沒有待處理的照片，請重拍一次 🙏'));
  if (!(await claimSlot(ev))) return;
  try {
    // replyToken 約一分鐘就過期，出題一定來不及 → 先 reply 佔位，結果走 push
    await reply(ev.replyToken, text(`⏳ 收到 ${bufs.length} 張，正在出題，大約一到兩分鐘，好了會通知。`));
    const uid = ev.source && ev.source.userId;
    const paper = await runExam(bufs, uid);
    if (paper && parentId() && parentId() !== uid) {
      await push(uid, text('✅ 題目出好了，已經送給爸爸看過，上架後就能開始考。'));
    }
  } finally { busy = false; }
}

/* ===== 2b. 家庭群組：照片先靜靜記下來，等有人打「出考卷」===== */
function onGroupImage(ev) {
  const src = ev.source || {};
  if (!src.groupId || src.groupId !== groupId()) return;   // 只認家庭群組
  const key = src.groupId + ':' + (src.userId || 'anon');
  let box = groupBuf.get(key);
  if (!box || Date.now() - box.ts > BUF_TTL) box = { ids: [], ts: Date.now() };
  box.ids.push(ev.message.id);
  if (box.ids.length > MAX_IMGS) box.ids.shift();            // 只留最近 8 張
  box.ts = Date.now();
  groupBuf.set(key, box);
}
async function makeExamFromGroup(ev) {
  const src = ev.source || {};
  if (src.groupId !== groupId()) {
    await reply(ev.replyToken, text('這個群組沒有開通出考卷。'));
    return;
  }
  const key = src.groupId + ':' + (src.userId || 'anon');
  const box = groupBuf.get(key);
  const ids = box && Date.now() - box.ts <= BUF_TTL ? box.ids.slice() : [];
  if (!ids.length) {
    await reply(ev.replyToken, text(
      `📚 先把講義照片傳到群組，再打「出考卷」。\n\n・要在 30 分鐘內打\n・一次最多 ${MAX_IMGS} 張\n・只會用「你自己」剛傳的照片`));
    return;
  }
  if (!(await claimSlot(ev))) return;
  groupBuf.delete(key);
  try {
    await reply(ev.replyToken, text(`⏳ 收到 ${ids.length} 張，出題中（約一到兩分鐘），出好會先給爸爸審核。`));
    const bufs = [];
    for (const id of ids) {
      try { bufs.push(await getLineImage(id)); } catch (e) { console.error('[exam] 群組照片下載失敗', e.message); }
    }
    if (!bufs.length) {
      refundQuota();   // 沒呼叫 AI，不算名額
      await push(src.groupId, text('😅 照片下載失敗，請重傳一次再打「出考卷」。'));
      return;
    }
    await runExam(bufs, src.groupId);
  } finally { busy = false; }
}

/* ===== 3. Jason 按上架 → 發作答連結，並在群組公告 ===== */
async function publishExam(ev, paperId) {
  const hit = papersPending.get(paperId);
  if (hit) { await X.setPaperStatus(hit.paper, '已上架'); papersPending.delete(paperId); }
  const title = hit ? hit.paper.title : '考卷';
  let url = '';
  try { url = X.examUrl(STUDENT); } catch (e) { /* 簽章金鑰沒設 */ }
  if (!url || !process.env.EXAM_WEB_BASE) {
    return reply(ev.replyToken, text('✅ 已上架。（作答網址還沒設定好，設定完成後連結才會出現）'));
  }
  await reply(ev.replyToken, text(`✅ 已上架：${title}`, [qrUri('開始作答', url)]));
  // 群組公告 1 則，讓小朋友看得到（群裡幾個人都只算 1 則）
  if (groupId() && hit) {
    await push(groupId(), text(`📚 新考卷上架了\n${title}（${hit.paper.bank.length} 題）\n\n${STUDENT_NAME} 👇 點下面開始作答：`, [qrUri('開始作答', url)]));
  }
}

/* ===== 4. 交卷後回報成績（由 exam-routes 在寫入成功後呼叫）===== */
routes.onSubmitted = async function (rec) {
  const to = groupId() || parentId();
  if (!to) return;
  const t = X.tierOf(rec.score);
  await push(to, text(
    `${t.emoji} ${X.displayName(rec.student)} 交卷了\n${rec.title}\n${rec.score} 分・${t.name}（答對 ${rec.right}/${rec.total}）`));
};

/* ===== 5. 每晚七點推週曆 ===== */
async function pushWeeklyBoard() {
  const to = groupId() || parentId();
  if (!to) { console.warn('[exam] 週曆略過：EXAM_GROUP_ID / EXAM_PARENT_ID 都沒設'); return; }
  const attempts = await X.listAttempts(STUDENT);
  const board = X.weekBoard(attempts);
  let body = X.weekBoardText(board, STUDENT_NAME);
  const todayDone = board.find(d => d.today && d.score != null);
  if (!todayDone && process.env.EXAM_WEB_BASE) {
    try { body += '\n\n今天還沒作答，快去考一張 👉 ' + X.examUrl(STUDENT); } catch (e) { /* 金鑰沒設 */ }
  }
  await push(to, text(body));
}
/**
 * 排程。本專案沒有裝 node-cron，用內建計時器：每分鐘看一次台灣時間，
 * 到 19:00 且今天還沒推過就推。Railway 不論 TZ 設成什麼都對，因為時間是自己換算的。
 */
function scheduleWeeklyBoard() {
  let lastPushedDay = '';
  setInterval(async () => {
    const tw = new Date(Date.now() + 8 * 3600e3);          // 台灣時間
    const day = tw.toISOString().slice(0, 10);
    if (tw.getUTCHours() !== 19 || day === lastPushedDay) return;
    lastPushedDay = day;
    try { await pushWeeklyBoard(); } catch (e) { console.error('[exam] 週曆推播失敗', e.message); }
  }, 60e3);
  console.log('[exam] 週曆排程已掛上（台灣時間每天 19:00）');
}

/* ===== 6. postback 分派 =====
   ⚠️ 必須插在 index.js 取 pending 之前。JR 的 postback 一進來就 pending.get(pid)，
      查不到會直接回「這筆逾時了」，考卷的按鈕會被吃掉。 */
async function handlePostback(ev, deps = {}) {
  const data = (ev.postback && ev.postback.data) || '';
  if (!data.startsWith('exam_')) return false;
  const [act, arg] = data.split('|');

  if (act === 'exam_make') {
    const p = deps.pending && deps.pending.get(arg);
    if (!p) { await reply(ev.replyToken, text('這張照片逾時了，請重拍一次 🙏')); return true; }
    if (deps.pending) deps.pending.delete(arg);
    await makeExam(ev, p);
    return true;
  }
  // 審核三顆按鈕只給爸爸按（卡片只推給爸爸，這裡再擋一層）
  if (!isParent(ev)) {
    await reply(ev.replyToken, text('這顆按鈕只有爸爸能按喔 🙂'));
    return true;
  }
  if (act === 'exam_pub')  { await publishExam(ev, arg); return true; }
  if (act === 'exam_redo') {
    papersPending.delete(arg);
    await reply(ev.replyToken, text('好，請重新拍一次照片，我再出一份新的。'));
    return true;
  }
  if (act === 'exam_drop') {
    const hit = papersPending.get(arg);
    if (hit) { try { await X.setPaperStatus(hit.paper, '已下架'); } catch (e) { console.error('[exam] 下架失敗', e.message); } }
    papersPending.delete(arg);
    await reply(ev.replyToken, text('已丟掉，這份不會出現在考卷清單。'));
    return true;
  }
  return false;
}

/* ===== 7. 文字指令 ===== */
async function handleText(ev, t) {
  const s = String(t || '').trim();
  const src = ev.source || {};

  if (s === '出考卷') {
    if (!src.groupId) {
      await reply(ev.replyToken, text('在這裡直接傳課本照片給我就好，我會問你要不要出成考卷 📚'));
      return true;
    }
    await makeExamFromGroup(ev);
    return true;
  }

  // 把 bot 拉進家庭群組後，在群裡打這個就拿得到 ID
  if (s === '群組id' || s === '群組ID' || s === 'groupid') {
    const id = src.groupId || src.roomId || '';
    if (!id) { await reply(ev.replyToken, text('這裡不是群組。請在家庭群組裡打「群組id」。')); return true; }
    await reply(ev.replyToken, text(
      `這個${src.groupId ? '群組' : '聊天室'}的 ID：\n${id}\n\n把整串貼給 Claude，設定完成後每晚七點的獎章週曆就會推到這裡。`));
    return true;
  }

  // 設定 EXAM_PARENT_ID 用：審核卡片要推給爸爸，得先知道他的 userId
  if (s === '我的id' || s === '我的ID' || s === 'myid') {
    const id = src.userId || '';
    await reply(ev.replyToken, id
      ? text(`你的 userId：\n${id}\n\n把整串貼給 Claude，之後出好的考卷會先送給你審核。`)
      : text('抓不到你的 ID，請在一對一聊天裡再打一次。'));
    return true;
  }

  if (s === '考卷' || s === '作答' || s === '考試') {
    if (!process.env.EXAM_WEB_BASE) { await reply(ev.replyToken, text('考卷網頁還沒設定好，晚點再試 🙏')); return true; }
    try {
      await reply(ev.replyToken, text(`📚 ${STUDENT_NAME} 的考卷中心`, [qrUri('開始作答', X.examUrl(STUDENT))]));
    } catch (e) { await reply(ev.replyToken, text('作答連結還沒設定好。')); }
    return true;
  }

  if (s === '獎章' || s === '週曆') {
    try {
      const attempts = await X.listAttempts(STUDENT);
      await reply(ev.replyToken, text(X.weekBoardText(X.weekBoard(attempts), STUDENT_NAME)));
    } catch (e) {
      console.error('[exam] 週曆查詢失敗', e.message);
      await reply(ev.replyToken, text('查不到成績，等一下再試 🙏'));
    }
    return true;
  }
  return false;
}

/** 給 index.js 的「認不出」卡片用 */
const examQuickButton = pid => qrPostback('📚 這是考試範圍', `exam_make|${pid}`);

module.exports = {
  handlePostback, handleText, examQuickButton, onGroupImage,
  scheduleWeeklyBoard, pushWeeklyBoard, makeExam, runExam,
  papersPending, groupBuf, quotaLeft, STUDENT, STUDENT_NAME,
};
