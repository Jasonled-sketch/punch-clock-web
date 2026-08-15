/* USLED 任務牆 Service Worker — 最小殼：讓 PWA 可安裝 + 離線 fallback。
   ⚠️ 鐵則：一律「網路優先」，絕不 cache-first——版本號機制(APP_VERSION)靠即時抓新檔，
   SW 只在完全沒網路時回退快取，不會讓同事吃到舊版。 */
const CACHE = 'usled-taskwall-shell-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // 寫入類請求完全不碰
  if (!req.url.startsWith(self.location.origin)) return;  // 跨域(Ragic Worker/ImgBB/GSI)完全不碰
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(req, clone)); }
      return res;
    }).catch(() => caches.match(req))                     // 斷網才回退快取
  );
});

/* ── Web Push 系統提醒（工單 B4）：taskwall-push Worker 發來的推播 → 顯示系統通知 ── */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (err) { d = { body: e.data ? e.data.text() : '' }; }   // payload 不是 JSON 就當純文字
  e.waitUntil(self.registration.showNotification(d.title || '任務牆', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: d.url || './' }
  }));
});
/* ── 訂閱輪換自救：瀏覽器會不定期換掉 endpoint，舊的推播回 410 → 後端把 KV 紀錄刪掉 → 從此再也收不到，
   而前端的鈴鐺還亮著（getSubscription() 拿到的是新訂閱），使用者完全無感。這裡自動用新訂閱重新註冊。 ── */
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const opts = (e.oldSubscription && e.oldSubscription.options) || {};
      const sub = e.newSubscription || await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: opts.applicationServerKey
      });
      if (!sub) return;
      // 沒有使用者憑證可用（SW 沒有 localStorage）→ 交給頁面下次開啟時補；先把新訂閱暫存到 Cache 當旗標
      const c = await caches.open(CACHE);
      await c.put('__pending_sub__', new Response(JSON.stringify(sub.toJSON()), { headers: { 'Content-Type': 'application/json' } }));
    } catch (err) {}
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) {
          if (url && url !== './' && 'navigate' in c) { return c.navigate(url).then(cc => (cc || c).focus()).catch(() => c.focus()); }   // 帶目標就導過去
          return c.focus();
        }
      }
      return clients.openWindow(url);                                 // 沒有開著的視窗才開新的
    })
  );
});
