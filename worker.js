// Proxy y avisos de marquesina (Cloudflare Workers, plan gratuito).
//
//  /crtm/<Get*.php>?...   -> API del Consorcio de Transportes (www.crtm.es/widgets/api): tiempos y
//                            posición de interurbanos, urbanos de otros municipios y Metro.
//                            El Consorcio no permite llamadas desde otras webs (CORS).
//  /crtm/stop/<parada>    -> Todo lo de una parada del Consorcio en una sola respuesta: datos de la
//                            parada, tiempos (GetStopsTimes) y posición GPS de los buses de cada línea
//                            (GetLinesInformation + GetLineLocation). Ahorra peticiones a la web.
//  /emt/near/<lat>/<lon>/<radio> -> Paradas de EMT cercanas (API de EMT): incluye las que el Consorcio
//                            no tiene, como las de El Pardo.
//  /emt/arrives/<parada>  -> Llegadas de EMT Madrid (con posición GPS de cada bus). El worker inicia
//                            sesión en Mobility Labs, así nadie tiene que registrarse.
//  /push/key              -> Clave pública VAPID para suscribirse a las notificaciones.
//  /push/subscribe        -> (POST) Guarda o actualiza una suscripción y sus avisos.
//  /push/unsubscribe      -> (POST) Borra una suscripción.
//  /push/test             -> (POST) Envía una notificación de prueba a una suscripción.
//  Cron (cada minuto)     -> Revisa los avisos activos y envía "Sal ya" cuando toca.
//
// Las suscripciones viven en un Durable Object (PushHub, almacenamiento SQLite del plan gratuito).
// Secretos (Cloudflare > Worker > Settings > Variables and Secrets), al menos una pareja:
//   EMT_CLIENT_ID + EMT_PASSKEY   -> claves de la aplicación marquesina en Mobility Labs (preferido)
//   EMT_EMAIL + EMT_PASSWORD      -> cuenta de Mobility Labs (respaldo, p. ej. con el código 84)
//
// Despliegue: automático desde GitHub (.github/workflows/worker.yml, con wrangler.toml).

import { DurableObject } from "cloudflare:workers";
import { parseEmt, parseCrtmTimes, parseCrtmVehicles, bestLeave, alertActive, leaveMessage, crtmCode, asArray } from "./logic.js";
import { generateVapidKeys, sendPush, isPushEndpoint } from "./push.js";

const EMT = "https://openapi.emtmadrid.es";
const CRTM = "https://www.crtm.es/widgets/api";
const ALLOWED_ORIGINS = ["https://bendi.dev", "https://serbenda.github.io"];
const CACHE_SECONDS = 10;      // las fuentes refrescan cada ~15-30 s: más no aporta datos nuevos
const MAX_ALERTS = 10;          // avisos por suscripción
const MAX_SUBSCRIPTIONS = 1000; // suscripciones en total

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

const json = (obj, status = 200, cors = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

const withCors = (res, cors) => {
  res = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
};

// ---------- Sesión de EMT (se reutiliza mientras el worker siga activo) ----------
let emtToken = null, emtTokenExp = 0;

async function emtLogin(env, force = false) {
  if (!force && emtToken && Date.now() < emtTokenExp) return emtToken;

  // Formas de entrar, por orden de preferencia
  const methods = [];
  if (env.EMT_CLIENT_ID && env.EMT_PASSKEY) methods.push(["aplicación", { "X-ClientId": env.EMT_CLIENT_ID, passKey: env.EMT_PASSKEY }]);
  if (env.EMT_EMAIL && env.EMT_PASSWORD)    methods.push(["cuenta", { email: env.EMT_EMAIL, password: env.EMT_PASSWORD }]);
  if (!methods.length) throw new Error("Faltan los secretos de EMT en el worker (EMT_CLIENT_ID y EMT_PASSKEY, o EMT_EMAIL y EMT_PASSWORD)");

  const errors = [];
  for (const [name, headers] of methods) {
    const r = await fetch(`${EMT}/v2/mobilitylabs/user/login/`, { headers });
    let j = {};
    try { j = await r.json(); } catch {}
    const d = j.data && j.data[0];
    if (d && d.accessToken) {
      emtToken = d.accessToken;
      emtTokenExp = Date.now() + ((d.tokenSecExpiration || 3600) - 120) * 1000;
      return emtToken;
    }
    errors.push(`${name}: código ${j.code || r.status}${j.description ? " " + j.description : ""}`);
  }
  throw new Error(`EMT rechazó el inicio de sesión (${errors.join("; ")})`);
}

async function emtArrivals(stop, env) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const body = JSON.stringify({
    cultureInfo: "ES", Text_StopRequired_YN: "Y", Text_EstimationsRequired_YN: "Y",
    Text_IncidencesRequired_YN: "N", DateTime_Referenced_Incidencies_YYYYMMDD: today,
  });
  for (const force of [false, true]) {   // si el token ha caducado, se renueva y se reintenta una vez
    const token = await emtLogin(env, force);
    const r = await fetch(`${EMT}/v2/transport/busemtmad/stops/${stop}/arrives/`, {
      method: "POST", headers: { accessToken: token, "Content-Type": "application/json" }, body,
    });
    const j = await r.json();
    if (r.status !== 401 && j.data) return j;
    if (force) return j;
  }
}

// Paradas de EMT alrededor de un punto. Las paradas casi no cambian: caché de 1 día por punto redondeado (~100 m)
async function emtNear(lat, lon, radius, env, ctx) {
  const r = Math.max(50, Math.min(1500, Math.round(radius)));
  const la = lat.toFixed(3), lo = lon.toFixed(3);
  const cache = globalThis.caches && caches.default;
  const key = new Request(`https://cache.marquesina/emt-near/${la}/${lo}/${r}`);
  try { const hit = cache && await cache.match(key); if (hit) return hit.json(); } catch {}
  let data;
  for (const force of [false, true]) {
    const token = await emtLogin(env, force);
    const res = await fetch(`${EMT}/v2/transport/busemtmad/stops/arroundxy/${lo}/${la}/${r}/`, { headers: { accessToken: token } });
    data = await res.json();
    if (res.status !== 401 && data && (data.data || data.code === "01")) break;   // 01 = no hay paradas: respuesta válida
  }
  if (cache && data && (Array.isArray(data.data) || data.code === "01")) {
    const put = cache.put(key, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" } })).catch(() => {});
    ctx && ctx.waitUntil ? ctx.waitUntil(put) : await put;
  }
  return data;
}

// Llegadas de EMT con caché de 20 s compartida (web y avisos)
async function emtArrivalsCached(stop, env, ctx) {
  const cache = globalThis.caches && caches.default;
  const key = new Request(`https://cache.marquesina/emt/${stop}`);
  try { const hit = cache && await cache.match(key); if (hit) return hit.json(); } catch {}
  const data = await emtArrivals(stop, env);
  if (cache && data && data.data) {
    const res = new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `max-age=${CACHE_SECONDS}` },
    });
    const put = cache.put(key, res).catch(() => {});
    ctx && ctx.waitUntil ? ctx.waitUntil(put) : await put;
  }
  return data;
}

// ---------- Parada del Consorcio completa ----------
// El Consorcio a veces responde con error (502/500, o una página HTML) cuando le llegan muchas peticiones
// a la vez. Se reintenta una vez tras una pausa corta.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function crtmFetch(pathAndQuery, ttl = CACHE_SECONDS) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(400);
    try {
      const r = await fetch(`${CRTM}/${pathAndQuery}`, { cf: { cacheTtl: ttl } });
      const text = await r.text();
      if (r.ok && /^\s*[{[]/.test(text)) return text;
      last = new Error(`Consorcio ${r.status}`);
    } catch (e) { last = e; }
  }
  throw last;
}
const crtmGet = async (path, ttl = CACHE_SECONDS) => JSON.parse(await crtmFetch(path, ttl));

// Pide en paralelo como mucho "n" a la vez (para no saturar al Consorcio)
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// Últimos tiempos buenos de cada parada (15 min): si el Consorcio falla, mejor eso que un error
const lastGoodKey = code => new Request(`https://cache.marquesina/crtm-last/${code}`);
async function saveLastGood(code, data, ctx) {
  const cache = globalThis.caches && caches.default;
  if (!cache) return;
  const put = cache.put(lastGoodKey(code), new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=900" } })).catch(() => {});
  ctx && ctx.waitUntil ? ctx.waitUntil(put) : await put;
}
async function readLastGood(code) {
  try { const hit = globalThis.caches && await caches.default.match(lastGoodKey(code)); return hit ? hit.json() : null; } catch { return null; }
}

// Itinerarios de cada línea: no cambian, se guardan en memoria y 1 día en la caché de Cloudflare
const lineCache = new Map();
function crtmItineraries(codLine) {
  if (!lineCache.has(codLine)) {
    lineCache.set(codLine, crtmGet(`GetLinesInformation.php?activeItinerary=1&codLine=${encodeURIComponent(codLine)}`, 86400)
      .then(j => {
        const info = asArray(j.lines && j.lines.LineInformation)[0] || {};
        return asArray(info.itinerary && info.itinerary.Itinerary).map(it => ({
          cod: it.codItinerary, dir: it.direction,
          stops: new Set(asArray(it.stops && it.stops.StopInformation).map(st => st.codStop)),
        }));
      })
      .catch(() => { lineCache.delete(codLine); return []; }));
  }
  return lineCache.get(codLine);
}

// La posición de los buses no puede retrasar los tiempos: se espera como mucho VEHICLES_WAIT_MS.
// Si tarda más (el Consorcio a veces tarda segundos en dar los recorridos), se termina en segundo plano
// y se devuelve la última posición conocida (de hace menos de 1 min) o ninguna.
const VEHICLES_WAIT_MS = 2500;
const lastVehicles = new Map();   // parada -> {at, list}

async function crtmStop(code, ctx) {
  let info, times;
  try {
    [info, times] = await Promise.all([
      crtmGet(`GetStops.php?codStop=${code}`, 86400).catch(() => ({})),
      crtmGet(`GetStopsTimes.php?codStop=${code}&type=1&orderBy=2&stopTimesByIti=3`),
    ]);
  } catch (e) {
    const prev = await readLastGood(code);
    if (prev) return { ...prev, stale: true };   // la web la muestra como datos anteriores
    throw e;
  }
  const s = asArray(info.stops && info.stops.Stop)[0] || {};
  // Posición de los buses de cada línea y sentido (solo autobuses: 8 interurbanos, 9 urbanos)
  const lines = new Map();
  for (const t of asArray(times.stopTimes && times.stopTimes.times && times.stopTimes.times.Time))
    if (t.line && ["8", "9"].includes(String(t.line.codMode)) && !lines.has(`${t.line.codLine}|${t.direction}`))
      lines.set(`${t.line.codLine}|${t.direction}`, t);
  const vehiclesP = pool([...lines.values()], 3, async t => {
    try {
      const its = await crtmItineraries(t.line.codLine);
      const it = its.find(i => i.dir == t.direction && i.stops.has(code)) || its.find(i => i.stops.has(code));
      if (!it) return [];
      const j = await crtmGet(`GetLineLocation.php?mode=${t.line.codMode}&codItinerary=${encodeURIComponent(it.cod)}&codLine=${encodeURIComponent(t.line.codLine)}&codStop=${code}&direction=${it.dir}`);
      return parseCrtmVehicles(j, { codLine: t.line.codLine, line: t.line.shortDescription, dest: (t.destination || "").replace(/^.*?-\s*/, "") || t.destination });
    } catch { return []; }   // si falla la posición de una línea, siguen valiendo los tiempos
  }).then(list => { const flat = list.flat(); lastVehicles.set(code, { at: Date.now(), list: flat }); return flat; });
  let vehicles = await Promise.race([vehiclesP, new Promise(r => setTimeout(() => r(null), VEHICLES_WAIT_MS))]);
  if (vehicles === null) {
    if (ctx && ctx.waitUntil) ctx.waitUntil(vehiclesP.catch(() => {}));
    const prev = lastVehicles.get(code);
    vehicles = prev && Date.now() - prev.at < 60000 ? prev.list : [];
  }
  const result = {
    stop: { name: s.name || (times.stopTimes && times.stopTimes.stop && times.stopTimes.stop.name) || "",
            pos: s.coordinates ? [s.coordinates.latitude, s.coordinates.longitude] : null },
    stopTimes: times.stopTimes || null,
    vehicles,
  };
  if (result.stopTimes) await saveLastGood(code, result, ctx);
  return result;
}

// ---------- Avisos: validación de lo que manda la web ----------
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
function cleanAlerts(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ALERTS).map(a => ({
    id: String(a.id || "").slice(0, 40),
    net: a.net === "emt" ? "emt" : "crtm",
    stop: String(a.stop || "").replace(/[^\d_]/g, "").slice(0, 10),
    alias: String(a.alias || "").slice(0, 24),
    line: String(a.line || "").slice(0, 8),
    walk: Math.max(0, Math.min(60, Number(a.walk) || 0)),
    lead: Math.max(0, Math.min(15, Number(a.lead) || 0)),
    days: (Array.isArray(a.days) ? a.days : []).map(Number).filter(d => d >= 1 && d <= 7),
    from: TIME.test(a.from) ? a.from : "07:00",
    to: TIME.test(a.to) ? a.to : "09:00",
  })).filter(a => a.id && a.stop && a.walk && a.days.length);
}

const subId = async endpoint =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)))]
    .slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");

// ---------- Durable Object: suscripciones y envío de avisos ----------
export class PushHub extends DurableObject {
  async vapid() {
    let v = await this.ctx.storage.get("vapid");
    if (!v) { v = await generateVapidKeys(); await this.ctx.storage.put("vapid", v); }
    return v;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/key") return json({ publicKey: (await this.vapid()).publicKey });

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const sub = body.subscription;
    if (!sub || !isPushEndpoint(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
      return json({ error: "Suscripción no válida" }, 400);
    const id = await subId(sub.endpoint);

    if (url.pathname === "/subscribe") {
      const exists = await this.ctx.storage.get(`sub:${id}`);
      if (!exists && (await this.ctx.storage.list({ prefix: "sub:", limit: MAX_SUBSCRIPTIONS })).size >= MAX_SUBSCRIPTIONS)
        return json({ error: "Se ha alcanzado el máximo de suscripciones" }, 503);
      const alerts = cleanAlerts(body.alerts);
      await this.ctx.storage.put(`sub:${id}`, { subscription: { endpoint: sub.endpoint, keys: sub.keys }, alerts, updated: Date.now() });
      return json({ ok: true, alerts: alerts.length });
    }
    if (url.pathname === "/unsubscribe") {
      await this.ctx.storage.delete(`sub:${id}`);
      return json({ ok: true });
    }
    if (url.pathname === "/test") {
      const status = await sendPush(sub, {
        title: "Marquesina: avisos activados",
        body: "Así te llegarán los avisos para salir de casa.",
        tag: "marquesina-prueba",
      }, await this.vapid(), 60);
      return json({ ok: status >= 200 && status < 300, status });
    }
    return json({ error: "No encontrado" }, 404);
  }

  // Llamado por el cron cada minuto (RPC). Usa this.env: los secretos de EMT llegan al Durable Object.
  async check() {
    const env = this.env;
    const now = new Date();
    const subs = await this.ctx.storage.list({ prefix: "sub:" });
    const active = [];
    for (const [key, rec] of subs) for (const a of rec.alerts || []) if (alertActive(a, now)) active.push({ key, rec, a });
    if (!active.length) return { checked: 0, sent: 0 };

    // Cada parada se consulta una sola vez aunque la usen varios avisos
    const stops = new Map();
    const getStop = (net, stop) => {
      const k = `${net}:${stop}`;
      if (!stops.has(k)) stops.set(k, (async () => {
        try {
          if (net === "emt") return parseEmt(await emtArrivalsCached(stop, env), stop);
          const code = crtmCode(stop);
          const j = await (await fetch(`${CRTM}/GetStopsTimes.php?codStop=${code}&type=1&orderBy=2&stopTimesByIti=3`, { cf: { cacheTtl: CACHE_SECONDS } })).json();
          return { id: stop, name: (j.stopTimes && j.stopTimes.stop && j.stopTimes.stop.name) || `Parada ${stop}`, ...parseCrtmTimes(j, code) };
        } catch { return null; }
      })());
      return stops.get(k);
    };

    const vapid = await this.vapid();
    const sent = (await this.ctx.storage.get("sent")) || {};   // avisos ya enviados: no repetir el mismo bus
    let count = 0;
    for (const { key, rec, a } of active) {
      const stop = await getStop(a.net, a.stop);
      if (!stop) continue;
      const best = bestLeave([{ stop, meta: { alias: a.alias, walk: a.walk, fav: true } }], 0, a.line || null);
      if (!best || best.li.leave > a.lead * 60) continue;
      // Identifica el bus por línea y hora prevista de llegada (redondeada a 2 min)
      const busAt = Math.round((now.getTime() + best.li.bus.eta * 1000) / 120000);
      const dedupe = `${key}|${a.id}|${best.group.line}|${busAt}`;
      if (sent[dedupe]) continue;
      const msg = leaveMessage(best);
      const status = await sendPush(rec.subscription, { ...msg, url: "./" }, vapid, 120);
      if (status === 404 || status === 410) { await this.ctx.storage.delete(key); continue; }   // suscripción caducada
      if (status >= 200 && status < 300) { sent[dedupe] = now.getTime(); count++; }
    }
    // Olvida los envíos de hace más de 2 horas
    for (const [k, t] of Object.entries(sent)) if (now.getTime() - t > 2 * 3600 * 1000) delete sent[k];
    await this.ctx.storage.put("sent", sent);
    return { checked: active.length, sent: count };
  }
}

const hub = env => env.PUSH.get(env.PUSH.idFromName("hub"));

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);

    // ---- Parada del Consorcio completa (una sola petición) ----
    const cs = url.pathname.match(/^\/crtm\/stop\/(\d{1,2}_\d{1,6}|\d{1,6})\/?$/);
    if (cs) {
      try { return json(await crtmStop(crtmCode(cs[1]), ctx), 200, { ...cors, "Cache-Control": `max-age=${CACHE_SECONDS}` }); }
      catch (e) { return json({ error: "No se pudo consultar el Consorcio" }, 502, cors); }
    }

    // ---- Consorcio ----
    if (url.pathname.startsWith("/crtm/")) {
      const file = url.pathname.slice("/crtm/".length);
      if (!/^Get[A-Za-z]+\.php$/.test(file)) return new Response("Not found", { status: 404, headers: cors });
      try {
        const text = await crtmFetch(`${file}${url.search}`);
        return new Response(text, { headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `max-age=${CACHE_SECONDS}` } });
      } catch {
        return json({ error: "El Consorcio no responde ahora mismo" }, 502, cors);
      }
    }

    // ---- Paradas de EMT cercanas ----
    const en = url.pathname.match(/^\/emt\/near\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,2}(?:\.\d+)?)\/(\d{1,4})\/?$/);
    if (en) {
      try { return json(await emtNear(Number(en[1]), Number(en[2]), Number(en[3]), env, ctx), 200, cors); }
      catch (e) { return json({ code: "ERR", description: e.message }, 502, cors); }
    }

    // ---- EMT con las claves de marquesina ----
    const m = url.pathname.match(/^\/emt\/arrives\/(\d{1,6})\/?$/);
    if (m) {
      try {
        return json(await emtArrivalsCached(m[1], env, ctx), 200, cors);
      } catch (e) {
        return json({ code: "ERR", description: e.message }, 502, cors);
      }
    }

    // ---- Avisos ----
    const p = url.pathname.match(/^\/push\/(key|subscribe|unsubscribe|test)$/);
    if (p) {
      if (p[1] !== "key" && req.method !== "POST") return json({ error: "Usa POST" }, 405, cors);
      const res = await hub(env).fetch(new Request(`https://hub/${p[1]}`, {
        method: req.method, headers: { "Content-Type": "application/json" },
        body: req.method === "POST" ? await req.text() : undefined,
      }));
      return withCors(res, cors);
    }

    return new Response("Not found", { status: 404, headers: cors });
  },

  // Cron: cada minuto revisa los avisos activos
  async scheduled(event, env, ctx) {
    ctx.waitUntil(hub(env).check());
  },
};
