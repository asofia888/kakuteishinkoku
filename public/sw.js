// 申告スナップ Service Worker — オフライン対応(PWA)。
// 方針: ページ遷移(HTML)はネットワーク優先(更新を確実に反映)、
// 静的アセットは stale-while-revalidate(表示は速く・裏で更新)。
// バージョンはリリース時に上げる(古いキャッシュは activate で破棄される)。
const VERSION = 'v3.5.0';
const CACHE = `shinkoku-snap-${VERSION}`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // HTML: ネットワーク優先。オフライン時はキャッシュ、それもなければトップへ
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match(request);
          if (cached) return cached;
          const top = await caches.match(new URL('./', self.registration.scope).href);
          return top ?? Response.error();
        }
      })(),
    );
    return;
  }

  // アセット: キャッシュ優先で即返し、裏で更新(stale-while-revalidate)
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      const refresh = fetch(request)
        .then(async (fresh) => {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
          return fresh;
        })
        .catch(() => undefined);
      return cached ?? (await refresh) ?? Response.error();
    })(),
  );
});
