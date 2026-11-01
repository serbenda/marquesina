// Tests del worker (worker.js) y de Web Push (push.js) sin Cloudflare: se simulan el Durable Object,
// la red y el reloj. Se ejecutan con: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { encryptPayload, generateVapidKeys, b64url, unb64url, isPushEndpoint } from "../push.js";

// ---------- Carga worker.js sustituyendo el módulo "cloudflare:workers" por una clase simulada ----------
const tmp = new URL("./.tmp/", import.meta.url);
mkdirSync(tmp, { recursive: true });
writeFileSync(new URL("worker.mjs", tmp), readFileSync(new URL("../worker.js", import.meta.url), "utf8")
  .replace('import { DurableObject } from "cloudflare:workers";',
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }")
  .replaceAll('"./logic.js"', '"../../logic.js"').replaceAll('"./push.js"', '"../../push.js"'));
const worker = await import(new URL("worker.mjs", tmp));

class MemStorage {
  constructor() { this.m = new Map(); }
  async get(k) { return structuredClone(this.m.get(k)); }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = "", limit = Infinity } = {}) {
    return new Map([...this.m].filter(([k]) => k.startsWith(prefix)).slice(0, limit));
  }
}

// Suscripción de un "navegador" simulado
async function fakeBrowser() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { endpoint: "https://fcm.googleapis.com/fcm/send/test-" + Math.random(), keys: { p256dh: b64url(pub), auth: b64url(auth) }, priv: kp.privateKey };
}

// Descifra lo que llega al navegador (RFC 8291), para comprobar el texto de la notificación
async function decrypt(browser, body) {
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, browser.priv, 256));
  const hk = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const te = new TextEncoder();
  const uaPub = unb64url(browser.keys.p256dh);
  const ikm = await hk(unb64url(browser.keys.auth), shared, new Uint8Array([...te.encode("WebPush: info\u0000"), ...uaPub, ...asPub]), 32);
  const cek = await hk(salt, ikm, te.encode("Content-Encoding: aes128gcm\u0000"), 16);
  const nonce = await hk(salt, ikm, te.encode("Content-Encoding: nonce\u0000"), 12);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce },
    await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
  assert.equal(pt.at(-1), 2);
  return JSON.parse(new TextDecoder().decode(pt.slice(0, -1)));
}

test("encryptPayload produce un mensaje que el navegador puede descifrar", async () => {
  const b = await fakeBrowser();
  const body = await encryptPayload(b, JSON.stringify({ title: "Hola" }));
  assert.deepEqual(await decrypt(b, body), { title: "Hola" });
});

test("solo se envía a servicios de push conocidos", () => {
  assert.equal(isPushEndpoint("https://fcm.googleapis.com/fcm/send/x"), true);
  assert.equal(isPushEndpoint("https://web.push.apple.com/x"), true);
  assert.equal(isPushEndpoint("https://updates.push.services.mozilla.com/x"), true);
  assert.equal(isPushEndpoint("https://evil.example.com/x"), false);
  assert.equal(isPushEndpoint("http://fcm.googleapis.com/x"), false);
});

test("PushHub: suscribe, avisa una sola vez cuando toca salir y limpia suscripciones caducadas", async (t) => {
  const storage = new MemStorage();
  const hub = new worker.PushHub({ storage }, {});
  const browser = await fakeBrowser();
  const sub = { endpoint: browser.endpoint, keys: browser.keys };

  // La clave pública se genera una vez y se reutiliza
  const k1 = await (await hub.fetch(new Request("https://hub/key"))).json();
  const k2 = await (await hub.fetch(new Request("https://hub/key"))).json();
  assert.equal(k1.publicKey, k2.publicKey);
  assert.equal(unb64url(k1.publicKey).length, 65);

  // Aviso todos los días, todo el día, parada 06756, 5 min andando, avisar cuando falten 2 min para salir
  const alert = { id: "cole", net: "crtm", stop: "06756", alias: "Cole", walk: 5, lead: 2, line: "", days: [1, 2, 3, 4, 5, 6, 7], from: "00:00", to: "23:59" };
  const r = await (await hub.fetch(new Request("https://hub/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub, alerts: [alert, { id: "malo" }] }) }))).json();
  assert.deepEqual(r, { ok: true, alerts: 1 });   // el aviso incompleto se descarta

  // Red simulada: el Consorcio devuelve un 153 que llega en 6 min (salir en 1 min) y otro en 30 min
  const sent = [];
  let pushStatus = 201;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    url = String(url);
    if (url.includes("GetStopsTimes")) {
      const now = Date.now();
      const time = s => new Date(now + s * 1000).toISOString();
      return Response.json({ stopTimes: { actualDate: new Date(now).toISOString(), stop: { name: "MARQUÉS VALDAVIA" }, times: { Time: [
        { line: { codLine: "8__153___", shortDescription: "153" }, direction: 1, destination: "MADRID-SAN S. REYES", time: time(360), codIssue: "VCM1" },
        { line: { codLine: "8__153___", shortDescription: "153" }, direction: 1, destination: "MADRID-SAN S. REYES", time: time(1800), codIssue: "VCM2" },
      ] } } });
    }
    if (url.startsWith("https://fcm.googleapis.com/")) {
      assert.match(init.headers.Authorization, /^vapid t=.+, k=.+$/);
      assert.equal(init.headers["Content-Encoding"], "aes128gcm");
      sent.push(await decrypt(browser, new Uint8Array(init.body)));
      return new Response(null, { status: pushStatus });
    }
    throw new Error("URL inesperada " + url);
  });

  const c1 = await hub.check();
  assert.deepEqual(c1, { checked: 1, sent: 1 });
  assert.equal(sent[0].title, "¡Sal ya! 153 · Cole");
  assert.match(sent[0].body, /SAN S\. REYES · pasa en 6 min\. Tardas 5 min andando\./);

  // Al minuto siguiente es el mismo bus: no se repite
  const c2 = await hub.check();
  assert.deepEqual(c2, { checked: 1, sent: 0 });
  assert.equal(sent.length, 1);

  // Si el servicio de push dice que la suscripción ya no existe, se borra
  await storage.put("sent", {});
  pushStatus = 410;
  await hub.check();
  assert.equal((await storage.list({ prefix: "sub:" })).size, 0);
});

test("PushHub: fuera de la franja horaria no consulta nada", async () => {
  const storage = new MemStorage();
  const hub = new worker.PushHub({ storage }, {});
  const b = await fakeBrowser();
  await hub.fetch(new Request("https://hub/subscribe", { method: "POST", body: JSON.stringify({
    subscription: { endpoint: b.endpoint, keys: b.keys },
    alerts: [{ id: "x", net: "emt", stop: "69", walk: 3, days: [], from: "08:00", to: "09:00" }],   // sin días: inválido
  }) }));
  assert.deepEqual(await hub.check(), { checked: 0, sent: 0 });
});

test("PushHub rechaza suscripciones a URLs que no son servicios de push", async () => {
  const hub = new worker.PushHub({ storage: new MemStorage() }, {});
  const res = await hub.fetch(new Request("https://hub/subscribe", { method: "POST", body: JSON.stringify({
    subscription: { endpoint: "https://evil.example.com/x", keys: { p256dh: "a", auth: "b" } }, alerts: [],
  }) }));
  assert.equal(res.status, 400);
});

test("/crtm/stop junta parada, tiempos y posición de los buses en una sola respuesta", async (t) => {
  const times = JSON.parse(readFileSync(new URL("./fixtures/crtm-stoptimes-06756.json", import.meta.url), "utf8"));
  const loc = JSON.parse(readFileSync(new URL("./fixtures/crtm-linelocation-153.json", import.meta.url), "utf8"));
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    url = String(url); calls.push(url);
    if (url.includes("GetStops.php")) return Response.json({ stops: { Stop: { name: "MARQUÉS VALDAVIA", coordinates: { latitude: 40.54, longitude: -3.63 } } } });
    if (url.includes("GetStopsTimes")) return Response.json(times);
    if (url.includes("GetLinesInformation")) {
      const cod = decodeURIComponent(url.match(/codLine=([^&]+)/)[1]);
      return Response.json({ lines: { LineInformation: { itinerary: { Itinerary: [{ codItinerary: cod + "_1", direction: 1, stops: { StopInformation: [{ codStop: "8_06756" }] } }] } } } });
    }
    if (url.includes("GetLineLocation")) return Response.json(url.includes("8__153___") ? loc : {});
    throw new Error("URL inesperada " + url);
  });
  const res = await worker.default.fetch(new Request("https://w/crtm/stop/06756", { headers: { Origin: "https://bendi.dev" } }), {}, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://bendi.dev");
  const j = await res.json();
  assert.deepEqual(j.stop, { name: "MARQUÉS VALDAVIA", pos: [40.54, -3.63] });
  assert.equal(j.stopTimes.times.Time.length, 6);
  assert.deepEqual(j.vehicles.map(v => v.key), ["v-1628MVP"]);
  // Posición solo de autobuses (8 y 9): las 6 líneas de la parada lo son, una consulta por línea
  assert.equal(calls.filter(u => u.includes("GetLineLocation")).length, 6);
  // Códigos no válidos no llegan al Consorcio
  const bad = await worker.default.fetch(new Request("https://w/crtm/stop/abc"), {}, {});
  assert.equal(bad.status, 404);
});

test("/emt/near consulta las paradas cercanas en la API de EMT (El Pardo)", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    url = String(url); calls.push(url);
    if (url.includes("/user/login/")) return Response.json({ code: "01", data: [{ accessToken: "tok", tokenSecExpiration: 3600 }] });
    if (url.includes("/stops/arroundxy/")) {
      assert.equal(init.headers.accessToken, "tok");
      return Response.json({ code: "00", data: [{ stopId: 4876, stopName: "El Pardo", geometry: { coordinates: [-3.7745, 40.518] }, lines: [{ label: "601" }] }] });
    }
    throw new Error("URL inesperada " + url);
  });
  const res = await worker.default.fetch(new Request("https://w/emt/near/40.51800/-3.77450/600"), { EMT_EMAIL: "a", EMT_PASSWORD: "b" }, {});
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.data[0].stopId, 4876);
  assert.ok(calls.some(u => u.endsWith("/stops/arroundxy/-3.775/40.518/600/")), "longitud, latitud y radio en el orden de EMT");
  assert.equal((await worker.default.fetch(new Request("https://w/emt/near/x/y/600"), {}, {})).status, 404);
});

test("/crtm/stop no espera más de 2,5 s por la posición de los buses", async (t) => {
  const times = JSON.parse(readFileSync(new URL("./fixtures/crtm-stoptimes-06756.json", import.meta.url), "utf8"));
  // Líneas que el worker aún no tiene en memoria (los tests anteriores ya cargaron las reales)
  for (const x of times.stopTimes.times.Time) x.line.codLine = "8__T" + x.line.codLine;
  t.mock.method(globalThis, "fetch", async (url) => {
    url = String(url);
    if (url.includes("GetStops.php")) return Response.json({ stops: { Stop: { name: "X", coordinates: { latitude: 1, longitude: 2 } } } });
    if (url.includes("GetStopsTimes")) return Response.json(times);
    // El Consorcio tarda mucho en dar los recorridos de las líneas
    if (url.includes("GetLinesInformation")) { await new Promise(r => setTimeout(r, 4000)); return Response.json({}); }
    return Response.json({});
  });
  const pending = [];
  const t0 = Date.now();
  const res = await worker.default.fetch(new Request("https://w/crtm/stop/8_09999"), {}, { waitUntil: p => pending.push(p) });
  const ms = Date.now() - t0;
  const j = await res.json();
  assert.ok(ms < 3500, `respondió en ${ms} ms`);
  assert.equal(j.stopTimes.times.Time.length, 6);   // los tiempos llegan igualmente
  assert.deepEqual(j.vehicles, []);
  assert.equal(pending.length, 1);                  // la posición se sigue cargando en segundo plano
  await Promise.all(pending);
});

test("/emt/near guarda en caché la respuesta 'sin paradas' (código 01) sin reintentar", async (t) => {
  let logins = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    url = String(url);
    if (url.includes("/user/login/")) { logins++; return Response.json({ code: "01", data: [{ accessToken: "tok2", tokenSecExpiration: 3600 }] }); }
    if (url.includes("/stops/arroundxy/")) return Response.json({ code: "01", description: "NO data found" });
    throw new Error("URL inesperada " + url);
  });
  const res = await worker.default.fetch(new Request("https://w/emt/near/40.54000/-3.64000/350"), { EMT_EMAIL: "a", EMT_PASSWORD: "b" }, {});
  assert.equal((await res.json()).code, "01");
  assert.ok(logins <= 1, "no fuerza un segundo inicio de sesión");
});

test("Consorcio con errores: reintenta y, si sigue fallando, devuelve los últimos datos buenos", async (t) => {
  const times = JSON.parse(readFileSync(new URL("./fixtures/crtm-stoptimes-06756.json", import.meta.url), "utf8"));
  for (const x of times.stopTimes.times.Time) x.line.codMode = "4";   // sin posiciones, para aislar los tiempos
  // Caché simulada (Cache API de Cloudflare)
  const store = new Map();
  const prevCaches = globalThis.caches;
  globalThis.caches = { default: { match: async k => store.has(k.url) ? new Response(store.get(k.url)) : undefined, put: async (k, r) => store.set(k.url, await r.text()) } };
  t.after(() => { globalThis.caches = prevCaches; });
  let mode = "ok", calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    url = String(url);
    if (url.includes("GetStops.php")) return Response.json({ stops: { Stop: { name: "X" } } });
    if (url.includes("GetStopsTimes")) {
      calls++;
      if (mode === "flaky" && calls % 2 === 1) return new Response("<html>502</html>", { status: 502 });
      if (mode === "down") return new Response("<html>502</html>", { status: 502 });
      return Response.json(times);
    }
    throw new Error("URL inesperada " + url);
  });
  const get = () => worker.default.fetch(new Request("https://w/crtm/stop/8_07777"), {}, {});
  // 1. Funciona y guarda los datos buenos
  assert.equal((await get()).status, 200);
  // 2. Falla una vez: el reintento lo arregla
  mode = "flaky"; calls = 0;
  const r2 = await get();
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).stale, undefined);
  assert.equal(calls, 2);
  // 3. Caído: devuelve los últimos datos buenos marcados como antiguos
  mode = "down";
  const r3 = await get();
  assert.equal(r3.status, 200);
  const j3 = await r3.json();
  assert.equal(j3.stale, true);
  assert.equal(j3.stopTimes.times.Time.length, 6);
  // 4. Caído y sin datos guardados de esa parada: error claro
  const r4 = await worker.default.fetch(new Request("https://w/crtm/stop/8_08888"), {}, {});
  assert.equal(r4.status, 502);
});

test("/crtm/Get… funciona con y sin \".php\" (el repetidor de Deno rechaza las rutas .php)", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => { calls.push(String(url)); return new Response('{"stops":{"Stop":[]}}'); });
  const q = "?latitude=40.54&longitude=-3.64&mode=&method=1&precision=700";
  for (const path of ["/crtm/GetNearestStopsByLocation", "/crtm/GetNearestStopsByLocation.php"]) {
    const res = await worker.default.fetch(new Request("https://w" + path + q, { headers: { Origin: "https://bendi.dev" } }), {}, {});
    assert.equal(res.status, 200, path);
  }
  // Las dos acaban en la misma URL del Consorcio, siempre con ".php"
  assert.deepEqual(calls, Array(2).fill("https://www.crtm.es/widgets/api/GetNearestStopsByLocation.php" + q));
  // Lo que no sea Get<Letras> sigue sin pasar
  for (const bad of ["/crtm/Evil.php", "/crtm/GetX.js", "/crtm/../GetStops", "/crtm/GetStops.php.php"]) {
    assert.equal((await worker.default.fetch(new Request("https://w" + bad), {}, {})).status, 404, bad);
  }
  assert.equal(calls.length, 2);
});

test("la búsqueda de paradas del Consorcio se guarda 1 día y la segunda vez no se le pregunta", async (t) => {
  const store = new Map();
  const prevCaches = globalThis.caches;
  globalThis.caches = { default: { match: async k => store.has(k.url) ? new Response(store.get(k.url)) : undefined, put: async (k, r) => store.set(k.url, await r.text()) } };
  t.after(() => { globalThis.caches = prevCaches; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response('{"stops":{"Stop":[{"codStop":"8_06756"}]}}'); });
  const url = "https://w/crtm/GetNearestStopsByLocation?latitude=40.540&longitude=-3.640&mode=&method=1&precision=700";
  for (let i = 0; i < 2; i++) {
    const res = await worker.default.fetch(new Request(url, { headers: { Origin: "https://bendi.dev" } }), {}, {});
    assert.equal(res.status, 200);
    assert.match(await res.text(), /8_06756/);
    assert.equal(res.headers.get("Cache-Control"), "max-age=3600");
  }
  assert.equal(calls, 1);
  // Los tiempos de llegada NO se guardan así: cada vez se preguntan
  await worker.default.fetch(new Request("https://w/crtm/GetStopsTimes?codStop=8_06756"), {}, {});
  await worker.default.fetch(new Request("https://w/crtm/GetStopsTimes?codStop=8_06756"), {}, {});
  assert.equal(calls, 3);
});
