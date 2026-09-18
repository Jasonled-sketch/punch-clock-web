// Cloudflare Worker 版入口。
// 不想多開一個 Railway 服務時可以用這個，跟既有的 usled-ragic-proxy 同一套佈署方式。
//
// 注意：Worker 沒有常駐記憶體，MemoryStore 在這裡不可靠（每次請求可能是新 isolate）。
// 正式用要接 KV 或 Durable Object，或改用 Railway 版。

const { createIngest } = require('./handler');

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

module.exports = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = env.AZLIOT_PUSH_PATH || '/azliot/lpush';

    if (url.pathname === '/healthz') return json({ ok: true, service: 'azliot-lpush' });
    if (url.pathname !== path) return json({ errorCode: 1, errorStr: 'not found' }, 404);
    if (request.method !== 'POST') return json({ errorCode: 1, errorStr: 'method not allowed' }, 405);

    const bodyText = await request.text();
    const ingest = createIngest(env);
    const result = await ingest.handle(bodyText, request.headers.get('content-type'));

    // 背景工作交給 waitUntil，回應才不用等 Ragic 和 AI
    ctx.waitUntil(result.work.catch((err) => console.error('[gps] 背景處理失敗', err)));
    return json(result.body, result.status);
  },
};
