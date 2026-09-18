// 用 Claude 把一筆「到達 → 停留 → 離開」變成人看得懂的一句話。
//
// 兩個原則：
//   1. 只在拜訪結案時呼叫一次，不是每個定位包都叫。
//      一台車一天跑 8 小時會送上千個定位包，每包叫一次 AI 既慢又燒錢，
//      而且原始座標本來就不需要 AI。
//   2. AI 失敗絕不能擋住 Ragic 寫入。逾時、額度爆掉、被拒答，
//      都退回規則式的句子照樣寫進去。記錄不能因為摘要生不出來就消失。

const MODEL = 'claude-opus-5';
const CATEGORIES = ['拜訪', '送貨', '施工', '取件', '用餐休息', '返回公司', '不明'];

let Anthropic = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  Anthropic = require('@anthropic-ai/sdk');
  if (Anthropic && Anthropic.default) Anthropic = Anthropic.default;
} catch (_) {
  Anthropic = null;
}

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: '一句話描述這次停留，繁體中文，40 字以內，不要加句點以外的標點裝飾',
    },
    category: {
      type: 'string',
      enum: CATEGORIES,
      description: '這次停留最可能的性質',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: '對 category 的把握程度',
    },
  },
  required: ['summary', 'category', 'confidence'],
  additionalProperties: false,
};

function minutesText(m) {
  if (m == null) return '不明';
  if (m < 60) return `${Math.round(m)} 分鐘`;
  const h = Math.floor(m / 60);
  const rem = Math.round(m % 60);
  return rem ? `${h} 小時 ${rem} 分鐘` : `${h} 小時`;
}

function timeText(ms, tz) {
  if (!ms) return '不明';
  const d = new Date(ms + (tz === undefined ? 8 : tz) * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 規則式退路。AI 不可用時照樣產出可讀的一句話。 */
function fallbackSummary(visit, tz) {
  const who = visit.plateNum || visit.imei || '車輛';
  const dur = minutesText(visit.durationMinutes);
  const from = timeText(visit.arrivedAt, tz);
  const to = timeText(visit.departedAt, tz);
  if (visit.customerName) {
    return {
      summary: `${who} ${from} 到 ${to} 停在 ${visit.customerName}，停留 ${dur}`,
      category: '不明',
      confidence: 'low',
      generatedBy: 'rule',
    };
  }
  return {
    summary: `${who} ${from} 到 ${to} 停在未建檔地點，停留 ${dur}`,
    category: '不明',
    confidence: 'low',
    generatedBy: 'rule',
  };
}

function buildPrompt(visit, context, tz) {
  const lines = [
    '以下是一台公司車輛的一次停留記錄，請判斷這次停留最可能在做什麼，並寫成一句話。',
    '',
    `車牌：${visit.plateNum || '未知'}`,
    `駕駛：${visit.driver || '未指定'}`,
    `到達時間：${timeText(visit.arrivedAt, tz)}`,
    `離開時間：${timeText(visit.departedAt, tz)}`,
    `停留時間：${minutesText(visit.durationMinutes)}`,
  ];

  if (visit.customerName) {
    lines.push(`比對到的客戶：${visit.customerName}（距離客戶座標 ${visit.customerDistanceMeters} 公尺）`);
  } else {
    lines.push('比對到的客戶：無。這個座標不在任何已建檔的客戶附近。');
  }

  if (context && context.recentAlarms && context.recentAlarms.length) {
    lines.push(`同時段的告警：${context.recentAlarms.join('、')}`);
  }
  if (context && context.todayVisitCount != null) {
    lines.push(`這台車今天第 ${context.todayVisitCount} 個停留點`);
  }
  if (visit.reason === 'offline_timeout') {
    lines.push('注意：這筆是因為裝置離線逾時才結案，離開時間是最後一次回報的時間，不是實際離開時間。');
  }

  lines.push(
    '',
    '判斷時請注意：',
    '- 沒有比對到客戶就不要憑空猜測是哪一家，寫「未建檔地點」即可。',
    '- 停留很短（10 分鐘內）比較像送貨或取件，很長（2 小時以上）比較像施工。',
    '- 中午前後停在未建檔地點且不長，可能是用餐休息。',
    '- 不確定就選「不明」並把 confidence 設成 low。寧可不明，不要編。',
  );

  return lines.join('\n');
}

/**
 * 產生摘要。任何錯誤都吞掉並退回規則式句子。
 * @returns {Promise<{summary, category, confidence, generatedBy}>}
 */
async function summarizeVisit(visit, options) {
  const opts = options || {};
  const tz = opts.tzOffsetHours === undefined ? 8 : opts.tzOffsetHours;
  const apiKey = opts.apiKey;

  if (!Anthropic || !apiKey || opts.disabled) {
    return fallbackSummary(visit, tz);
  }

  const timeoutMs = Number(opts.timeoutMs || 20000);

  try {
    const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });

    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1000,
      // 伺服器端 fallback：安全分類器若拒答，自動改由其他模型接手，
      // 不用自己維護備援模型清單。
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: '你是車隊管理助理。根據 GPS 停留資料判斷車輛在做什麼，用繁體中文寫一句話。資料不足時誠實說不明，絕對不要編造客戶名稱或工作內容。',
      messages: [{ role: 'user', content: buildPrompt(visit, opts.context, tz) }],
      output_config: {
        // 一句話的判斷不需要深度推理，用 low 省成本；這條路徑一天會跑很多次。
        effort: 'low',
        format: { type: 'json_schema', schema: SUMMARY_SCHEMA },
      },
    });

    // 一定要先看 stop_reason 再讀 content。被拒答時 content 可能是空的。
    if (response.stop_reason === 'refusal') {
      const fb = fallbackSummary(visit, tz);
      fb.note = `AI 拒答（${(response.stop_details && response.stop_details.category) || 'unknown'}）`;
      return fb;
    }

    const text = (response.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!text) return fallbackSummary(visit, tz);

    const parsed = JSON.parse(text);
    if (!parsed.summary) return fallbackSummary(visit, tz);

    return {
      summary: String(parsed.summary).slice(0, 200),
      category: CATEGORIES.includes(parsed.category) ? parsed.category : '不明',
      confidence: parsed.confidence || 'low',
      generatedBy: 'claude',
    };
  } catch (err) {
    const fb = fallbackSummary(visit, tz);
    fb.note = `AI 呼叫失敗: ${err && err.message ? err.message.slice(0, 120) : String(err)}`;
    return fb;
  }
}

module.exports = { summarizeVisit, fallbackSummary, SUMMARY_SCHEMA, CATEGORIES, MODEL };
