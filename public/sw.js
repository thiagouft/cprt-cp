// Guarda a casca do app para abrir rápido e funcionar sem sinal.
const V = 'cprt-aco-v14', ARQ = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(V).then(c => c.addAll(ARQ)));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const c = r.clone();
        caches.open(V).then(x => x.put(e.request, c));
        return r;
      })
      .catch(() => caches.match(e.request).then(m => m || caches.match('index.html')))
  );
});
