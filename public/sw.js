// Service worker: Web Push notifications (entries/exits, alerts) and opening the right page on tap.
// No offline caching: the dashboard is live data, a stale copy would mislead.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'TBB Dispatcher', body: event.data && event.data.text() }; }
  const opts = {
    body: d.body || '',
    tag: d.tag,
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: { url: d.url || '/' },
    timestamp: Date.now(),
  };
  if (d.image) opts.image = d.image;
  if (d.urgency === 'high') opts.vibrate = [120, 60, 120];
  event.waitUntil(self.registration.showNotification(d.title || 'TBB Dispatcher', opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ type: 'open', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
