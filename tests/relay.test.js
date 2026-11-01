// Tests del repetidor de respaldo (relay/relay.js) con la red simulada. Se ejecutan con: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, UPSTREAMS } from "../relay/relay.js";

const req = (path, init = {}) => new Request("https://marquesina.deno.dev" + path, {
  ...init, headers: { Origin: "https://bendi.dev", ...(init.headers || {}) },
});
const ok = (body, headers = {}) => new Response(body, { status: 200, headers: { "Content-Type": "application/json", ...headers } });

test("reenvía al worker la ruta y la consulta, y copia la respuesta con CORS", async () => {
  const calls = [];
  const r = await handle(req("/crtm/stop/06756?x=1"), async (url, init) => { calls.push([url, init.method]); return ok('{"a":1}', { "Cache-Control": "max-age=10" }); });
  assert.deepEqual(calls, [[UPSTREAMS[0] + "/crtm/stop/06756?x=1", "GET"]]);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"a":1}');
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://bendi.dev");
  assert.equal(r.headers.get("Cache-Control"), "max-age=10");
});

test("si la primera dirección falla, usa la segunda", async () => {
  const calls = [];
  const r = await handle(req("/emt/arrives/69"), async (url) => {
    calls.push(url);
    if (url.startsWith(UPSTREAMS[0])) throw new TypeError("fetch failed");
    return ok('{"code":"00"}');
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].startsWith(UPSTREAMS[1]));
  assert.equal(await r.text(), '{"code":"00"}');
});

test("si no llega a ninguna, responde 502 con un mensaje", async () => {
  const r = await handle(req("/push/key"), async () => { throw new TypeError("fetch failed"); });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, "ERR");
});

test("reenvía el cuerpo de los POST de los avisos", async () => {
  let seen;
  await handle(req("/push/subscribe", { method: "POST", body: '{"subscription":{}}' }), async (url, init) => { seen = init; return ok("{}"); });
  assert.equal(seen.method, "POST");
  assert.equal(seen.body, '{"subscription":{}}');
  assert.equal(seen.headers["Content-Type"], "application/json");
});

test("copia los errores del worker tal cual (por ejemplo, 400 de una suscripción no válida)", async () => {
  const r = await handle(req("/push/test", { method: "POST", body: "{}" }), async () => new Response('{"error":"Suscripción no válida"}', { status: 400 }));
  assert.equal(r.status, 400);
});

test("solo deja pasar las rutas del worker", async () => {
  let called = false;
  const r = await handle(req("/otra/cosa"), async () => { called = true; return ok("{}"); });
  assert.equal(r.status, 404);
  assert.equal(called, false);
});

test("rechaza cuerpos grandes y métodos raros, y contesta a OPTIONS", async () => {
  assert.equal((await handle(req("/push/subscribe", { method: "POST", body: "x".repeat(20000) }), async () => ok("{}"))).status, 413);
  assert.equal((await handle(req("/push/key", { method: "PUT", body: "{}" }), async () => ok("{}"))).status, 405);
  const o = await handle(req("/push/key", { method: "OPTIONS" }), async () => ok("{}"));
  assert.equal(o.status, 200);
  assert.match(o.headers.get("Access-Control-Allow-Methods"), /POST/);
});

test("un origen desconocido recibe el origen principal (el navegador lo bloqueará)", async () => {
  const r = await handle(new Request("https://x.deno.dev/push/key", { headers: { Origin: "https://otra.web" } }), async () => ok("{}"));
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://bendi.dev");
});
