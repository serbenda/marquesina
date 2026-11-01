// sw.js — Service worker de marquesina
// =====================================
// Un programa que el navegador guarda junto a la web y ejecuta en segundo plano. Sirve para dos cosas:
//   A. Que la web se pueda instalar como app y abra al instante (guarda una copia de la app).
//   B. Recibir los avisos "¡Sal ya!" aunque la web esté cerrada y enseñarlos como notificación.
//
// ⚠️ Si cambias logic.js, push.js o los iconos, sube VERSION (p. ej. "marquesina-v3"): si no, algunos
//    móviles seguirán con la copia anterior. index.html no lo necesita (va "primero red").
//
// Diagramas: docs/REFERENCIA.md §8 (caché) y §7.5 (notificaciones).
//
// Resumen de estrategias:
// - La página (index.html) va "primero red": siempre la última versión si hay conexión, la guardada si no.
// - Librerías, fuentes e iconos van "primero caché": no cambian.
// - Los datos de autobuses (worker de Cloudflare y repetidor de Deno) y las teselas del mapa NO se guardan: tienen que ser en vivo.
// - Recibe los avisos programados (Web Push) y los muestra como notificación.

const VERSION = "marquesina-v4";   // cambiarlo obliga a renovar la caché en todos los dispositivos
const SHELL = [
  "./",
  "./manifest.webmanifest",
  "./logic.js",
  "./push.js",
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
  if (url.hostname.endsWith("workers.dev") || url.hostname === "api.bendi.dev" || url.hostname.endsWith(".deno.net") || url.hostname.endsWith("tile.openstreetmap.org")) return;

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

// ---------- Avisos programados ----------
self.addEventListener("push", e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || "Marquesina", {
    body: msg.body || "",
    tag: msg.tag || "marquesina",
    renotify: true,
    icon: "assets/icono-192.png",
    badge: "assets/icono-192.png",
    vibrate: [200, 100, 200],
    data: { url: msg.url || "./" },
  }));
});

// Al tocar la notificación, abrir (o traer al frente) la app
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(target);
  }));
});
