// Guarda a casca do app para abrir rápido e funcionar sem sinal.
const V = 'cprt-aco-v27', ARQ = ['./', 'index.html', 'painel-calc.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', e => {
  self.skipWaiting();
  // cache: 'reload' ignora a cópia guardada pelo navegador, para não instalar um arquivo velho junto com o index.html novo
  e.waitUntil(caches.open(V).then(c => Promise.all(ARQ.map(f =>
    fetch(f, { cache: 'reload' }).then(r => { if (!r.ok) throw new Error('falha ao baixar ' + f); return c.put(f, r); })
  ))));
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
  // rede primeiro, sem aceitar a cópia "fresca" do navegador (que pode ser de uma versão anterior); sem sinal, usa o que está guardado
  const req = e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(req)
      .then(r => {
        const c = r.clone();
        caches.open(V).then(x => x.put(e.request, c));
        return r;
      })
      .catch(() => caches.match(e.request).then(m => m || caches.match('index.html')))
  );
});
