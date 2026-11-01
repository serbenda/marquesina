// Service worker de marquesina: hace que la web se instale como app y abra al instante.
// - La página (index.html) va "primero red": siempre la última versión si hay conexión, la guardada si no.
// - Librerías, fuentes e iconos van "primero caché": no cambian.
// - Los datos de autobuses (worker de Cloudflare) y las teselas del mapa NO se guardan: tienen que ser en vivo.

const VERSION = "marquesina-v1";   // cambiarlo obliga a renovar la caché en todos los dispositivos
const SHELL = [
  "./",
  "./manifest.webmanifest",
  "./assets/icono-192.png",
  "./assets/icono-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Datos en vivo y mapa: siempre de la red
  if (url.hostname.endsWith("workers.dev") || url.hostname.endsWith("tile.openstreetmap.org")) return;

  // La página: primero red, si falla la guardada
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put("./", copy)); return res; })
        .catch(() => caches.match("./"))
    );
    return;
  }

  // Estáticos (mismo origen, cdnjs, Google Fonts): primero caché
  if (url.origin === location.origin || /cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }))
    );
  }
});
