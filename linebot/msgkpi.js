// ═══════════════════════════════════════════════════════════════════════
//  msgkpi.js — 群組「訊息回覆 KPI」
//  誰回了老闆的訊息、多久回、是上班中回還是下班後回 → 每天結算成可考核的數字
//
//  設計重點（改碼前先看）：
//  1. LINE Messaging API **沒有** reaction(按讚) 事件，也**沒有**已讀 API。
//     群組拿得到的只有 message / postback / edit / unsend / join / leave。
//     所以「按讚率」抓不到，改用「收到」按鈕（message action → 送一則文字進群）替代。
//  2. 「收到」按鈕故意用 message action 不用 postback：
//     官方文件明講群組 source 的 userId「只在 message 事件帶」，postback 不保證有 userId。
//     message action 一定會回一個 message 事件 → userId 100% 拿得到 → 記名不會漏。
//     （postback 若真的有帶 userId 也照收，當備援）
//  3. 原始事件寫 Postgres（量大、免費），不寫 Ragic（有 API 額度，群組一天幾百則會爆）。
//     每日結算後的「一人一天一列」才進 msg_kpi_daily，給戰情牆 / 月報讀。
//  4. 上班 / 下班 用當事人**當天真實打卡區間**判定（check-in-system/3），
//     不是寫死 08:30–18:00。請假、加班、假日自然落在區間外＝下班後。
// ═══════════════════════════════════════════════════════════════════════

let pool = null, D = null, ready = false;

const CFG = {
  groupId:   () => process.env.MSGKPI_GROUP_ID || process.env.PUNCH_REMIND_GROUP_ID || '',
  windowMin: () => Number(process.env.MSGKPI_WINDOW_MIN || 120),   // 錨點後多久內的發言算「有回應」
  slaOn:     () => Number(process.env.MSGKPI_SLA_ON_MIN || 30),    // 上班中該多久內回
  slaOff:    () => Number(process.env.MSGKPI_SLA_OFF_MIN || 720),  // 下班後該多久內回（12h）
  keepDays:  () => Number(process.env.MSGKPI_KEEP_DAYS || 180),    // 原始發言保留天數
  storeText: () => process.env.MSGKPI_STORE_TEXT !== '0',          // 0=不存訊息內容，只存有無發言
  enabled:   () => process.env.MSGKPI_OFF !== '1'
};

// ── 台灣時間工具（與 index.js 同一套：UTC+8 後取 getUTC*）──
const pad = n => String(n).padStart(2, '0');
const twNow = (t = Date.now()) => new Date(t + 8 * 3600 * 1000);
const twDay = (t = Date.now()) => { const d = twNow(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const twMin = (t = Date.now()) => { const d = twNow(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hhmmMin = s => { const [h, m] = String(s || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };
const code36 = id => Number(id).toString(36).toUpperCase();

// ═══ 建表 ═══════════════════════════════════════════════════════════════
async function ensure() {
  if (ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS msg_anchor (
    id BIGSERIAL PRIMARY KEY,
    msg_id TEXT UNIQUE, group_id TEXT NOT NULL,
    asker_uid TEXT, asker_email TEXT, asker_name TEXT,
    kind TEXT NOT NULL, txt TEXT,
    targets JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS msg_ack (
    id BIGSERIAL PRIMARY KEY,
    anchor_id BIGINT NOT NULL, email TEXT NOT NULL, uid TEXT,
    via TEXT NOT NULL, lag_sec INT NOT NULL, on_duty BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(anchor_id, email))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS msg_raw (
    id BIGSERIAL PRIMARY KEY,
    msg_id TEXT, group_id TEXT, uid TEXT, email TEXT,
    kind TEXT, quoted TEXT, txt TEXT, on_duty BOOLEAN,
    unsent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS msg_kpi_daily (
    day DATE NOT NULL, email TEXT NOT NULL, name TEXT,
    required INT DEFAULT 0, acked INT DEFAULT 0,
    acked_hard INT DEFAULT 0, acked_soft INT DEFAULT 0,
    acked_on INT DEFAULT 0, acked_off INT DEFAULT 0, in_sla INT DEFAULT 0,
    median_lag INT, spoke INT DEFAULT 0,
    PRIMARY KEY(day, email))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS msg_raw_t ON msg_raw(created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS msg_anchor_t ON msg_anchor(created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS msg_ack_t ON msg_ack(created_at)`);
  ready = true;
}

// ═══ 員工 / 打卡快取（避免每則訊息都打 Ragic）═══════════════════════════
let _wc = { t: 0, list: [] };
async function workers() {
  if (Date.now() - _wc.t < 300000 && _wc.list.length) return _wc.list;
  try { _wc = { t: Date.now(), list: await D.punchRagicGet('check-in-system/2') }; } catch (e) { console.error('[msgkpi] 員工表讀取失敗:', e.message); }
  return _wc.list;
}
// 需要回應的人＝在職正職，排除管理者與測試號（管理者是發問方，不列考核）
const isTarget = w => w && w['啟用'] === '1' && w['員工類型'] === '正式員工' && !D.attIsMgr(w['Email']) && !D.attIsTestW(w);

async function byUid(uid) {
  if (!uid) return null;
  return (await workers()).find(w => (w['LINE userId'] || '').trim() === uid) || null;
}

let _rc = { t: 0, day: '', list: [] };
async function todayRecs() {
  const day = twDay();
  if (_rc.day === day && Date.now() - _rc.t < 120000) return _rc.list;
  try {
    const q = `&where=${D.ATT_FID.rec.date},gte,${day.replace(/-/g, '/')}`;
    const rows = await D.punchRagicGet('check-in-system/3', q);
    _rc = { t: Date.now(), day, list: rows.filter(r => r['狀態'] !== 'cancelled' && r['狀態'] !== 'deleted') };
  } catch (e) { console.error('[msgkpi] 打卡表讀取失敗:', e.message); }
  return _rc.list;
}

// 此刻這個人在不在自己的打卡區間內（開放中的班段＝現在還在上班）
async function onDuty(email, at = Date.now()) {
  const day = twDay(at).replace(/-/g, '/'), m = twMin(at);
  const mine = (await todayRecs()).filter(r => r['Email'] === email && String(r['日期'] || '').replace(/-/g, '/').startsWith(day));
  for (const r of mine) {
    const i = hhmmMin(r['上班時間']); if (i == null) continue;
    const o = hhmmMin(r['下班時間']);
    if (m >= i && (o == null || m <= o)) return true;
  }
  return false;
}

// ═══ 錨點判定 ═══════════════════════════════════════════════════════════
// 什麼樣的訊息算「需要人回」：
//   announce — bot 發的公告卡（掛「收到」按鈕），全體正職
//   mention  — 管理者 @ 了誰，只有被 @ 的人要回
//   keyword  — 管理者訊息含「收到請回/請回覆/請回報」或開頭 !，全體正職
//   manual   — 管理者在群裡打「!kpi <內容>」手動開一個錨點
const KEYWORD = /收到請回|請回覆|請回報|請確認|回覆一下|看到請回/;

async function allTargets() {
  return (await workers()).filter(isTarget).map(w => ({ email: w['Email'], name: w['姓名'] || w['Email'] }));
}

async function mkAnchor({ msgId, groupId, asker, kind, txt, targets }) {
  const r = await pool.query(
    `INSERT INTO msg_anchor (msg_id, group_id, asker_uid, asker_email, asker_name, kind, txt, targets)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (msg_id) DO NOTHING RETURNING id`,
    [msgId || null, groupId, asker?.uid || null, asker?.email || null, asker?.name || null,
     kind, CFG.storeText() ? String(txt || '').slice(0, 500) : null, JSON.stringify(targets)]);
  return r.rows[0]?.id || null;
}

// ═══ 回應登記 ═══════════════════════════════════════════════════════════
async function ack(anchorId, w, uid, via, at = Date.now()) {
  const a = (await pool.query(`SELECT created_at, targets FROM msg_anchor WHERE id=$1`, [anchorId])).rows[0];
  if (!a) return false;
  const targets = a.targets || [];
  if (targets.length && !targets.some(t => t.email === w['Email'])) return false;   // 不是他要回的，不記
  const lag = Math.max(0, Math.round((at - new Date(a.created_at).getTime()) / 1000));
  const duty = await onDuty(w['Email'], at);
  const r = await pool.query(
    `INSERT INTO msg_ack (anchor_id, email, uid, via, lag_sec, on_duty) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (anchor_id, email) DO NOTHING RETURNING id`,
    [anchorId, w['Email'], uid || null, via, lag, duty]);
  return !!r.rows[0];
}

// 時間窗內、這個人還沒回的錨點 → 一次全部記成已回應
async function ackOpen(w, uid, via, at = Date.now()) {
  const rows = (await pool.query(
    `SELECT a.id FROM msg_anchor a
     WHERE a.created_at > NOW() - ($1 || ' minutes')::interval
       AND NOT EXISTS (SELECT 1 FROM msg_ack k WHERE k.anchor_id=a.id AND k.email=$2)
     ORDER BY a.created_at DESC LIMIT 20`, [String(CFG.windowMin()), w['Email']])).rows;
  let n = 0;
  for (const r of rows) if (await ack(r.id, w, uid, via, at)) n++;
  return n;
}

// ═══ 事件入口（由 /webhook/attendance 的群組分支呼叫）═══════════════════
async function handleGroupEvent(ev) {
  if (!CFG.enabled()) return;
  const gid = ev.source?.groupId || ev.source?.roomId;
  if (!gid || (CFG.groupId() && gid !== CFG.groupId())) return;   // 只統計指定的那個群
  await ensure();
  const at = ev.timestamp || Date.now();

  if (ev.type === 'unsend') {
    await pool.query(`UPDATE msg_raw SET unsent=TRUE WHERE msg_id=$1`, [ev.unsend?.messageId || '']);
    return;
  }

  // postback 備援：群組 postback 官方不保證帶 userId，有帶才收得到
  if (ev.type === 'postback') {
    const m = /^msgkpi_ack=(\d+)$/.exec(ev.postback?.data || '');
    if (!m) return;
    const w = await byUid(ev.source?.userId);
    if (!w) { console.warn('[msgkpi] 群組 postback 無 userId，改靠「收到」文字記名'); return; }
    await ack(Number(m[1]), w, ev.source.userId, 'button', at);
    return;
  }

  if (ev.type !== 'message') return;
  const uid = ev.source?.userId;
  const msg = ev.message || {};
  const txt = msg.type === 'text' ? String(msg.text || '') : '';
  const w = await byUid(uid);

  // 原始發言（沒綁 LINE userId 的人也記一筆，方便查誰還沒綁）
  const duty = w ? await onDuty(w['Email'], at) : null;
  await pool.query(
    `INSERT INTO msg_raw (msg_id, group_id, uid, email, kind, quoted, txt, on_duty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [msg.id || null, gid, uid || null, w?.['Email'] || null, msg.type || 'unknown',
     msg.quotedMessageId || null, CFG.storeText() ? txt.slice(0, 300) : null, duty]);

  if (!w) return;                                   // 認不出人（沒綁 userId / 用電腦版）→ 只留原始紀錄
  const mgr = D.attIsMgr(w['Email']);

  // ── 管理者發言 → 判斷要不要開錨點 ──
  if (mgr) {
    const asker = { uid, email: w['Email'], name: w['姓名'] || w['Email'] };
    if (/^!kpi\b/i.test(txt)) {                                        // 手動開錨點
      const id = await mkAnchor({ msgId: msg.id, groupId: gid, asker, kind: 'manual', txt, targets: await allTargets() });
      if (id) await reply(ev.replyToken, `📌 已建立回覆考核錨點 #${code36(id)}\n對象：全體正職\n大家回「收到 #${code36(id)}」或直接在群裡回覆即可。`);
      return;
    }
    const mentionees = (msg.mention?.mentionees || []).filter(x => x.userId && !x.isSelf);
    if (mentionees.length) {                                           // @ 了誰＝只有他要回
      const list = [];
      for (const mm of mentionees) { const t = await byUid(mm.userId); if (t && isTarget(t)) list.push({ email: t['Email'], name: t['姓名'] || t['Email'] }); }
      if (list.length) { await mkAnchor({ msgId: msg.id, groupId: gid, asker, kind: 'mention', txt, targets: list }); return; }
    }
    if (KEYWORD.test(txt) || /^!/.test(txt)) {
      await mkAnchor({ msgId: msg.id, groupId: gid, asker, kind: 'keyword', txt, targets: await allTargets() });
    }
    return;
  }

  // ── 員工發言 → 看能不能對到錨點 ──
  if (!isTarget(w)) return;

  const hit = /^\s*收到\s*#?([0-9A-Za-z]+)/.exec(txt);                  // 「收到 #7F」＝按鈕送出的文字，最明確
  if (hit) {
    const id = parseInt(hit[1], 36);
    if (Number.isFinite(id) && await ack(id, w, uid, 'button', at)) return;
  }
  if (msg.quotedMessageId) {                                           // 引用回覆＝明確對到那一則
    const a = (await pool.query(`SELECT id FROM msg_anchor WHERE msg_id=$1`, [msg.quotedMessageId])).rows[0];
    if (a && await ack(a.id, w, uid, 'quote', at)) return;
  }
  await ackOpen(w, uid, 'window', at);                                 // 時間窗內發言＝視為有回應
}

async function reply(token, text) {
  if (!token || !process.env.LINE_TOKEN_3) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.LINE_TOKEN_3}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken: token, messages: [{ type: 'text', text }] })
    });
  } catch (e) { console.error('[msgkpi] reply 失敗:', e.message); }
}

// ═══ 用 bot 發公告（掛「收到」按鈕）→ 這條路的數據最準 ═══════════════════
// 回傳 { anchorId, code }。push 一則到群組＝1 則額度（不論群裡幾人）。
async function postAnnounce(title, body, opts = {}) {
  if (!process.env.LINE_TOKEN_3) throw new Error('缺 LINE_TOKEN_3');
  const gid = opts.groupId || CFG.groupId();
  if (!gid) throw new Error('缺群組 ID（MSGKPI_GROUP_ID / PUNCH_REMIND_GROUP_ID）');
  await ensure();
  const targets = opts.targets || await allTargets();
  const id = await mkAnchor({
    msgId: null, groupId: gid,
    asker: { uid: null, email: opts.byEmail || null, name: opts.byName || '管理者' },
    kind: 'announce', txt: `${title}\n${body}`, targets
  });
  const c = code36(id);
  const flex = { type: 'flex', altText: `📢 ${title}`, contents: { type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#2563EB', paddingAll: '16px', contents: [
      { type: 'text', text: '📢 ' + title, color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true },
      { type: 'text', text: `編號 #${c}　${twDay()}`, color: '#FFFFFFDD', size: 'xs', margin: 'sm' } ] },
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: body, size: 'sm', color: '#374151', wrap: true },
      { type: 'separator', margin: 'md' },
      { type: 'text', text: `看完請按下面按鈕，系統會記錄你的回覆時間（應回覆 ${targets.length} 人）`, size: 'xs', color: '#9CA3AF', margin: 'md', wrap: true } ] },
    footer: { type: 'box', layout: 'vertical', contents: [
      // message action：一定會產生 message 事件 → userId 保證拿得到 → 記名不會漏
      { type: 'button', style: 'primary', color: '#2563EB', action: { type: 'message', label: '✅ 收到', text: `收到 #${c}` } } ] } } };
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.LINE_TOKEN_3}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: gid, messages: [flex] })
  });
  if (!r.ok) throw new Error(`push 失敗 ${r.status} ${await r.text().catch(() => '')}`);
  // bot 自己發的訊息拿不到群組裡的 message id，用 sentMessages 回傳的 id 補上，讓員工「引用回覆」也對得到
  try { const j = await r.clone().json(); const mid = j?.sentMessages?.[0]?.id; if (mid) await pool.query(`UPDATE msg_anchor SET msg_id=$1 WHERE id=$2`, [mid, id]); } catch (e) {}
  console.log(`[msgkpi] 公告 #${c} 已發送，應回覆 ${targets.length} 人`);
  return { anchorId: id, code: c, targets: targets.length };
}

// ═══ 每日結算 ═══════════════════════════════════════════════════════════
// 每人每期間的彙總（結算與 API 共用同一段 SQL，避免兩邊算法分岔）。
// 參數：$1=起日 $2=迄日 $3=上班SLA分 $4=下班SLA分 $5=只看某人(可 null)
// 時區一律 Asia/Taipei，不吃 DB 伺服器的 TimeZone 設定（Railway 是 UTC，寫死才不會差 8 小時）。
// anch 與 tg 分開：targets 展開後一個錨點會有 N 列，ack 直接 join 上去會被乘 N 倍。
const AGG_SQL = `
WITH b AS (SELECT ($1::date)::timestamp AT TIME ZONE 'Asia/Taipei' AS s,
                  ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Taipei' AS e),
anch AS (SELECT m.id FROM msg_anchor m, b WHERE m.created_at >= b.s AND m.created_at < b.e),
tg AS (SELECT t->>'email' AS email, t->>'name' AS name
       FROM msg_anchor m, b, jsonb_array_elements(m.targets) t
       WHERE m.created_at >= b.s AND m.created_at < b.e),
req AS (SELECT email, max(name) AS name, count(*)::int AS required FROM tg GROUP BY 1),
got AS (SELECT k.email, count(*)::int AS acked,
               count(*) FILTER (WHERE k.via IN ('button','quote'))::int AS acked_hard,
               count(*) FILTER (WHERE k.via = 'window')::int AS acked_soft,
               count(*) FILTER (WHERE k.on_duty)::int AS acked_on,
               count(*) FILTER (WHERE k.on_duty IS NOT TRUE)::int AS acked_off,
               count(*) FILTER (WHERE (k.on_duty AND k.lag_sec <= $3*60)
                                   OR (k.on_duty IS NOT TRUE AND k.lag_sec <= $4*60))::int AS in_sla,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY k.lag_sec)::int AS median_lag
        FROM msg_ack k JOIN anch ON anch.id = k.anchor_id GROUP BY 1),
spk AS (SELECT r.email, count(*)::int AS spoke FROM msg_raw r, b
        WHERE r.email IS NOT NULL AND r.unsent IS NOT TRUE
          AND r.created_at >= b.s AND r.created_at < b.e GROUP BY 1),
agg AS (SELECT req.email, req.name, req.required,
               COALESCE(got.acked,0) AS acked,
               COALESCE(got.acked_hard,0) AS acked_hard, COALESCE(got.acked_soft,0) AS acked_soft,
               COALESCE(got.acked_on,0) AS acked_on,
               COALESCE(got.acked_off,0) AS acked_off, COALESCE(got.in_sla,0) AS in_sla,
               got.median_lag, COALESCE(spk.spoke,0) AS spoke
        FROM req LEFT JOIN got USING(email) LEFT JOIN spk USING(email)
        WHERE $5::text IS NULL OR req.email = $5::text)`;

// 錨點算在「發出當天」；晚回的（例如下班後隔天才回）會回頭補進那一天，
// 所以每晚重算最近 3 天，不是只算今天。
async function rollup(days = 3) {
  await ensure();
  for (let i = 0; i < days; i++) {
    const day = twDay(Date.now() - i * 86400000);
    await pool.query(`DELETE FROM msg_kpi_daily WHERE day=$1`, [day]);
    await pool.query(
      `INSERT INTO msg_kpi_daily (day, email, name, required, acked, acked_hard, acked_soft, acked_on, acked_off, in_sla, median_lag, spoke)
       ${AGG_SQL} SELECT $1::date, email, name, required, acked, acked_hard, acked_soft, acked_on, acked_off, in_sla, median_lag, spoke FROM agg`,
      [day, day, CFG.slaOn(), CFG.slaOff(), null]);
  }
  console.log(`[msgkpi] 已結算最近 ${days} 天`);
}

async function purge() {
  await ensure();
  const r = await pool.query(`DELETE FROM msg_raw WHERE created_at < NOW() - ($1 || ' days')::interval`, [String(CFG.keepDays())]);
  if (r.rowCount) console.log(`[msgkpi] 清掉 ${r.rowCount} 筆逾期原始發言`);
}

// ═══ 給前端讀的 API ═════════════════════════════════════════════════════
function mountRoutes(app, guard, jsonMw) {
  const parse = jsonMw || ((req, res, next) => next());   // index.js 的 app.use(express.json()) 註冊在 calc 路由之後，POST 要自帶 parser
  // GET /api/calc/msg-kpi?from=YYYY-MM-DD&to=YYYY-MM-DD[&email=]
  app.get('/api/calc/msg-kpi', async (req, res) => {
    try {
      if (guard && !guard(req)) return res.status(403).json({ ok: false, reason: 'forbidden' });
      await ensure();
      const to = req.query.to || twDay();
      const from = req.query.from || twDay(Date.now() - 29 * 86400000);
      const email = req.query.email || null;

      // 人員彙總直接從原始錨點/回應算（不是把每日中位數再平均，那樣中位數會失真）
      const people = (await pool.query(`${AGG_SQL} SELECT * FROM agg ORDER BY required DESC, acked DESC`,
        [from, to, CFG.slaOn(), CFG.slaOff(), email])).rows
        .map(p => ({ ...p,
          rate: p.required ? Math.round(p.acked / p.required * 100) : null,
          rate_hard: p.required ? Math.round(p.acked_hard / p.required * 100) : null,
          sla_rate: p.required ? Math.round(p.in_sla / p.required * 100) : null,
          median_lag_min: p.median_lag == null ? null : Math.round(p.median_lag / 60) }));

      const days = (await pool.query(`
        SELECT day::text, sum(required)::int AS required, sum(acked)::int AS acked
        FROM msg_kpi_daily WHERE day BETWEEN $1 AND $2 AND ($3::text IS NULL OR email=$3)
        GROUP BY day ORDER BY day`, [from, to, email])).rows
        .map(d => ({ ...d, rate: d.required ? Math.round(d.acked / d.required * 100) : null }));

      const anchors = (await pool.query(`
        SELECT a.id, a.created_at, a.kind, a.txt, a.asker_name,
               jsonb_array_length(a.targets) AS required,
               (SELECT count(*)::int FROM msg_ack k WHERE k.anchor_id=a.id) AS acked,
               (SELECT COALESCE(jsonb_agg(t->>'name'), '[]'::jsonb) FROM jsonb_array_elements(a.targets) t
                 WHERE NOT EXISTS (SELECT 1 FROM msg_ack k WHERE k.anchor_id=a.id AND k.email = t->>'email')) AS missing
        FROM msg_anchor a
        WHERE a.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Taipei'
          AND a.created_at <  ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Taipei'
        ORDER BY a.created_at DESC LIMIT 100`, [from, to])).rows;

      res.json({ ok: true, from, to, sla: { on: CFG.slaOn(), off: CFG.slaOff() }, people, days, anchors });
    } catch (e) { console.error('calc/msg-kpi:', e.message); res.status(500).json({ ok: false, reason: e.message }); }
  });

  // POST /api/calc/msg-announce  { title, body }  → 用 bot 發公告卡（帶「收到」按鈕）
  app.post('/api/calc/msg-announce', parse, async (req, res) => {
    try {
      if (guard && !guard(req)) return res.status(403).json({ ok: false, reason: 'forbidden' });
      const { title, body } = req.body || {};
      if (!title || !body) return res.status(400).json({ ok: false, reason: '缺 title/body' });
      res.json({ ok: true, ...(await postAnnounce(String(title).slice(0, 60), String(body).slice(0, 900), { byEmail: req.get('X-Calc-Email') || null })) });
    } catch (e) { console.error('calc/msg-announce:', e.message); res.status(500).json({ ok: false, reason: e.message }); }
  });
}

function init(p, deps) { pool = p; D = deps; return module.exports; }

module.exports = { init, ensure, handleGroupEvent, postAnnounce, rollup, purge, mountRoutes };
