// Простой service worker: оболочка приложения лежит в кэше, обновляется в фоне.
const CACHE = 'clay-zoo-v1';
const ASSETS = [
  './', 'index.html', 'styles.css', 'data.js', 'app.js', 'manifest.webmanifest',
  'fonts/fonts.css',
  'fonts/comfortaa-cyrillic.woff2', 'fonts/comfortaa-latin.woff2',
  'fonts/nunito-cyrillic.woff2', 'fonts/nunito-latin.woff2',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) return cached;
      return (await fresh) || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
    })
  );
});
