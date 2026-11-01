/**
 * relay/relay.js — Repetidor de respaldo fuera de Cloudflare
 * ==========================================================
 *
 * QUÉ ES
 *   Un intermediario mínimo que recibe las peticiones de la web y las reenvía, tal cual, al worker
 *   de Cloudflare (worker.js). No sabe nada de autobuses ni guarda nada: solo hace de "puente".
 *
 * POR QUÉ EXISTE
 *   Durante los partidos de LaLiga, Movistar, MasOrange, Vodafone y DIGI bloquean por orden judicial
 *   direcciones IP de Cloudflare. Esas IP las comparten miles de webs, también las del worker de
 *   marquesina (api.bendi.dev y *.workers.dev). Este repetidor vive en otro proveedor (Deno Deploy),
 *   con otras IP. El bloqueo solo afecta a los clientes de esas operadoras, no a la conexión entre
 *   servidores, así que el repetidor sí llega al worker.
 *
 *     Web ──✗── api.bendi.dev                 (bloqueado en tu red durante un partido)
 *     Web ──✓── repetidor (Deno) ──✓── worker  (de servidor a servidor: sin bloqueo)
 *
 * QUÉ HACE
 *   - Solo deja pasar las rutas del worker: /crtm/…, /emt/… y /push/…. El resto: 404.
 *   - Reenvía GET y POST (con su cuerpo, como mucho 16 KB) y responde a OPTIONS (CORS).
 *   - Prueba primero api.bendi.dev y, si no responde, marquesina.serbenda.workers.dev (24 s en total).
 *   - Añade las cabeceras CORS para bendi.dev y serbenda.github.io, igual que el worker.
 *   - No necesita secretos: las claves de EMT siguen solo en Cloudflare.
 *
 * DÓNDE SE EJECUTA
 *   relay/main.js lo arranca en Deno Deploy (ver docs/RESPALDO.md). Este archivo no usa nada propio
 *   de Deno, así que los tests lo prueban con Node (tests/relay.test.js).
 */

export const UPSTREAMS = ["https://api.bendi.dev", "https://marquesina.serbenda.workers.dev"];
export const ALLOWED_ORIGINS = ["https://bendi.dev", "https://serbenda.github.io"];
const ROUTE = /^\/(crtm|emt|push)\//;
const MAX_BODY = 16 * 1024;
const TIMEOUT_MS = 24000;  // la búsqueda de paradas del Consorcio puede tardar 10 s o más; la web le da 25 s

function corsHeaders(req) {
  const origin = req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

/**
 * Atiende una petición. Recibe `fetchFn` para que los tests puedan simular la red.
 * @param {Request} req
 * @param {typeof fetch} fetchFn
 * @returns {Promise<Response>}
 */
export async function handle(req, fetchFn = fetch) {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  if (url.pathname === "/") return json({ ok: true, servicio: "repetidor de marquesina" }, 200, cors);
  if (!ROUTE.test(url.pathname)) return new Response("Not found", { status: 404, headers: cors });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Método no permitido" }, 405, cors);

  let body;
  if (req.method === "POST") {
    body = await req.text();
    if (body.length > MAX_BODY) return json({ error: "Petición demasiado grande" }, 413, cors);
  }

  // Un único plazo para todo: si la primera dirección falla rápido (error de red), queda tiempo para la segunda
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = "sin respuesta";
  for (const base of UPSTREAMS) {
    const left = deadline - Date.now();
    if (left < 500) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), left);
    try {
      const r = await fetchFn(base + url.pathname + url.search, {
        method: req.method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body,
        signal: ctrl.signal,
      });
      // Se copia la respuesta del worker (también sus errores 4xx/5xx, que ya traen un mensaje útil)
      const headers = new Headers(cors);
      for (const h of ["Content-Type", "Cache-Control"]) { const v = r.headers.get(h); if (v) headers.set(h, v); }
      return new Response(await r.arrayBuffer(), { status: r.status, headers });
    } catch (e) {
      lastError = e && e.name === "AbortError" ? "tiempo de espera agotado" : String(e && e.message || e);
    } finally {
      clearTimeout(timer);
    }
  }
  return json({ code: "ERR", error: `El repetidor no pudo llegar al worker (${lastError})` }, 502, cors);
}
