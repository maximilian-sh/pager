// Läuft auf dem Handy. Ab hier bestimmen wir selbst, wie die Notification aussieht.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'pager', {
      body: data.body || '',
      icon: 'icon-192.png',
      badge: 'badge.png',
      tag: data.tag,
      data: { url: data.url || './' },
    });

    // Offene Fenster mitziehen, damit ein sichtbarer Thread aktuell bleibt.
    // Spart das Pollen — der Push ist ohnehin schon der Echtzeitkanal.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'push' });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || './';

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = clients.find((client) => client.url.includes(self.location.origin));
    if (open) return open.focus();
    return self.clients.openWindow(target);
  })());
});
