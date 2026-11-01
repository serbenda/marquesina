// tests/e2e/web.e2e.mjs — Prueba de verdad en un navegador (Chromium con Playwright)
// =====================================================================================
// A diferencia de los tests de tests/*.test.js, aquí NO se simula nada de la red: se abre la web en un
// navegador real y se usan el worker, el repetidor, EMT y el Consorcio de verdad. Así se detectan fallos
// que los tests simulados no ven (por ejemplo, que Deno Deploy rechaza las rutas que acaban en ".php").
//
// Dos modos (variable de entorno E2E_BASE):
//   - Sin E2E_BASE (en cada Pull Request): sirve los archivos de ESTE repositorio en http://localhost
//     y los prueba contra el worker publicado. Como el worker solo responde a bendi.dev (CORS), las
//     peticiones al worker se hacen desde Playwright (fuera del navegador) y se le devuelven al navegador.
//   - E2E_BASE=https://bendi.dev/marquesina/ (tras publicar y cada pocas horas): prueba la web publicada.
//
// Escenarios:
//   1. Normal: arranca "En vivo", enseña las paradas de ejemplo y la búsqueda de Alcobendas encuentra paradas.
//   2. Bloqueo simulado (como el de LaLiga): se cortan api.bendi.dev y *.workers.dev; la web tiene que
//      seguir funcionando por el repetidor de Deno, también la búsqueda de San Sebastián de los Reyes.
//   3. Enlace compartido: ?paradas=emt:69,crtm:06756 añade esas paradas y se quita de la dirección.
//
// Uso: npm i --no-save playwright && npx playwright install --with-deps chromium && node tests/e2e/web.e2e.mjs
// Si falla, deja capturas en tests/e2e/capturas/.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SHOTS = fileURLToPath(new URL("./capturas/", import.meta.url));
const WORKER_HOSTS = /^https:\/\/(api\.bendi\.dev|marquesina\.serbenda\.workers\.dev|marquesina\.serbenda\.deno\.net)\//;
const CLOUDFLARE_HOSTS = /^https:\/\/(api\.bendi\.dev|[^/]*\.workers\.dev)\//;
const RELAY = "https://marquesina.serbenda.deno.net";

// ---------- Servidor local con los archivos del repositorio (modo Pull Request) ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".css": "text/css" };
function serveRepo() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(ROOT, path.endsWith("/") ? path + "index.html" : path);
    try { res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" }); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end("no"); }
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

// ---------- Utilidades ----------
const results = [];
async function scenario(name, fn) {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`✅ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log(`❌ ${name}: ${e.message}`); }
}
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

async function newPage(browser, { base, local, block = false, label }) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 420, height: 860 }, locale: "es-ES" });
  // Sin bienvenida: se probaría aparte
  await context.addInitScript(() => { try { localStorage.setItem("marquesina-intro", "1"); } catch {} });
  const origin = new URL(base).origin;
  await context.route(WORKER_HOSTS, async route => {
    const url = route.request().url();
    if (block && CLOUDFLARE_HOSTS.test(url)) return route.abort("connectionrefused");   // bloqueo simulado
    if (!local) return route.continue();
    // Modo local: la petición la hace Playwright y se devuelve con CORS para localhost
    const cors = { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "Content-Type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    try {
      const resp = await route.fetch({ headers: { ...route.request().headers(), origin: "https://bendi.dev" }, timeout: 30000 });
      await route.fulfill({ response: resp, headers: { ...resp.headers(), ...cors } });
    } catch { await route.abort("failed"); }
  });
  const page = await context.newPage();
  page.on("pageerror", e => console.log(`   [${label}] error en la página: ${e.message}`));
  return { page, context };
}

async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }).catch(() => {});
}

// Espera a que la web esté "En vivo" y haya al menos una parada pintada
async function waitLive(page) {
  await page.waitForFunction(() => document.getElementById("mode")?.textContent === "En vivo", null, { timeout: 40000 });
  await page.waitForSelector("#list .stophead", { timeout: 40000 });
}

// Zona → municipio → espera el aviso "N paradas en esta zona"
async function searchZone(page, zone) {
  await page.click("#btnZone");
  await page.fill("#fZoneSearch", zone);
  await page.press("#fZoneSearch", "Enter");
  const note = page.locator("#note");
  await page.waitForFunction(() => /\d+ paradas? en esta zona|No hay paradas|No se pudieron/.test(document.getElementById("note")?.textContent || ""), null, { timeout: 45000 });
  const text = await note.textContent();
  const n = Number((text.match(/(\d+) paradas? en esta zona/) || [])[1] || 0);
  check(n >= 10, `${zone}: se esperaban al menos 10 paradas y el aviso dice "${text}"`);
  return n;
}

// ---------- Pruebas ----------
const local = !process.env.E2E_BASE;
const server = local ? await serveRepo() : null;
const base = local ? `http://127.0.0.1:${server.address().port}/` : process.env.E2E_BASE;
console.log(`Probando ${local ? "los archivos de este repositorio (contra el worker publicado)" : base}\n`);

const browser = await chromium.launch();

await scenario("1 · Normal: en vivo y búsqueda en Alcobendas", async () => {
  const { page, context } = await newPage(browser, { base, local, label: "normal" });
  try {
    await page.goto(base);
    await waitLive(page);
    const n = await searchZone(page, "Alcobendas");
    console.log(`   Alcobendas: ${n} paradas`);
  } catch (e) { await shot(page, "1-normal"); throw e; } finally { await context.close(); }
});

await scenario("2 · Bloqueo simulado de Cloudflare: funciona por el repetidor", async () => {
  const { page, context } = await newPage(browser, { base, local, block: true, label: "bloqueo" });
  try {
    await page.goto(base);
    await waitLive(page);
    const proxy = await page.evaluate(() => localStorage.getItem("marquesina-proxy"));
    check(proxy === RELAY, `debería usar el repetidor y usa ${proxy}`);
    const n = await searchZone(page, "San Sebastián de los Reyes");
    console.log(`   Sanse por el repetidor: ${n} paradas`);
  } catch (e) { await shot(page, "2-bloqueo"); throw e; } finally { await context.close(); }
});

await scenario("3 · Enlace compartido: añade las paradas y limpia la dirección", async () => {
  const { page, context } = await newPage(browser, { base, local, label: "enlace" });
  try {
    await page.goto(base + "?paradas=emt:69,crtm:06756,xss:<b>");
    await page.waitForFunction(() => /Añadidas 2 paradas/.test(document.getElementById("note")?.textContent || ""), null, { timeout: 15000 });
    check(!page.url().includes("paradas="), `la dirección sigue con el parámetro: ${page.url()}`);
    const cfg = await page.evaluate(() => JSON.parse(localStorage.getItem("marquesina")));
    check(cfg.stops === "69" && cfg.crtm === "06756", `paradas guardadas inesperadas: ${JSON.stringify({ stops: cfg.stops, crtm: cfg.crtm })}`);
    await waitLive(page);
    const heads = await page.locator("#list .stophead").count();
    check(heads === 2, `se esperaban 2 paradas en la lista y hay ${heads}`);
  } catch (e) { await shot(page, "3-enlace"); throw e; } finally { await context.close(); }
});

await browser.close();
server && server.close();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} escenarios correctos`);
process.exit(failed.length ? 1 : 0);
