self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('neigame-v1').then((cache) => {
      return cache.addAll([
        '/',
        '/index.html',
        '/output.css',
        '/favicon.ico',
      ]);
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
