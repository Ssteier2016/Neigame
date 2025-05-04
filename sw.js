const CACHE_NAME = 'neighborcoin-v1';
const urlsToCache = [
    '/',
    '/index.html',
    '/icon-192x192.png',
    '/icon-512x512.png',
    'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap',
    'https://cdn.tailwindcss.com',
    'https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.min.js',
    'https://cdn.jsdelivr.net/npm/@emailjs/browser@4.4.1/dist/email.min.js'
];

// Instalación del Service Worker
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Caching resources');
                return cache.addAll(urlsToCache);
            })
            .catch(error => {
                console.error('Error during caching:', error);
            })
    );
    self.skipWaiting();
});

// Activación del Service Worker y limpieza de cachés antiguos
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Manejo de solicitudes de red
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    return response; // Retorna desde caché
                }
                return fetch(event.request).catch(() => {
                    // Fallback para offline
                    return caches.match('/index.html');
                });
            })
            .catch(error => {
                console.error('Fetch error:', error);
            })
    );
});
