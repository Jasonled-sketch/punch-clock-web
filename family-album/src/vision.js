// Claude 負責「看懂這張照片在做什麼」（場景、活動、值不值得放進回顧），以及聽懂家人用口語下的查詢。
// 注意：不叫 AI 認臉。「誰在照片裡」是本機人臉比對 + 家人自己標的結果，以文字告訴 AI 而已。
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import sharp from 'sharp';
import { config } from './config.js';
import { zhDate, ymdOf } from './time.js';

let client = null;
const getClient = () => (client ||= new Anthropic());
// 模型若因政策拒答，交給伺服器端自動改用備援模型（不支援的模型會自動忽略這個參數）
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

const PhotoInfo = z.object({
  caption: z.string().describe('一句話描述這張照片，繁體中文，25 字以內，像家人寫的相簿註記'),
  event: z.string().describe('活動類型，2~6 字，例：生日、出遊、日常、用餐、學校活動、節慶、運動、睡覺、玩耍、聚會'),
  scene: z.string().describe('場景，2~8 字，例：家裡客廳、公園、海邊、餐廳、教室、車上'),
  tags: z.array(z.string()).describe('3~8 個搜尋用關鍵字（物品、地點類型、動作、季節、情緒），繁體中文'),
  quality: z.number().describe('畫面品質 1~5：清晰度、構圖、表情（5 最好；模糊、閉眼、被擋住給低分）'),
  highlight: z.number().describe('值不值得放進家庭回顧影片 1~5：有故事、有笑容、重要時刻給高分；隨手拍、重複的給低分'),
  is_document: z.boolean().describe('這是不是文件、收據、螢幕截圖、商品照等「非生活照」')
});

const SYSTEM = `你是一個家庭相簿整理助理，幫一個家庭整理孩子與生活的照片。
請用繁體中文、溫暖自然的口吻。照片中的人是誰，會由系統以文字提供（那是家人自己標記的結果）；
你不需要也不要從長相去判斷身分，沒有提供名字的人就用「孩子」「大人」「家人」等一般稱呼。`;

export const aiEnabled = () => config.ai.enabled;

/**
 * @param {Buffer} jpeg
 * @param {{names?:string[], takenAt?:number, uploader?:string}} ctx
 */
export async function describePhoto(jpeg, ctx = {}) {
  const small = await sharp(jpeg).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const facts = [
    ctx.takenAt ? `拍攝日期：${zhDate(ctx.takenAt)}` : null,
    ctx.names?.length ? `照片中出現（家人標記）：${ctx.names.join('、')}` : '照片中的人尚未標記名字',
  ].filter(Boolean).join('\n');
  const res = await getClient().beta.messages.parse({
    model: config.ai.model,
    max_tokens: 2000,
    ...FALLBACK,
    system: SYSTEM,
    output_config: { effort: config.ai.effort, format: betaZodOutputFormat(PhotoInfo) },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: small.toString('base64') } },
        { type: 'text', text: `${facts}\n\n請整理這張照片的資訊。` }
      ]
    }]
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return null;
  const o = res.parsed_output;
  const clamp = n => Math.max(1, Math.min(5, Math.round(Number(n) || 3)));
  return { ...o, tags: o.tags.slice(0, 8), quality: clamp(o.quality), highlight: clamp(o.highlight) };
}

const Query = z.object({
  intent: z.enum(['search', 'recap', 'stats', 'chat']).describe('search=找照片；recap=要回顧影片；stats=問數量統計；chat=其他閒聊或看不懂'),
  people: z.array(z.string()).describe('提到的家人名字，只能用清單裡有的名字'),
  from: z.string().nullable().describe('日期範圍起（含），YYYY-MM-DD；沒提到時間就 null'),
  to: z.string().nullable().describe('日期範圍迄（含），YYYY-MM-DD；沒提到時間就 null'),
  keywords: z.array(z.string()).describe('場景/活動/物品關鍵字，含同義詞（例：海邊→海邊、沙灘、海），最多 6 個；不要放人名與時間'),
  reply: z.string().describe('intent=chat 時給家人的一句簡短回覆；其他情況給空字串')
});

/** 把口語（「找去年夏天弟弟在海邊的照片」）轉成查詢條件 */
export async function parseQuery(text, peopleNames) {
  if (!aiEnabled()) return fallbackQuery(text, peopleNames);
  try {
    const res = await getClient().beta.messages.parse({
      model: config.ai.model,
      max_tokens: 1500,
      ...FALLBACK,
      system: `你是家庭相簿小秘書，把家人的一句話轉成相簿查詢條件。今天是 ${ymdOf(Date.now())}（台灣時間）。\n相簿裡已標記的家人：${peopleNames.join('、') || '（還沒有）'}。`,
      output_config: { effort: 'low', format: betaZodOutputFormat(Query) },
      messages: [{ role: 'user', content: text }]
    });
    if (res.stop_reason === 'refusal' || !res.parsed_output) return fallbackQuery(text, peopleNames);
    const o = res.parsed_output;
    return { ...o, people: o.people.filter(n => peopleNames.includes(n)) };
  } catch (e) {
    console.error('[ai] parseQuery 失敗，改用關鍵字比對：', e.message);
    return fallbackQuery(text, peopleNames);
  }
}

/** 沒有 AI 金鑰時的簡易版：抓人名、年月、其餘當關鍵字 */
export function fallbackQuery(text, peopleNames) {
  let rest = text;
  const people = peopleNames.filter(n => rest.includes(n));
  for (const n of people) rest = rest.replaceAll(n, ' ');
  let from = null, to = null;
  const ym = rest.match(/(20\d{2})\s*[-\/年.]\s*(\d{1,2})\s*月?/);
  const y = rest.match(/(20\d{2})\s*年?/);
  if (ym) {
    const yy = +ym[1], mm = +ym[2];
    from = `${yy}-${String(mm).padStart(2, '0')}-01`;
    to = `${yy}-${String(mm).padStart(2, '0')}-${new Date(Date.UTC(yy, mm, 0)).getUTCDate()}`;
    rest = rest.replace(ym[0], ' ');
  } else if (y) {
    from = `${y[1]}-01-01`; to = `${y[1]}-12-31`;
    rest = rest.replace(y[0], ' ');
  }
  const keywords = rest.replace(/[的在和跟與、，。？！\s]+|照片|相片|影片/g, ' ').split(' ').filter(w => w.length >= 1).slice(0, 6);
  return { intent: 'search', people, from, to, keywords, reply: '' };
}
