// 主流程：LPush 封包 → 判斷 → AI 摘要 → Ragic
//
// 回應速度很重要。安智連等不到 200 會重送，AI 加 Ragic 可能要十幾秒，
// 所以驗簽跟狀態更新做完就先回 200，寫入的部分丟到背景跑。
// handle() 回傳 { body, work }，work 是背景工作的 Promise：
//   Express → 回應後 await（或不 await）
//   Worker  → ctx.waitUntil(work)

const { receive, LPushError } = require('./lpush');
const { receiveTraccar, TraccarError } = require('./traccar');
const { createState, onPacket, sweep } = require('./visit-engine');
const { RagicClient } = require('./ragic');
const { summarizeVisit } = require('./ai');
const { createStore } = require('./stores');

const OK = { errorCode: 0, errorStr: '操作成功' };

function pickConfig(env) {
  // 只放「環境變數真的有設」的鍵。放 undefined 進去會蓋掉 visit-engine 的預設值。
  const spec = {
    movingSpeedKmh: 'GPS_MOVING_SPEED_KMH',
    stopJitterMeters: 'GPS_STOP_JITTER_M',
    dwellMinutes: 'GPS_DWELL_MIN',
    dwellMinutesAccOff: 'GPS_DWELL_MIN_ACC_OFF',
    matchRadiusMeters: 'GPS_MATCH_RADIUS_M',
    leaveRadiusMeters: 'GPS_LEAVE_RADIUS_M',
    minVisitMinutes: 'GPS_MIN_VISIT_MIN',
    offlineCloseMinutes: 'GPS_OFFLINE_CLOSE_MIN',
  };
  const out = {};
  for (const [key, envName] of Object.entries(spec)) {
    const raw = env[envName];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function createIngest(env, deps) {
  const d = deps || {};
  const store = d.store || createStore(env);
  const ragic = d.ragic || new RagicClient(env);
  const log = d.log || ((level, msg, extra) => {
    const line = `[gps][${level}] ${msg}`;
    if (level === 'error') console.error(line, extra || '');
    else console.log(line, extra || '');
  });

  const tz = env.AZLIOT_TZ_OFFSET === undefined ? 8 : Number(env.AZLIOT_TZ_OFFSET);
  const config = pickConfig(env);
  const driverByImei = (() => {
    try { return env.GPS_DRIVER_MAP ? JSON.parse(env.GPS_DRIVER_MAP) : {}; } catch (_) { return {}; }
  })();

  async function processEvents(events, packet) {
    for (const ev of events) {
      try {
        if (ev.type === 'alarm') {
          await store.recordAlarm(ev.imei, ev.alarmType, ev.at);
          log('info', `告警 ${ev.plateNum || ev.imei} ${ev.alarmType}`);
          if (d.onAlarm) await d.onAlarm(ev);
          continue;
        }

        if (ev.type === 'badge') {
          const res = await ragic.writeBadgePunch(ev);
          log('info', `工牌${ev.direction === 'in' ? '上班' : '下班'} ${ev.badgeName}`, res.skipped || '');
          if (d.onBadge) await d.onBadge(ev);
          continue;
        }

        if (ev.type === 'arrival') {
          // 到點只是暫定，不寫 Ragic——車可能三分鐘後就走，那就不成案。
          // 等 departure 才寫一筆完整的。
          log('info', `到點（暫定）${ev.plateNum || ev.imei} @ ${ev.customer ? ev.customer.name : '未建檔地點'}`);
          if (d.onArrival) await d.onArrival(ev);
          continue;
        }

        if (ev.type === 'visit_discarded') {
          log('info', `停留過短不成案 ${ev.imei} ${Math.round(ev.durationMinutes)} 分鐘`);
          continue;
        }

        if (ev.type === 'departure') {
          const recentAlarms = await store.recentAlarms(ev.imei, ev.arrivedAt);
          const visit = Object.assign({}, ev, { driver: driverByImei[ev.imei] || null });

          const ai = await summarizeVisit(visit, {
            apiKey: env.ANTHROPIC_API_KEY,
            tzOffsetHours: tz,
            disabled: env.GPS_AI_DISABLED === '1',
            context: { recentAlarms },
          });
          visit.summary = ai.summary;
          visit.category = ai.category;

          await ragic.writeVisit(visit);
          log('info', `寫入拜訪 ${visit.plateNum} @ ${visit.customerName || '未建檔'} ${visit.durationMinutes} 分鐘（${ai.generatedBy}）`);
          if (d.onVisit) await d.onVisit(visit, ai);
          continue;
        }

        if (ev.type === 'mileage' && d.onMileage) {
          await d.onMileage(ev);
        }
      } catch (err) {
        // 單一事件失敗不能拖垮其他事件，也不能讓整個請求變成 500
        log('error', `處理 ${ev.type} 事件失敗: ${err && err.message}`, err && err.stack);
      }
    }
  }

  /** 兩種來源共用的後半段：去重 → 取狀態 → 判斷 → 存回 → 背景處理 */
  async function ingestPacket(packet) {
    if (!packet.imei) {
      return { status: 200, body: { errorCode: 1, errorStr: ' 封包裡沒有裝置識別碼'.trim() }, work: Promise.resolve() };
    }

    // 重送去重。平台沒收到 200 會重試，同一包算兩次會產生假的重複記錄。
    if (await store.seen(`${packet.imei}:${packet.lpushType}:${packet.atText || packet.at}`)) {
      return { status: 200, body: OK, work: Promise.resolve() };
    }

    const stored = await store.get(packet.imei);
    const state = stored || createState(packet.imei);

    let customers = [];
    try {
      customers = await ragic.fetchCustomers();
    } catch (err) {
      // 客戶主檔讀不到還是要繼續：記錄會寫成「未建檔地點」，總比整包丟掉好。
      log('error', `讀客戶主檔失敗，本次不做客戶比對: ${err && err.message}`);
    }

    const { events } = onPacket(state, packet, customers, config);
    await store.put(packet.imei, state);

    return { status: 200, body: OK, work: processEvents(events, packet) };
  }

  function rejected(err) {
    log('error', `封包被拒: ${err.message}`);
    // 回非 0 讓來源那邊看得到異常（安智連文件第 7 點建議的格式）。
    // HTTP 仍為 200，否則平台會無限重送同一包。
    return { status: 200, body: { errorCode: 1, errorStr: err.message }, work: Promise.resolve() };
  }

  /**
   * 安智連 LPush 入口。
   * @returns {{status:number, body:object, work:Promise}}
   */
  async function handle(bodyText, contentType) {
    let packet;
    try {
      packet = receive(bodyText, contentType, {
        tfKey: env.AZLIOT_TF_KEY,
        tzOffsetHours: tz,
        allowUnsigned: env.AZLIOT_ALLOW_UNSIGNED === '1',
      });
    } catch (err) {
      if (err instanceof LPushError) return rejected(err);
      throw err;
    }
    return ingestPacket(packet);
  }

  /**
   * Traccar 轉發入口。自架 Traccar + GT06 定位器走這條。
   * @returns {{status:number, body:object, work:Promise}}
   */
  async function handleTraccar(bodyText, headers) {
    let packet;
    try {
      packet = receiveTraccar(bodyText, headers, {
        ingestToken: env.TRACCAR_INGEST_TOKEN,
        allowUnsigned: env.TRACCAR_ALLOW_UNSIGNED === '1',
        speedUnit: env.TRACCAR_SPEED_UNIT,
      });
    } catch (err) {
      if (err instanceof TraccarError) return rejected(err);
      throw err;
    }
    return ingestPacket(packet);
  }

  /** 定時呼叫，把離線卡住的拜訪收掉。建議每 10 分鐘一次。 */
  async function sweepNow() {
    const states = await store.all();
    const events = sweep(states, Date.now(), config);
    for (const ev of events) {
      const s = states.find((x) => x.imei === ev.imei);
      if (s) await store.put(s.imei, s);
    }
    if (events.length) log('info', `sweep 收掉 ${events.length} 筆卡住的拜訪`);
    await processEvents(events, null);
    return events;
  }

  return { handle, handleTraccar, sweepNow, store, ragic };
}

module.exports = { createIngest };
