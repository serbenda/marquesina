// Lógica pura de marquesina: lectura de las APIs, agrupación de llegadas y aviso de cuándo salir.
// La usan la web (index.html, como módulo) y el worker (notificaciones), y la prueban los tests (tests/).
// Aquí no hay DOM, red ni mapa: solo funciones que reciben datos y devuelven datos.

export const asArray = v => v == null ? [] : Array.isArray(v) ? v : [v];

export const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Código de parada del Consorcio: "6756" o "06756" -> "8_06756". Metro y Cercanías ya traen prefijo ("4_278", "5_18").
export const crtmCode = c => String(c).includes("_") ? String(c) : `8_${String(c).padStart(5, "0")}`;

// Red de una parada según el prefijo del código del Consorcio
export const NETWORKS = { "4": "Metro", "5": "Cercanías", "6": "EMT", "8": "Interurbano", "9": "Urbano", "10": "Metro Ligero" };
export function stopNetwork(code) {
  const m = String(code).match(/^(\d+)_/);
  return m ? (NETWORKS[m[1]] || "Consorcio") : "Consorcio";
}

// Nombre corto de una línea a partir de su código del Consorcio:
// "8__154___" -> "154", "8__157_C__" -> "157C", "8_N_101___" -> "N101", "9__10__006_" -> "10", "4__10___" -> "10"
export function lineName(codLine) {
  const parts = String(codLine).split("_").filter(Boolean);
  if (parts.length < 2) return String(codLine);
  if (parts[0] === "9") return parts[1];
  return parts.slice(1).join("");
}

// Paradas cercanas (GetNearestStopsByLocation): EMT (6_), Consorcio (8_), Metro (4_) y Cercanías (5_), sin repetir
export function parseNearest(j) {
  const seen = new Set();
  return asArray(j && j.stops && j.stops.Stop)
    .filter(s => /^[4568]_/.test(s.codStop) && s.coordinates && !seen.has(s.codStop) && seen.add(s.codStop))
    .map(s => ({
      net: s.codStop.startsWith("6_") ? "emt" : "crtm",
      code: s.codStop.startsWith("6_") ? s.codStop.slice(2) : s.codStop.startsWith("8_") ? s.shortCodStop : s.codStop,
      kind: stopNetwork(s.codStop),
      name: s.name,
      pos: [s.coordinates.latitude, s.coordinates.longitude],
      lines: [...new Set(asArray(s.lines && s.lines.Line).map(l => l.shortDescription || lineName(l.codLine)))],
    }));
}

// ---------- Formato ----------
export function fmtEta(s) {
  if (s >= 999999) return { txt: "+20", unit: "min" };
  if (s < 60) return { txt: "<1", unit: "min" };
  return { txt: String(Math.floor(s / 60)), unit: "min" };
}
export function status(s) {
  return s < 90 ? ["now", "Llegando"] : s < 300 ? ["near", "Cerca"] : ["far", "En camino"];
}
export function fmtDist(m) {
  return m == null ? "" : m >= 1000 ? (m / 1000).toFixed(1).replace(".", ",") + " km" : m + " m";
}
// Antigüedad de unos datos, para el aviso de datos viejos
export function fmtAge(ms) {
  const min = Math.floor(ms / 60000);
  return min < 1 ? "hace menos de 1 min" : min === 1 ? "hace 1 min" : `hace ${min} min`;
}

// ---------- Lectura de EMT (respuesta de /emt/arrives/<parada>) ----------
export function parseEmt(j, stop) {
  if (!j || j.code === "ERR") throw new Error(`EMT no está disponible ahora mismo (parada ${stop}).`);
  const d = j.data && j.data[0];
  if (!d) throw new Error(`La parada ${stop} no devolvió datos (${j.description || "sin respuesta"}).`);
  const si = asArray(d.StopInfo)[0] || {};
  const sc = si.geometry && si.geometry.coordinates;
  return {
    id: String(stop),
    name: si.stopName || si.Description || `Parada ${stop}`,
    pos: sc ? [sc[1], sc[0]] : null,
    buses: asArray(d.Arrive).map(a => ({
      key: `${a.line}-${a.bus}`, line: String(a.line), dest: a.destination,
      eta: a.estimateArrive, dist: a.DistanceBus,
      pos: a.geometry && a.geometry.coordinates ? [a.geometry.coordinates[1], a.geometry.coordinates[0]] : null,
    })),
  };
}

// ---------- Lectura del Consorcio (respuesta de GetStopsTimes) ----------
const cleanDest = d => (d || "").replace(/^.*?-\s*/, "") || d || "";

export function parseCrtmTimes(j, code, maxMinutes = 90, perLineMax = 2) {
  const st = j && j.stopTimes;
  if (!st) throw new Error(`La parada ${code.replace(/^8_/, "")} no devolvió datos.`);
  const now = new Date(st.actualDate).getTime();
  const perLine = {};
  const buses = asArray(st.times && st.times.Time).map((t, i) => ({
    key: `c-${code}-${t.line.shortDescription}-${i}`,
    line: String(t.line.shortDescription || lineName(t.line.codLine)),
    mode: String(t.line.codMode || ""),
    dest: cleanDest(t.destination),
    eta: Math.max(0, Math.round((new Date(t.time).getTime() - now) / 1000)),
    dist: null, pos: null,
    // Los tiempos de horario llevan un código con el nombre de la línea; los del GPS, el del vehículo
    live: !(t.codIssue || "").startsWith(t.line.codLine),
  })).sort((a, b) => a.eta - b.eta)
    .filter(b => b.eta <= maxMinutes * 60 && (perLine[b.line] = (perLine[b.line] || 0) + 1) <= perLineMax);
  return { times: asArray(st.times && st.times.Time), buses };
}

// Vehículos de GetLineLocation
export function parseCrtmVehicles(j, fallback) {
  return asArray(j && j.vehiclesLocation && j.vehiclesLocation.VehicleLocation)
    .filter(v => v.coordinates && v.coordinates.latitude)
    .map(v => ({
      key: `v-${v.codVehicle || fallback.codLine + "-" + v.service}`,
      line: String((v.line && v.line.shortDescription) || fallback.line),
      dest: fallback.dest,
      pos: [v.coordinates.latitude, v.coordinates.longitude],
    }));
}

// ---------- Agrupación y aviso de salida ----------
// Junta las llegadas de una parada por línea y destino: una fila por línea con sus próximos pasos
export function groupByLine(buses, elapsed = 0) {
  const groups = new Map();
  for (const b of buses.slice().sort((x, y) => x.eta - y.eta)) {
    const eta = Math.max(0, b.eta - elapsed);
    const k = `${b.line}|${b.dest}`;
    if (!groups.has(k)) groups.set(k, { line: b.line, mode: b.mode, dest: b.dest, items: [] });
    groups.get(k).items.push({ ...b, eta });
  }
  return [...groups.values()];
}

// Cuándo salir: el primer bus al que da tiempo llegar andando (30 s de margen)
export function leaveInfo(items, walkMin) {
  if (!walkMin) return null;
  const walk = walkMin * 60;
  const target = items.find(b => b.eta >= walk - 30);
  if (!target) return { late: true };
  return { bus: target, leave: target.eta - walk, missedFirst: target !== items[0] };
}

// La salida más urgente entre varias paradas: [{stop, meta}] -> {stop, group, li, meta} | null
// Cada entrada puede traer su propio "elapsed" (segundos desde que se consultó esa parada).
export function bestLeave(stops, elapsed = 0, onlyLine = null) {
  let best = null;
  for (const { stop, meta, elapsed: own } of stops) {
    if (!stop || stop.error || !meta || !meta.walk) continue;
    for (const g of groupByLine(stop.buses, own ?? elapsed)) {
      if (onlyLine && g.line !== onlyLine) continue;
      const li = leaveInfo(g.items, meta.walk);
      if (!li || li.late) continue;
      const score = (meta.fav ? 0 : 1e6) + li.leave;
      if (!best || score < best.score) best = { score, stop, group: g, li, meta };
    }
  }
  return best;
}

// ---------- Avisos programados ----------
// ¿Está activo un aviso ahora? days: [1..7] (lunes=1), from/to: "HH:MM", hora local de Madrid
export function alertActive(alert, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(p => [p.type, p.value]));
  const day = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  const toMin = s => { const [h, m] = String(s || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
  return asArray(alert.days).map(Number).includes(day) && now >= toMin(alert.from) && now <= toMin(alert.to);
}

// Texto de la notificación para una salida
export function leaveMessage(best) {
  const { stop, group, li, meta } = best;
  const where = meta.alias || stop.name;
  const mins = Math.floor(li.leave / 60);
  return {
    title: li.leave <= 60 ? `¡Sal ya! ${group.line} · ${where}` : `Sal en ${mins} min · ${group.line} · ${where}`,
    body: `${group.dest} · pasa en ${fmtEta(li.bus.eta).txt} min. Tardas ${meta.walk} min andando.`,
    tag: `${stop.id}-${group.line}`,
  };
}
