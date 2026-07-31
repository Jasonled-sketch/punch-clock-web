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
