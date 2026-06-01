// Service Worker for Web Push

self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: '駐輪許可証のお知らせ', body: event.data.text() };
  }

  const options = {
    body: data.body || '今日は忘れずに許可証を買おう！',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200, 100, 200],
    tag: 'bicycle-reminder',
    requireInteraction: false,
    data: { url: self.location.origin }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '駐輪許可証のお知らせ', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(clients.claim()));
