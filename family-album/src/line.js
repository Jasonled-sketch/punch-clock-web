// LINE 機器人。省額度原則：家人先開口的都用 reply（免費）；只有「回顧影片做好了」這種主動通知才用 push（群組 1 則）。
import crypto from 'node:crypto';
import { config, mediaUrl, albumUrl } from './config.js';
import { kv } from './db.js';
import { ingest } from './ingest.js';
import { sniff } from './media.js';
import { parseQuery } from './vision.js';
import { searchPhotos, stats, onThisDay } from './search.js';
import { peopleList, pendingClusters } from './people.js';
import { makeRecapOnce, readyRecap, periodTitle } from './recap.js';
import { parts, prevMonth, zhDate, zhMonth } from './time.js';
import { backupToDrive } from './drive.js';

const L = config.line;
const auth = () => ({ Authorization: `Bearer ${L.token}` });

export function verifySignature(rawBody, signature) {
  if (!L.secret || !signature) return false;
  const mac = crypto.createHmac('sha256', L.secret).update(rawBody).digest('base64');
  const a = Buffer.from(mac), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function api(pathname, body) {
  const res = await fetch(L.apiBase + pathname, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`LINE ${pathname} ${res.status}：${(await res.text()).slice(0, 200)}`);
}
export const reply = (replyToken, messages) => api('/v2/bot/message/reply', { replyToken, messages: [].concat(messages).slice(0, 5) });
export const push = (to, messages) => api('/v2/bot/message/push', { to, messages: [].concat(messages).slice(0, 5) });
const text = t => ({ type: 'text', text: String(t).slice(0, 4900) });

/** 下載家人傳來的照片/影片。影片要等 LINE 轉檔完才抓得到 */
async function fetchContent(messageId, isVideo) {
  if (isVideo) {
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${L.dataBase}/v2/bot/message/${messageId}/content/transcoding`, { headers: auth() });
      const s = r.ok ? (await r.json()).status : 'succeeded';
      if (s === 'succeeded') break;
      if (s === 'failed') throw new Error('LINE 影片轉檔失敗');
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  const res = await fetch(`${L.dataBase}/v2/bot/message/${messageId}/content`, { headers: auth() });
  if (!res.ok) throw new Error(`下載內容失敗 ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const nameCache = new Map();
async function displayName(source) {
  const uid = source.userId;
  if (!uid) return null;
  if (nameCache.has(uid)) return nameCache.get(uid);
  const url = source.type === 'group' ? `/v2/bot/group/${source.groupId}/member/${uid}`
    : source.type === 'room' ? `/v2/bot/room/${source.roomId}/member/${uid}` : `/v2/bot/profile/${uid}`;
  try {
    const res = await fetch(L.apiBase + url, { headers: auth() });
    const name = res.ok ? (await res.json()).displayName : null;
    nameCache.set(uid, name);
    return name;
  } catch { return null; }
}

// ---- 只服務自家人：來源（群組或個人）要先綁定 ----
const sourceKey = s => s.groupId || s.roomId || s.userId;
function isAllowed(key) {
  return L.allowed.includes(key) || kv.get('line.allowed', []).includes(key);
}
function bind(key) {
  const list = kv.get('line.allowed', []);
  if (!list.includes(key)) { list.push(key); kv.set('line.allowed', list); }
}
/** 月度回顧要推給誰：環境變數優先，否則用第一個綁定的群組 */
export function familyTarget() {
  return L.familyGroupId || kv.get('line.allowed', []).find(k => /^[CR]/.test(k)) || kv.get('line.allowed', [])[0] || L.allowed[0] || null;
}

// ---- 一批照片只回一則「收到 N 張」----
const batches = new Map();
function batchOf(key) {
  if (!batches.has(key)) batches.set(key, { added: 0, dup: 0, failed: 0, videos: 0, pending: 0, unknown: 0, names: new Map(), months: new Set(), token: null, timer: null, deadline: null });
  return batches.get(key);
}
function scheduleAck(key) {
  const b = batchOf(key);
  clearTimeout(b.timer);
  b.timer = setTimeout(() => { if (b.pending === 0) flushAck(key); }, L.ackQuietMs);
  if (!b.deadline) b.deadline = setTimeout(() => flushAck(key), L.ackDeadlineMs); // replyToken 過期前一定要回
}
async function flushAck(key) {
  const b = batches.get(key);
  if (!b) return;
  clearTimeout(b.timer); clearTimeout(b.deadline);
  batches.delete(key);
  if (!b.token || b.added + b.dup + b.failed + b.pending === 0) return;
  const lines = [];
  if (b.added) lines.push(`📥 收到 ${b.added} ${b.videos === b.added ? '支影片' : '張'}，已歸到 ${[...b.months].sort().map(zhMonth).join('、')}`);
  if (b.pending) lines.push(`⏳ 還有 ${b.pending} 張整理中`);
  if (b.names.size) lines.push('👨‍👩‍👧 ' + [...b.names].map(([n, c]) => `${n}×${c}`).join('　'));
  if (b.dup) lines.push(`♻️ ${b.dup} 張之前傳過了，沒有重複存`);
  if (b.failed) lines.push(`⚠️ ${b.failed} 個檔案讀不了`);
  if (b.unknown) lines.push(`🙋 有 ${b.unknown} 張臉我還不認識，告訴我是誰：\n${albumUrl('who')}`);
  try { await reply(b.token, text(lines.join('\n'))); } catch (e) { console.error('[line] 回覆收件摘要失敗（不影響存檔）：', e.message); }
}

async function handleMedia(ev, key) {
  const m = ev.message;
  const b = batchOf(key);
  b.token = ev.replyToken; b.pending++;
  scheduleAck(key);
  try {
    if (m.contentProvider && m.contentProvider.type !== 'line') throw new Error('外部連結的圖片不收');
    const isVideo = m.type === 'video';
    const buffer = await fetchContent(m.id, isVideo);
    if (m.type === 'file' && !['jpeg', 'png', 'webp', 'heic', 'avif', 'video'].includes(sniff(buffer))) return; // 不是照片的檔案就當沒看到
    const uploader = await displayName(ev.source);
    const r = await ingest({ buffer, source: 'line', sourceRef: m.id, uploader, uploaderId: ev.source.userId, fallbackTime: ev.timestamp, fallbackSrc: 'upload', keepOriginal: true });
    if (r.status === 'added') {
      b.added++; b.months.add(r.ym); b.unknown += r.unknownFaces;
      if (r.kind === 'video') b.videos++;
      for (const n of r.names) b.names.set(n, (b.names.get(n) || 0) + 1);
      backupToDrive(r.id).catch(e => console.error('[drive] 備份失敗：', e.message));
    } else b.dup++;
  } catch (e) {
    b.failed++;
    console.error('[line] 收檔失敗：', e.message);
  } finally {
    b.pending--;
    if (b.pending === 0 && batches.get(key) === b) scheduleAck(key);
  }
}

// ---- 文字指令 ----
const HELP = `📒 家庭相簿小秘書
把照片、影片直接傳進來，我會自動歸檔、認人、寫註記。

可以這樣問我：
・相簿 → 打開相簿網頁
・找 妹妹 生日 → 找照片
・找 去年夏天 海邊
・那年今日
・統計（或 統計 2026-10）
・回顧（上個月的影片）／回顧 2026-10／回顧 2026
・認人 → 告訴我照片裡是誰`;

const COMMAND = /^(相簿|找|搜尋|那年今日|統計|回顧|認人|小秘書|說明|幫助|help)/i;

function photoCarousel(rows, title) {
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'carousel',
      contents: rows.slice(0, 10).map(p => ({
        type: 'bubble', size: 'kilo',
        hero: { type: 'image', url: mediaUrl('display', p.id), size: 'full', aspectMode: 'cover', aspectRatio: '1:1',
          action: { type: 'uri', uri: albumUrl(`p/${p.id}`) } },
        body: { type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '12px', contents: [
          { type: 'text', text: zhDate(p.taken_at), size: 'xs', color: '#8a8a8a' },
          { type: 'text', text: p.caption || (p.kind === 'video' ? '影片' : '照片'), size: 'sm', wrap: true, maxLines: 2 }
        ] }
      }))
    }
  };
}

function resolvePeriod(arg) {
  const now = parts(Date.now());
  arg = arg.trim();
  let m;
  if (!arg || /上個?月/.test(arg)) return prevMonth();
  if (/這個?月|本月/.test(arg)) return `${now.y}-${String(now.m).padStart(2, '0')}`;
  if (/今年/.test(arg)) return String(now.y);
  if (/去年/.test(arg)) return String(now.y - 1);
  if ((m = arg.match(/(20\d{2})\s*[-\/年.]\s*(\d{1,2})/))) return `${m[1]}-${String(+m[2]).padStart(2, '0')}`;
  if ((m = arg.match(/^(20\d{2})\s*年?$/))) return m[1];
  if ((m = arg.match(/^(\d{1,2})\s*月$/))) { // 「10月」→ 最近一次的 10 月
    const mm = +m[1];
    return `${mm > now.m ? now.y - 1 : now.y}-${String(mm).padStart(2, '0')}`;
  }
  return null;
}
const recapMessages = r => [
  text(`🎬 ${r.title}（${r.photo_count ?? r.photoCount} 張精選）`),
  { type: 'video', originalContentUrl: mediaUrl('recap', r.period), previewImageUrl: mediaUrl('recapposter', r.period) }
];

async function handleText(ev, key) {
  const raw = ev.message.text.trim();
  const isGroup = ev.source.type !== 'user';
  if (isGroup && !COMMAND.test(raw)) return; // 群組裡家人聊天不插嘴，只回指令
  const cmd = raw.replace(/^小秘書[\s,，:：]*/, '');

  if (!cmd || /^(說明|幫助|help)$/i.test(cmd)) return reply(ev.replyToken, text(HELP));
  if (/^相簿/.test(cmd)) return reply(ev.replyToken, text(`📒 我們家的相簿：\n${albumUrl()}`));
  if (/^認人/.test(cmd)) {
    const n = pendingClusters(200).reduce((s, c) => s + c.count, 0);
    return reply(ev.replyToken, text(n ? `🙋 還有 ${n} 張臉等你告訴我是誰：\n${albumUrl('who')}` : '👍 目前的臉我都認得了'));
  }
  if (/^那年今日/.test(cmd)) {
    const now = parts(Date.now());
    const rows = onThisDay(`${String(now.m).padStart(2, '0')}-${String(now.d).padStart(2, '0')}`, now.y);
    return reply(ev.replyToken, rows.length ? [text(`🕰 往年的今天（${now.m}/${now.d}）`), photoCarousel(rows, '那年今日')] : text('往年的今天還沒有照片 📭'));
  }
  if (/^統計/.test(cmd)) {
    const arg = cmd.replace(/^統計/, '').trim();
    const period = arg ? resolvePeriod(arg) : null;
    const ym = period && period.length === 7 ? period : null;
    const s = stats(ym);
    const lines = [`📊 ${ym ? zhMonth(ym) : '全部'}：${s.total} 個檔案${s.videos ? `（其中影片 ${s.videos}）` : ''}`];
    if (s.people.length) lines.push('👨‍👩‍👧 ' + s.people.map(p => `${p.name} ${p.n}`).join('　'));
    if (s.events.length) lines.push('🏷 ' + s.events.map(e => `${e.name} ${e.n}`).join('　'));
    if (s.pendingFaces) lines.push(`🙋 待認的臉 ${s.pendingFaces} 張`);
    return reply(ev.replyToken, text(lines.join('\n')));
  }
  if (/^回顧/.test(cmd)) {
    const period = resolvePeriod(cmd.replace(/^回顧/, ''));
    if (!period) return reply(ev.replyToken, text('要哪一段呢？例：回顧 2026-10、回顧 10月、回顧 2026'));
    const have = readyRecap(period);
    if (have && !/重做/.test(cmd)) return reply(ev.replyToken, recapMessages(have)); // 已經做好的直接回（免費）
    await reply(ev.replyToken, text(`🎬 開始製作${periodTitle(period)}回顧，大約 1～2 分鐘，做好會傳到這裡。`));
    makeRecapOnce(period)
      .then(r => push(key, recapMessages({ ...r, photo_count: r.photoCount })))
      .catch(e => push(key, text(`😢 回顧沒做成：${e.message}`)).catch(() => {}));
    return;
  }

  // 「找 …」或私訊裡的任何一句話 → 交給 AI 聽懂意思
  const query = cmd.replace(/^(找|搜尋)\s*/, '');
  const f = await parseQuery(query, peopleList().map(p => p.name));
  if (f.intent === 'chat') return reply(ev.replyToken, text(f.reply || HELP));
  if (f.intent === 'recap') return handleText({ ...ev, message: { ...ev.message, text: `回顧 ${f.from ? f.from.slice(0, 7) : ''}` } }, key);
  const res = searchPhotos({ people: f.people, from: f.from, to: f.to, keywords: f.keywords, limit: 10 });
  if (f.intent === 'stats') {
    return reply(ev.replyToken, text(`📊 符合的有 ${res.total} 張${f.people.length ? `（${f.people.join('、')}）` : ''}`));
  }
  if (!res.total) return reply(ev.replyToken, text(`找不到符合「${query}」的照片 🔍\n（剛傳的照片要等幾分鐘，AI 寫完註記才搜得到）`));
  const cond = [f.people.join('、'), f.from && `${f.from}~${f.to || ''}`, f.keywords.join('/')].filter(Boolean).join('｜');
  return reply(ev.replyToken, [
    text(`🔍 找到 ${res.total} 張${cond ? `（${cond}）` : ''}${res.total > 10 ? `，先看最新 10 張，全部在這：\n${albumUrl('s/' + encodeURIComponent(query))}` : ''}`),
    photoCarousel(res.rows, `找到 ${res.total} 張照片`)
  ]);
}

export async function handleEvent(ev) {
  const key = sourceKey(ev.source || {});
  if (!key) return;
  const txt = ev.type === 'message' && ev.message.type === 'text' ? ev.message.text.trim() : '';

  // 綁定：在群組（或私訊）打「綁定 通行碼」，之後這個群組傳的照片才會收
  if (/^綁定\s+\S+/.test(txt)) {
    if (txt.split(/\s+/)[1] === config.albumToken) {
      bind(key);
      return reply(ev.replyToken, text(`✅ 綁定完成！之後把照片、影片傳到這裡就會自動整理。\n（為了安全，建議把剛剛那則含通行碼的訊息收回）\n\n${HELP}`));
    }
    return reply(ev.replyToken, text('通行碼不對喔'));
  }
  if (!isAllowed(key)) {
    // 還沒綁定的來源：不收照片、不回答相簿內容
    if (ev.type === 'join' || ev.type === 'follow' || /^(群組id|group\s*id|相簿|說明|小秘書)/i.test(txt)) {
      return reply(ev.replyToken, text('👋 我是家庭相簿小秘書。\n這裡還沒綁定，請家裡的管理員在這裡輸入：\n綁定 <相簿通行碼>'));
    }
    return;
  }
  if (ev.type === 'join') return reply(ev.replyToken, text(HELP));
  if (ev.type !== 'message') return;
  if (/^(群組id|group\s*id)$/i.test(txt)) return reply(ev.replyToken, text(`本聊天室 ID：\n${key}`));
  if (['image', 'video', 'file'].includes(ev.message.type)) return handleMedia(ev, key);
  if (ev.message.type === 'text') return handleText(ev, key);
}

/** 每月自動回顧：做好後推一則到家庭群組（群組推播不論幾人都只算 1 則） */
export async function pushRecap(period) {
  const to = familyTarget();
  if (!to) throw new Error('還沒有綁定任何 LINE 群組');
  const r = await makeRecapOnce(period);
  await push(to, recapMessages({ ...r, photo_count: r.photoCount }));
  return r;
}
