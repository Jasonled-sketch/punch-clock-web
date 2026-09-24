'use strict';
/**
 * LINE 這一側：收課本照片 → 出題 → 審核卡片 → 上架 → 發作答連結，
 * 以及每天晚上七點推週曆獎章。
 *
 * 省額度原則（照 line-quota-saving）：
 *   小朋友傳照片、按按鈕 → 一律用 reply，免費。
 *   只有「出題太久超過 reply 時限」與「晚上七點週曆」才用 push。
 *   週曆推到群組，不論群裡幾人都只算 1 則。
 */
const X = require('./exam-module');
const routes = require('./exam-routes');
const fs = require('fs');
const path = require('path');

const PROMPT = fs.readFileSync(path.join(__dirname, 'prompt-quiz.txt'), 'utf8');
const GROUP_ID  = process.env.EXAM_GROUP_ID;
const PARENT_ID = process.env.EXAM_PARENT_ID;

/** 暫存：等 Jason 按上架的卷。重開機會掉，屆時請小朋友重傳。 */
const pending = new Map();
/** 暫存：小朋友剛傳、還沒按「這是考試範圍」的照片 */
const inbox = new Map();

/* ========== 1. 分類卡片加第四顆按鈕 ==========
   在現有「其他」分類卡片的 actions 陣列裡，把這顆放第一個。
   AI 已經判斷是課本／講義時，這顆就是最可能的選擇。 */
function examButton(imageKey) {
  return { type:'postback', label:'📚 這是考試範圍', data:`exam_make&k=${imageKey}` };
}

/* ========== 2. 收到圖片 ==========
   接在現有 image 事件處理流程裡：AI 讀完內容、判斷是課本/講義時呼叫。 */
async function onTextbookImage(ev, client, buffer, aiSummary) {
  const key = ev.source.userId + ':' + ev.message.id;
  const cur = inbox.get(ev.source.userId) || { images: [], at: Date.now() };
  cur.images.push(buffer);
  cur.at = Date.now();
  inbox.set(ev.source.userId, cur);
  return client.replyMessage({
    replyToken: ev.replyToken,
    messages: [{
      type:'template', altText:'這張是什麼？',
      template:{
        type:'buttons',
        text:`看起來是：${(aiSummary||'課本內容').slice(0,50)}\n已收 ${cur.images.length} 張`,
        actions:[
          examButton(ev.source.userId),
          { type:'postback', label:'行程',  data:'other_schedule' },
          { type:'postback', label:'支出',  data:'other_expense' },
          { type:'postback', label:'算了',  data:'other_cancel' }
        ]
      }
    }]
  });
}

/* ========== 3. 按下「這是考試範圍」→ 出題 ========== */
async function onMakeExam(ev, client, askClaudeVision) {
  const uid = ev.source.userId;
  const box = inbox.get(uid);
  if (!box || !box.images.length) {
    return client.replyMessage({ replyToken: ev.replyToken,
      messages:[{ type:'text', text:'沒有待處理的照片，請重新拍一次。' }] });
  }
  // reply token 約一分鐘就過期，出題一定來不及，所以先 reply 再 push（只花 1 則）
  await client.replyMessage({ replyToken: ev.replyToken,
    messages:[{ type:'text', text:`⏳ 收到 ${box.images.length} 張，正在出題，大約一分鐘。` }] });
  inbox.delete(uid);

  let paper;
  try {
    const raw = await askClaudeVision(PROMPT, box.images);   // 回傳字串
    const clean = String(raw).replace(/```json|```/g, '').trim();  // Claude 常常包圍欄
    const j = JSON.parse(clean);
    if (!j.bank || !j.bank.length) throw new Error('題庫是空的');
    paper = {
      id: `${(j.subject||'x')}-${Date.now().toString(36)}`.replace(/[^\w.-]/g, ''),
      subject: j.subject || '未分類', title: j.title || '未命名考卷',
      unit: j.unit || '', parts: j.parts || null, bank: j.bank,
      assigned: X.isoDay(), status: '待審核'
    };
    await X.savePaper(paper);
  } catch (e) {
    console.error('[exam] 出題失敗', e);
    return client.pushMessage({ to: uid,
      messages:[{ type:'text', text:'出題失敗了，可能是照片太模糊或只拍到半頁。麻煩整頁重拍一次。' }] });
  }

  pending.set(paper.id, paper);
  const card = {
    type:'template', altText:`新考卷待審核：${paper.title}`,
    template:{ type:'buttons', title:`📝 ${paper.title}`.slice(0,40),
      text:`${paper.subject} · ${paper.unit || '—'}\n題庫 ${paper.bank.length} 題\n出自 ${box.images.length} 張照片`.slice(0,60),
      actions:[
        { type:'postback', label:'✅ 上架', data:`exam_pub&id=${paper.id}` },
        { type:'postback', label:'🔄 重出', data:`exam_redo&id=${paper.id}` },
        { type:'postback', label:'🗑 丟掉', data:`exam_drop&id=${paper.id}` }
      ] }
  };
  return client.pushMessage({ to: PARENT_ID || uid, messages:[card] });
}

/* ========== 4. Jason 按上架 → 發作答連結 ========== */
async function onPublish(ev, client, paperId) {
  const paper = pending.get(paperId);
  if (paper) { await X.setPaperStatus(paper, '已上架'); pending.delete(paperId); }
  const url = X.examUrl(process.env.EXAM_STUDENT_ID || 'kid');
  return client.replyMessage({ replyToken: ev.replyToken, messages:[{
    type:'template', altText:'新考卷上架了',
    template:{ type:'buttons', title:'📚 新考卷上架', text:`${paper ? paper.title : '考卷'}\n點下面開始作答`,
      actions:[{ type:'uri', label:'開始作答', uri:url }] }
  }] });
}

/* ========== 5. 交卷後回報成績（reply 車道之外，用群組 1 則） ========== */
routes.onSubmitted = async function (rec) {
  if (!GROUP_ID || !global.lineClient) return;
  const t = X.tierOf(rec.score);
  await global.lineClient.pushMessage({ to: GROUP_ID, messages:[{
    type:'text',
    text:`${t.emoji} ${rec.student} 交卷了\n${rec.title}\n${rec.score} 分 · ${t.name}（答對 ${rec.right}/${rec.total}）`
  }]});
};

/* ========== 6. 每天晚上七點推週曆 ========== */
function scheduleWeeklyBoard(client, cron) {
  // 台灣時間 19:00。Railway 預設 UTC，所以寫 0 11 * * *；
  // 若容器已設 TZ=Asia/Taipei 就改成 0 19 * * *。部署後用日誌確認實際觸發時間。
  cron.schedule('0 11 * * *', async () => {
    try {
      const student = process.env.EXAM_STUDENT_ID || 'kid';
      const attempts = await X.listAttempts(student);
      const board = X.weekBoard(attempts);
      const text = X.weekBoardText(board, student);
      const todayDone = board.find(d => d.today && d.score != null);
      const tail = todayDone ? '' : '\n\n今天還沒作答，快去考一張 👉 ' + X.examUrl(student);
      if (GROUP_ID) await client.pushMessage({ to: GROUP_ID, messages:[{ type:'text', text: text + tail }] });
    } catch (e) { console.error('[exam] 週曆推播失敗', e); }
  });
  console.log('[exam] 週曆排程已掛上');
}

/* ========== 7. postback 分派 ==========
   接進現有 postback 處理：先比對 exam_ 開頭，不是就往下走原本的流程。 */
async function handlePostback(ev, client, deps = {}) {
  const data = ev.postback?.data || '';
  if (!data.startsWith('exam_')) return false;
  const id = (data.match(/id=([^&]+)/) || [])[1];
  if (data.startsWith('exam_make')) return !!(await onMakeExam(ev, client, deps.askClaudeVision));
  if (data.startsWith('exam_pub'))  return !!(await onPublish(ev, client, id));
  if (data.startsWith('exam_redo')) {
    await client.replyMessage({ replyToken: ev.replyToken,
      messages:[{ type:'text', text:'請重新拍一次照片，我再出一份新的。' }] });
    pending.delete(id); return true;
  }
  if (data.startsWith('exam_drop')) {
    const p = pending.get(id); if (p) await X.setPaperStatus(p, '已下架');
    pending.delete(id);
    await client.replyMessage({ replyToken: ev.replyToken, messages:[{ type:'text', text:'已丟掉。' }] });
    return true;
  }
  return false;
}

module.exports = { examButton, onTextbookImage, onMakeExam, onPublish, handlePostback, scheduleWeeklyBoard, pending, inbox };
