// 譽昇營運報表中心 Service Worker — 只為 PWA 安裝而存在，刻意不做離線快取
// （報表數字必須即時，且避免使用者卡在舊版本；同記帳/打卡系統的做法）
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
