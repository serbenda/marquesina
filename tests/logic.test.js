// Tests de la lógica de marquesina (logic.js) con respuestas reales de las APIs guardadas en tests/fixtures.
// Se ejecutan con: npm test  (o node --test tests/*.test.js)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  asArray, esc, crtmCode, fmtEta, status, fmtDist, fmtAge,
  parseEmt, parseCrtmTimes, parseCrtmVehicles,
  groupByLine, leaveInfo, bestLeave, alertActive, leaveMessage,
} from "../logic.js";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// ---------- utilidades ----------
test("asArray normaliza los objetos sueltos que devuelve el Consorcio", () => {
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(asArray([1, 2]), [1, 2]);
});

test("esc evita inyectar HTML", () => {
  assert.equal(esc('<b a="x">&'), "&lt;b a=&quot;x&quot;&gt;&amp;");
});

test("crtmCode completa el código de parada del Consorcio", () => {
  assert.equal(crtmCode("6756"), "8_06756");
  assert.equal(crtmCode("06756"), "8_06756");
  assert.equal(crtmCode("8_06756"), "8_06756");
});

test("formatos de tiempo, distancia y antigüedad", () => {
  assert.equal(fmtEta(30).txt, "<1");
  assert.equal(fmtEta(125).txt, "2");
  assert.equal(fmtEta(999999).txt, "+20");
  assert.deepEqual(status(60), ["now", "Llegando"]);
  assert.deepEqual(status(200), ["near", "Cerca"]);
  assert.deepEqual(status(600), ["far", "En camino"]);
  assert.equal(fmtDist(536), "536 m");
  assert.equal(fmtDist(1250), "1,3 km");
  assert.equal(fmtAge(30_000), "hace menos de 1 min");
  assert.equal(fmtAge(185_000), "hace 3 min");
});

// ---------- lectura de APIs ----------
test("parseEmt lee la respuesta real de EMT (parada 69, Cibeles)", () => {
  const s = parseEmt(fixture("emt-arrives-69.json"), 69);
  assert.equal(s.id, "69");
  assert.equal(s.name, "Cibeles");
  assert.ok(Math.abs(s.pos[0] - 40.4197) < 0.001 && Math.abs(s.pos[1] + 3.6935) < 0.001, "posición en [lat, lon]");
  assert.equal(s.buses.length, 4);
  const b = s.buses.find(x => x.line === "9");
  assert.equal(b.eta, 132);
  assert.equal(b.dist, 536);
  assert.equal(b.dest, "SOL SEVILLA");
  assert.ok(b.pos[0] > 40 && b.pos[1] < 0, "posición del bus en [lat, lon]");
});

test("parseEmt da un error claro si el worker no puede consultar EMT", () => {
  assert.throws(() => parseEmt({ code: "ERR", description: "x" }, 69), /EMT no está disponible/);
  assert.throws(() => parseEmt({ code: "90", data: [] }, 69), /no devolvió datos/);
});

test("parseCrtmTimes lee la respuesta real del Consorcio (parada 06756, Alcobendas)", () => {
  const { buses, times } = parseCrtmTimes(fixture("crtm-stoptimes-06756.json"), "8_06756");
  assert.equal(times.length, 6);
  assert.deepEqual(buses.map(b => b.line), ["151", "158", "827", "153", "10", "828"]);
  const b151 = buses[0];
  assert.equal(b151.eta, 358);                          // 10:29:31 - 10:23:33
  assert.equal(b151.dest, "ALCOBENDAS (Av. de España)"); // sin el origen "MADRID (Plaza de Castilla)-"
  assert.equal(b151.live, false);                       // código de horario
  assert.equal(buses.find(b => b.line === "827").live, true); // código de vehículo (GPS)
});

test("parseCrtmTimes limita a 2 pasos por línea y 90 minutos", () => {
  const j = fixture("crtm-stoptimes-06756.json");
  const t = j.stopTimes.times.Time[0];
  j.stopTimes.times.Time.push({ ...t, time: "2026-11-01T10:40:00+01:00" }, { ...t, time: "2026-11-01T10:50:00+01:00" },
    { ...t, line: { ...t.line, shortDescription: "999" }, time: "2026-11-01T13:00:00+01:00" });
  const { buses } = parseCrtmTimes(j, "8_06756");
  assert.equal(buses.filter(b => b.line === "151").length, 2);
  assert.equal(buses.some(b => b.line === "999"), false);
});

test("parseCrtmTimes da un error claro si la parada no existe", () => {
  assert.throws(() => parseCrtmTimes({}, "8_99999"), /no devolvió datos/);
});

test("parseCrtmVehicles lee la posición GPS real de un 153", () => {
  const v = parseCrtmVehicles(fixture("crtm-linelocation-153.json"), { codLine: "8__153___", line: "153", dest: "SAN S. REYES" });
  assert.equal(v.length, 1);
  assert.equal(v[0].key, "v-1628MVP");
  assert.equal(v[0].line, "153");
  assert.deepEqual(v[0].pos, [40.54088592529297, -3.630625009536743]);
  assert.deepEqual(parseCrtmVehicles({}, {}), []);
});

// ---------- agrupación y cuándo salir ----------
const buses = [
  { key: "a", line: "153", dest: "Sanse", eta: 120 },
  { key: "b", line: "153", dest: "Sanse", eta: 840 },
  { key: "c", line: "827", dest: "Tres Cantos", eta: 400 },
  { key: "d", line: "153", dest: "Sanse", eta: 1500 },
];

test("groupByLine junta por línea y destino y descuenta el tiempo transcurrido", () => {
  const g = groupByLine(buses, 60);
  assert.deepEqual(g.map(x => x.line), ["153", "827"]);
  assert.deepEqual(g[0].items.map(i => i.eta), [60, 780, 1440]);
});

test("leaveInfo calcula cuándo salir y a qué bus da tiempo", () => {
  const [g153, g827] = groupByLine(buses);
  assert.equal(leaveInfo(g153.items, 0), null);                        // sin minutos andando
  assert.deepEqual(pick(leaveInfo(g153.items, 1)), { leave: 60, missedFirst: false });
  assert.deepEqual(pick(leaveInfo(g153.items, 5)), { leave: 540, missedFirst: true }); // el de 2 min no da tiempo
  assert.deepEqual(leaveInfo(g153.items, 30), { late: true });
  assert.equal(leaveInfo(g827.items, 5).leave, 100);
});
const pick = li => ({ leave: li.leave, missedFirst: li.missedFirst });

test("bestLeave prioriza las favoritas y usa el tiempo de cada parada", () => {
  const casa = { id: "1", name: "Casa", buses: [{ key: "x", line: "5", dest: "A", eta: 400 }] };
  const cole = { id: "2", name: "Cole", buses: [{ key: "y", line: "153", dest: "B", eta: 900 }] };
  const best = bestLeave([
    { stop: casa, meta: { walk: 2 } },
    { stop: cole, meta: { walk: 5, fav: true } },
  ]);
  assert.equal(best.stop.name, "Cole");                  // favorita aunque salga más tarde
  assert.equal(best.li.leave, 600);
  const own = bestLeave([{ stop: casa, meta: { walk: 2 }, elapsed: 100 }]);
  assert.equal(own.li.leave, 180);                        // 400 - 100 - 120
  assert.equal(bestLeave([{ stop: casa, meta: { walk: 2 } }], 0, "153"), null); // filtro por línea
});

// ---------- avisos programados ----------
test("alertActive respeta días y franja en hora de Madrid", () => {
  const alert = { days: [1, 2, 3, 4, 5], from: "08:00", to: "08:45" };
  assert.equal(alertActive(alert, new Date("2026-11-02T07:30:00Z")), true);  // lunes 08:30 en Madrid (UTC+1)
  assert.equal(alertActive(alert, new Date("2026-11-02T06:30:00Z")), false); // lunes 07:30
  assert.equal(alertActive(alert, new Date("2026-11-01T07:30:00Z")), false); // domingo
  assert.equal(alertActive(alert, new Date("2026-06-01T06:30:00Z")), true);  // lunes 08:30 en verano (UTC+2)
});

test("leaveMessage redacta la notificación", () => {
  const stop = { id: "06756", name: "MARQUÉS VALDAVIA" };
  const group = { line: "153", dest: "Sanse" };
  const m1 = leaveMessage({ stop, group, li: { leave: 240, bus: { eta: 540 } }, meta: { alias: "Cole", walk: 5 } });
  assert.equal(m1.title, "Sal en 4 min · 153 · Cole");
  assert.equal(m1.body, "Sanse · pasa en 9 min. Tardas 5 min andando.");
  const m2 = leaveMessage({ stop, group, li: { leave: 30, bus: { eta: 330 } }, meta: { walk: 5 } });
  assert.equal(m2.title, "¡Sal ya! 153 · MARQUÉS VALDAVIA");
});

// ---------- Metro, Cercanías y nombres de línea ----------
import { lineName, stopNetwork, parseNearest } from "../logic.js";

test("lineName saca el nombre corto de cualquier línea del Consorcio", () => {
  assert.equal(lineName("8__154___"), "154");
  assert.equal(lineName("8__157_C__"), "157C");
  assert.equal(lineName("8_N_101___"), "N101");
  assert.equal(lineName("9__10__006_"), "10");
  assert.equal(lineName("4__10___"), "10");
});

test("stopNetwork identifica la red por el prefijo", () => {
  assert.equal(stopNetwork("4_278"), "Metro");
  assert.equal(stopNetwork("5_18"), "Cercanías");
  assert.equal(stopNetwork("8_06756"), "Interurbano");
});

test("parseNearest reparte EMT, Consorcio, Metro y Cercanías sin repetir", () => {
  const stop = (codStop, shortCodStop, lines) => ({ codStop, shortCodStop, name: codStop, coordinates: { latitude: 40.5, longitude: -3.6 }, lines: { Line: lines } });
  const r = parseNearest({ stops: { Stop: [
    stop("6_69", "69", [{ shortDescription: "27" }]),
    stop("8_06756", "06756", [{ codLine: "8__153___" }]),
    stop("8_06756", "06756", []),
    stop("4_278", "278", { codLine: "4__10___" }),
    stop("10_1", "1", []),
  ] } });
  assert.deepEqual(r.map(s => [s.net, s.code, s.kind]), [["emt", "69", "EMT"], ["crtm", "06756", "Interurbano"], ["crtm", "4_278", "Metro"]]);
  assert.deepEqual(r[1].lines, ["153"]);
  assert.deepEqual(r[2].lines, ["10"]);
});

// ---------- Paradas de EMT cercanas (El Pardo no está en el Consorcio) ----------
import { parseEmtNear, mergeStops } from "../logic.js";

test("parseEmtNear lee las paradas cercanas de EMT y mergeStops evita duplicados", () => {
  const emt = parseEmtNear({ code: "00", data: [
    { stopId: 4876, stopName: "El Pardo-Av. de la Guardia", geometry: { type: "Point", coordinates: [-3.7745, 40.5180] },
      lines: [{ line: "601", label: "601", to: "A" }, { line: "601", label: "601", to: "B" }] },
    { stopName: "sin id" },
  ] });
  assert.deepEqual(emt, [{ net: "emt", code: "4876", kind: "EMT", name: "El Pardo-Av. de la Guardia", pos: [40.5180, -3.7745], lines: ["601"] }]);
  const crtm = [{ net: "emt", code: "4876", kind: "EMT", name: "X", pos: [0, 0], lines: [] }, { net: "crtm", code: "06756", kind: "Interurbano", name: "Y", pos: [0, 0], lines: ["153"] }];
  const all = mergeStops(emt, crtm);
  assert.deepEqual(all.map(s => `${s.net}:${s.code}`), ["emt:4876", "crtm:06756"]);
  assert.equal(all[0].name, "El Pardo-Av. de la Guardia");
  assert.deepEqual(parseEmtNear({ code: "80" }), []);
});
