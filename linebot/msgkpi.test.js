// 群組回覆 KPI 的端對端測試：真的開一個 Postgres，跑真的 SQL。
// 執行：DATABASE_URL=postgres://... node --test test/msgkpi.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

process.env.MSGKPI_GROUP_ID = 'G1';
process.env.MSGKPI_SLA_ON_MIN = '30';
process.env.MSGKPI_SLA_OFF_MIN = '720';
process.env.LINE_TOKEN_3 = 'dummy';

const kpi = require('../lib/msgkpi.js');

// ── 假的 Ragic：一個管理者(Jason) + 三個正職 ──
const W = (email, name, uid, type = '正式員工') => ({ Email: email, 姓名: name, 'LINE userId': uid, 啟用: '1', 員工類型: type });
const WORKERS = [
  W('boss@x.com', 'Jason', 'UM', '管理者'),
  W('a@x.com', '阿明', 'UA'),
  W('b@x.com', '小華', 'UB'),
  W('c@x.com', '阿凱', 'UC')
];
const d = new Date(Date.now() + 8 * 3600e3);
const TODAY = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
// 阿明整天在班上；小華只有 00:00–00:01（等於現在一定不在班上）；阿凱今天沒打卡
const RECS = [
  { Email: 'a@x.com', 日期: TODAY, 上班時間: '00:00', 下班時間: '23:59', 狀態: '' },
  { Email: 'b@x.com', 日期: TODAY, 上班時間: '00:00', 下班時間: '00:01', 狀態: '' }
];

const deps = {
  punchRagicGet: async sheet => sheet.endsWith('/2') ? WORKERS : sheet.endsWith('/3') ? RECS : [],
  attIsMgr: e => String(e || '').toLowerCase() === 'boss@x.com',
  attIsTestW: w => w?.員工類型 === '測試號',
  ATT_FID: { rec: { date: '1002873' } }
};

let sent = [];
global.fetch = async (url, opt) => {
  sent.push({ url, body: JSON.parse(opt?.body || '{}') });
  return { ok: true, status: 200, clone: () => ({ json: async () => ({ sentMessages: [{ id: 'BOTMSG1' }] }) }), json: async () => ({}), text: async () => '' };
};

// 沒給 DATABASE_URL 就跳過（npm test 在沒有 Postgres 的機器上照樣全綠）
const DB = process.env.DATABASE_URL || '';
const pool = DB ? new Pool({ connectionString: DB }) : null;
if (pool) kpi.init(pool, deps);

const msg = (uid, text, extra = {}) => ({
  type: 'message', timestamp: Date.now(), source: { type: 'group', groupId: 'G1', userId: uid },
  replyToken: 'RT', message: { type: 'text', id: 'M' + Math.random().toString(36).slice(2), text, ...extra }
});

test('群組回覆 KPI 全流程', { skip: DB ? false : '需要 DATABASE_URL（指向一個測試用 Postgres）' }, async t => {
  await pool.query(`DROP TABLE IF EXISTS msg_anchor, msg_ack, msg_raw, msg_kpi_daily`);
  await kpi.ensure();

  await t.test('別的群組不統計', async () => {
    const e = msg('UM', '全體注意，收到請回'); e.source.groupId = 'G-OTHER';
    await kpi.handleGroupEvent(e);
    assert.equal((await pool.query('SELECT count(*) c FROM msg_anchor')).rows[0].c, '0');
  });

  await t.test('管理者說「收到請回」→ 開錨點，對象是全體正職（不含管理者/自己）', async () => {
    await kpi.handleGroupEvent(msg('UM', '明天 8 點集合，收到請回'));
    const a = (await pool.query('SELECT * FROM msg_anchor')).rows;
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, 'keyword');
    assert.deepEqual(a[0].targets.map(t => t.email).sort(), ['a@x.com', 'b@x.com', 'c@x.com']);
  });

  await t.test('員工發言 → 時間窗內算已回應，上班/下班依當天打卡區間判定', async () => {
    await kpi.handleGroupEvent(msg('UA', '好的'));      // 阿明整天在班 → on_duty
    await kpi.handleGroupEvent(msg('UB', '收到'));      // 小華不在班 → off_duty
    const k = (await pool.query('SELECT email, via, on_duty FROM msg_ack ORDER BY email')).rows;
    assert.equal(k.length, 2);
    assert.deepEqual(k.map(x => x.email), ['a@x.com', 'b@x.com']);
    assert.equal(k[0].on_duty, true);
    assert.equal(k[1].on_duty, false);
    assert.ok(k.every(x => x.via === 'window'));
  });

  await t.test('一般員工發言不會變成錨點', async () => {
    await kpi.handleGroupEvent(msg('UA', '請回覆一下這個'));   // 員工講關鍵字也不算
    assert.equal((await pool.query('SELECT count(*) c FROM msg_anchor')).rows[0].c, '1');
  });

  await t.test('管理者 @ 某人 → 只有被 @ 的人要回；引用回覆對得到那一則', async () => {
    const m = msg('UM', '@阿明 這單今天要出', { mention: { mentionees: [{ index: 0, length: 3, userId: 'UA', type: 'user' }] } });
    await kpi.handleGroupEvent(m);
    const a = (await pool.query(`SELECT * FROM msg_anchor WHERE kind='mention'`)).rows[0];
    assert.deepEqual(a.targets.map(t => t.email), ['a@x.com']);

    await kpi.handleGroupEvent(msg('UA', '收到，馬上處理', { quotedMessageId: m.message.id }));
    const k = (await pool.query(`SELECT via FROM msg_ack WHERE anchor_id=$1`, [a.id])).rows;
    assert.equal(k.length, 1);
    assert.equal(k[0].via, 'quote');

    // 沒被 @ 到的人就算在群裡講話，也不會被記成回應了這則
    await kpi.handleGroupEvent(msg('UC', '哈哈'));
    assert.equal((await pool.query(`SELECT count(*) c FROM msg_ack WHERE anchor_id=$1`, [a.id])).rows[0].c, '1');
  });

  await t.test('bot 發公告卡 → 按「收到 #代號」記名', async () => {
    sent = [];
    const { anchorId, code } = await kpi.postAnnounce('週會改期', '本週五 10:00 開會');
    const flex = sent[0].body.messages[0];
    assert.equal(flex.contents.footer.contents[0].action.type, 'message');  // 不用 postback：群組 postback 不保證帶 userId
    assert.equal(flex.contents.footer.contents[0].action.text, `收到 #${code}`);
    assert.equal((await pool.query(`SELECT msg_id FROM msg_anchor WHERE id=$1`, [anchorId])).rows[0].msg_id, 'BOTMSG1');

    await kpi.handleGroupEvent(msg('UC', `收到 #${code}`));
    const k = (await pool.query(`SELECT via, email FROM msg_ack WHERE anchor_id=$1`, [anchorId])).rows;
    assert.deepEqual(k, [{ via: 'button', email: 'c@x.com' }]);
  });

  await t.test('同一人對同一則不會被記兩次', async () => {
    const a = (await pool.query(`SELECT id FROM msg_anchor WHERE kind='keyword'`)).rows[0];
    const before = (await pool.query(`SELECT count(*) c FROM msg_ack WHERE anchor_id=$1`, [a.id])).rows[0].c;
    await kpi.handleGroupEvent(msg('UA', '再講一句'));
    assert.equal((await pool.query(`SELECT count(*) c FROM msg_ack WHERE anchor_id=$1`, [a.id])).rows[0].c, before);
  });

  await t.test('結算數字正確：需回覆/明確回應/推定回應/上班內/下班後', async () => {
    await kpi.rollup(1);
    const rows = (await pool.query(`SELECT * FROM msg_kpi_daily ORDER BY email`)).rows;
    const by = Object.fromEntries(rows.map(r => [r.email, r]));

    // 錨點 3 則：keyword(全體3人) + mention(阿明) + announce(全體3人)
    assert.equal(by['a@x.com'].required, 3);
    assert.equal(by['b@x.com'].required, 2);
    assert.equal(by['c@x.com'].required, 2);

    // 阿明：引用回覆1(明確) + 兩次時間窗內發言(推定) → 全中
    assert.equal(by['a@x.com'].acked, 3);
    assert.equal(by['a@x.com'].acked_hard, 1);
    assert.equal(by['a@x.com'].acked_soft, 2);
    assert.equal(by['a@x.com'].acked_on, 3);      // 整天在班
    assert.equal(by['a@x.com'].acked_off, 0);

    // 小華：只在時間窗內講過一次話，公告沒按 → 2 則只回到 1 則
    assert.equal(by['b@x.com'].acked, 1);
    assert.equal(by['b@x.com'].acked_hard, 0);
    assert.equal(by['b@x.com'].acked_on, 0);
    assert.equal(by['b@x.com'].acked_off, 1);     // 不在班上 → 下班後回

    // 阿凱：按了公告「收到」(明確) + 隨口一句被推定成回應
    assert.equal(by['c@x.com'].acked, 2);
    assert.equal(by['c@x.com'].acked_hard, 1);
    assert.equal(by['c@x.com'].acked_soft, 1);

    assert.ok(rows.every(r => r.in_sla === r.acked), '剛回的都應該在 SLA 內');
    assert.ok(by['a@x.com'].spoke >= 3, '主動發言數要有記到');
  });

  await t.test('重跑結算不會重複灌數字', async () => {
    await kpi.rollup(1); await kpi.rollup(1);
    const n = (await pool.query(`SELECT count(*) c FROM msg_kpi_daily`)).rows[0].c;
    assert.equal(n, '3');
  });

  await t.test('API 彙總：回覆率 / 準時率 / 未回名單', async () => {
    const app = { routes: {}, get(p, h) { this.routes['GET ' + p] = h; }, post(p, h) { this.routes['POST ' + p] = h; } };
    kpi.mountRoutes(app, () => true);
    let out;
    await app.routes['GET /api/calc/msg-kpi'](
      { query: {}, get: () => null },
      { json: j => { out = j; }, status() { return this; } });

    assert.equal(out.ok, true);
    const p = Object.fromEntries(out.people.map(x => [x.email, x]));
    assert.equal(p['a@x.com'].rate, 100);          // 3/3
    assert.equal(p['a@x.com'].rate_hard, 33);      // 但只有 1/3 是明確回應，其餘靠時間窗推定
    assert.equal(p['b@x.com'].rate, 50);           // 1/2
    assert.equal(p['b@x.com'].rate_hard, 0);
    assert.equal(p['c@x.com'].rate, 100);          // 2/2
    assert.equal(p['c@x.com'].rate_hard, 50);
    assert.equal(p['a@x.com'].median_lag_min, 0);
    assert.equal(out.anchors.length, 3);
    const ann = out.anchors.find(a => a.kind === 'announce');
    assert.deepEqual(ann.missing, ['小華']);       // 公告只有小華完全沒回
    assert.ok(out.days.length >= 1);
  });

  await pool.end();
});
