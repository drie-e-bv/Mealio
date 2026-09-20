// Mealio service worker — nodig voor "App installeren" en een basis
// offline-modus. Cachet alleen de app-schil (HTML/manifest/iconen);
// Supabase-verkeer gaat altijd rechtstreeks naar het netwerk, anders zie
// je verouderde weekmenu's/recepten.
//
// Cache-versie ophogen (v1 -> v2 -> ...) forceert bij elke deploy een
// schone cache; dat gebeurde niet vanzelf zolang dit bestand zelf niet
// wijzigde, waardoor een oude/kapotte index.html kon "vastzitten".
const CACHE_NAME = 'mealio-shell-v2';
const SHELL_FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Nooit cachen: Supabase (data moet altijd vers zijn) en niet-GET requests.
  if (event.request.method !== 'GET' || url.hostname.endsWith('supabase.co')) return;

  // HTML/navigatie: NETWERK-EERST. Zo kan een nieuwe deploy nooit "vastzitten"
  // achter een oude gecachete pagina — alleen zonder internet valt dit terug
  // op de laatst gekende versie.
  const isHtml = event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  if (isHtml) {
    event.respondWith(
      fetch(event.request).then((res) => {
        if (res && res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Statische assets (iconen, manifest): cache-eerst, met een verse kopie
  // op de achtergrond — verandert zelden, dus geen probleem.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((res) => {
        if (res && res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
