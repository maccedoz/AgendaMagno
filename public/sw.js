const CACHE = 'agendamagno-shell-v2';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/', '/icon.svg', '/manifest.webmanifest'])));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('agendamagno-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode !== 'navigate' && !url.pathname.startsWith('/_next/static/') && !['/icon.svg', '/icon-maskable.svg', '/manifest.webmanifest'].includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request.mode === 'navigate' ? '/' : event.request, response.clone());
      return response;
    } catch {
      const stored = await cache.match(event.request.mode === 'navigate' ? '/' : event.request);
      return stored || new Response('Abra a agenda com internet antes de usar offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
// Lembrete enviado pelo servidor (Web Push). A tag é a mesma do aviso da tela aberta: se a
// agenda estiver aberta neste aparelho e também avisar, o navegador troca um pelo outro em
// silêncio em vez de mostrar dois. Sempre exibe algo — o navegador exige aviso visível a cada push.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'AgendaMagna · Lembrete', {
    body: data.body || '',
    icon: '/icon.svg',
    tag: data.tag,
    data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  // Só abre endereços do próprio app, mesmo que o conteúdo do push traga outro.
  const url = target.origin === self.location.origin ? target.href : '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => windows[0] ? windows[0].focus() : self.clients.openWindow(url)));
});
