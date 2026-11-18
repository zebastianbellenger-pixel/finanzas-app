// Service worker: lets the installed app open without a connection.
// Network first (always the latest version when online), cached copy as offline fallback.
// Only same-origin GET requests are handled; Google, GitHub and CDN requests go straight to the network.
const CACHE = 'mis-finanzas-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css', 'icons/icon.svg', 'icons/icon-192.png',
  'js/app.js', 'js/bankmail.js', 'js/budget.js', 'js/cartola.js', 'js/charts.js', 'js/cycle.js', 'js/food.js',
  'js/gmail.js', 'js/ledger.js', 'js/payslip.js', 'js/store.js', 'js/sync.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('index.html'))),
  );
});
