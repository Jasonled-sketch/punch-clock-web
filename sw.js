// 譽昇打卡系統 Service Worker — 只做「推播通知」，不做離線快取
// （刻意不快取：出勤資料必須即時，且避免使用者卡在舊版本；PWA 安裝本身不需要快取）
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: '打卡系統', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '打卡系統', {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: d.url || './index.html' },
    tag: d.tag || 'att-notify',      // 同類通知覆蓋，不洗版
    renotify: true,
    requireInteraction: false
  }));
});

// 點通知 → 有開著的視窗就聚焦，否則開新視窗
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.indexOf('punch-clock-web') >= 0 && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
