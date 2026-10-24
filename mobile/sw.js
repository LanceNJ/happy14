// 欢乐十四分 · 极简 Service Worker
// 策略：页面导航走「网络优先，失败回落到缓存」——避免把旧 HTML 缓存死；
// 同源静态资源走「缓存优先」，离线可开。
// 换版本只改 CACHE 名，activate 会清掉旧缓存。
const CACHE = 'h14-pwa-v1';
const CORE = ['./', './manifest.json', './icon-192.png', './icon-512.png', './icon-180.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 单个失败不影响整体安装（例如某张图还没部署）
      return Promise.all(CORE.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 页面：网络优先（保证每次打开都是最新部署），断网才用缓存
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (r) {
        const cp = r.clone();
        caches.open(CACHE).then(function (c) { c.put('./', cp); }).catch(function () {});
        return r;
      }).catch(function () {
        return caches.match('./').then(function (hit) { return hit || caches.match(req); });
      })
    );
    return;
  }

  // 同源静态资源：缓存优先，取到后回填
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (r) {
        const cp = r.clone();
        caches.open(CACHE).then(function (c) { c.put(req, cp); }).catch(function () {});
        return r;
      });
    }).catch(function () { return caches.match(req); })
  );
});
