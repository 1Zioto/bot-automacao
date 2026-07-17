// Service worker do Painel WhatsApp (PWA).
// Estrategia: nunca cacheia /api (sempre dados frescos); o resto e network-first
// com fallback ao cache para funcionar offline e permitir instalacao.
const CACHE = 'wa-painel-v1';

self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    const url = new URL(req.url);
    // Nao intercepta API nem metodos diferentes de GET.
    if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;

    e.respondWith(
        fetch(req)
            .then((resp) => {
                if (resp && resp.status === 200 && url.origin === self.location.origin) {
                    const clone = resp.clone();
                    caches.open(CACHE).then((c) => c.put(req, clone));
                }
                return resp;
            })
            .catch(() => caches.match(req))
    );
});
