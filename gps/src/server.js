// Railway 用的獨立服務。沒有外部框架相依，node:http 就夠。
// 已經有 Express 專案的話用底下的 mountExpress 掛進去也行。

const http = require('node:http');
const { createIngest } = require('./handler');

function readBody(req, limitBytes) {
  const max = limitBytes || 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('body 過大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function createServer(env, deps) {
  const ingest = createIngest(env, deps);
  const path = env.AZLIOT_PUSH_PATH || '/azliot/lpush';
  const traccarPath = env.TRACCAR_PUSH_PATH || '/traccar/position';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/healthz') {
      return send(res, 200, { ok: true, service: 'azliot-lpush', at: new Date().toISOString() });
    }

    const isAzliot = url.pathname === path;
    const isTraccar = url.pathname === traccarPath;
    if (!isAzliot && !isTraccar) return send(res, 404, { errorCode: 1, errorStr: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { errorCode: 1, errorStr: 'method not allowed' });

    let bodyText;
    try {
      bodyText = await readBody(req);
    } catch (err) {
      return send(res, 200, { errorCode: 1, errorStr: err.message });
    }

    try {
      const result = isTraccar
        ? await ingest.handleTraccar(bodyText, req.headers)
        : await ingest.handle(bodyText, req.headers['content-type']);
      // 先回 200 再讓背景工作跑完。安智連只在意有沒有收到回應，
      // 不需要等 Ragic 寫完。
      send(res, result.status, result.body);
      result.work.catch((err) => console.error('[gps][error] 背景處理失敗', err));
    } catch (err) {
      console.error('[gps][error] handle 例外', err);
      send(res, 200, { errorCode: 1, errorStr: '內部錯誤' });
    }
  });

  // 定時把離線卡住的拜訪收掉
  const sweepMs = Number(env.GPS_SWEEP_INTERVAL_MS || 10 * 60 * 1000);
  const timer = setInterval(() => {
    ingest.sweepNow().catch((err) => console.error('[gps][error] sweep 失敗', err));
  }, sweepMs);
  if (timer.unref) timer.unref();

  server.on('close', () => clearInterval(timer));
  return { server, ingest };
}

/** 掛進既有的 Express app（例如 Railway 上的 usled-linebot）。 */
function mountExpress(app, env, deps) {
  const express = app.constructor;
  const ingest = createIngest(env, deps);
  const path = env.AZLIOT_PUSH_PATH || '/azliot/lpush';

  // 一定要拿到原始 body 字串。用過 express.json() 之後再 JSON.stringify 回去，
  // 位元組可能跟原文不同，md5 驗簽就會失敗。
  const raw = (req, res, next) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => { req.rawBody = data; next(); });
    req.on('error', next);
  };

  const respond = (handler) => async (req, res) => {
    try {
      const result = await handler(req);
      res.status(result.status).json(result.body);
      result.work.catch((err) => console.error('[gps][error] 背景處理失敗', err));
    } catch (err) {
      console.error('[gps][error] handle 例外', err);
      res.status(200).json({ errorCode: 1, errorStr: '內部錯誤' });
    }
  };

  app.post(path, raw, respond((req) => ingest.handle(req.rawBody, req.headers['content-type'])));
  app.post(env.TRACCAR_PUSH_PATH || '/traccar/position', raw,
    respond((req) => ingest.handleTraccar(req.rawBody, req.headers)));

  return ingest;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const { server } = createServer(process.env);
  server.listen(port, () => {
    console.log(`[gps] 安智連 LPush 接收服務已啟動 :${port}${process.env.AZLIOT_PUSH_PATH || '/azliot/lpush'}`);
  });
}

module.exports = { createServer, mountExpress };
