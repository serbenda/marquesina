/**
 * logic.js — La "calculadora" de marquesina
 * =========================================
 *
 * QUÉ ES
 *   Funciones puras: reciben datos y devuelven datos. Aquí NO hay pantalla (DOM), ni red (fetch),
 *   ni mapa, ni hora del sistema salvo que se pase como parámetro. Por eso se pueden probar solas.
 *
 * QUIÉN LO USA
 *   - index.html  (la web):    para leer las respuestas de las APIs y pintar los minutos.
 *   - worker.js   (Cloudflare): para decidir cuándo enviar el aviso "¡Sal ya!".
 *   - tests/logic.test.js:     comprueba cada función con respuestas reales (tests/fixtures/).
 *   Como la web y el worker usan el mismo archivo, los dos calculan exactamente igual.
 *
 * SECCIONES
 *   1. Utilidades ............ asArray, esc
 *   2. Códigos y nombres ..... crtmCode, NETWORKS, stopNetwork, lineName
 *   3. Paradas cercanas ...... parseNearest, parseEmtNear, mergeStops
 *   4. Formato ............... fmtEta, status, fmtDist, fmtAge
 *   5. Leer EMT .............. parseEmt
 *   6. Leer el Consorcio ..... parseCrtmTimes, parseCrtmVehicles
 *   7. Cuándo salir .......... groupByLine, leaveInfo, bestLeave
 *   8. Avisos programados .... alertActive, leaveMessage
 *
 * VOCABULARIO
 *   eta    Segundos que faltan para que el bus llegue a la parada.
 *   walk   Minutos que tardas andando desde casa hasta la parada.
 *   leave  Segundos que faltan para que tengas que salir de casa (eta − walk).
 *   elapsed Segundos pasados desde que se consultó la parada (para descontarlos sin volver a preguntar).
 *   Consorcio / CRTM  Consorcio Regional de Transportes de Madrid (interurbanos, urbanos, Metro, Cercanías).
 *
 * Más detalle con diagramas: docs/REFERENCIA.md §5.
 */

// =====================================================================================================
// 1. Utilidades
// =====================================================================================================

/**
 * Devuelve siempre una lista. Las APIs del Consorcio mandan un objeto cuando hay un solo elemento
 * y una lista cuando hay varios; así el resto del código no tiene que distinguirlo.
 * @example asArray(null) // []    asArray({a:1}) // [{a:1}]    asArray([1,2]) // [1,2]
 */
export const asArray = v => v == null ? [] : Array.isArray(v) ? v : [v];

/**
 * Escapa texto para meterlo en HTML sin riesgo (evita que un nombre de parada con "<" rompa la página
 * o inyecte código). TODO texto que venga de fuera y se pinte con innerHTML debe pasar por aquí.
 * @example esc('<b>"Hola"</b>') // '&lt;b&gt;&quot;Hola&quot;&lt;/b&gt;'
 */
export const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// =====================================================================================================
// 2. Códigos y nombres
// =====================================================================================================

/**
 * Código completo de una parada del Consorcio. Lo que no tiene prefijo se trata como interurbano (8_).
 * @param {string|number} c  Código como lo escribe la persona.
 * @returns {string}
 * @example crtmCode("6756") // "8_06756"    crtmCode("4_278") // "4_278" (Metro, se queda igual)
 */
export const crtmCode = c => String(c).includes("_") ? String(c) : `8_${String(c).padStart(5, "0")}`;

/** Prefijo del código del Consorcio → nombre de la red. */
export const NETWORKS = { "4": "Metro", "5": "Cercanías", "6": "EMT", "8": "Interurbano", "9": "Urbano", "10": "Metro Ligero" };
/**
 * Red a la que pertenece una parada, según su prefijo.
 * @example stopNetwork("4_278") // "Metro"    stopNetwork("8_06756") // "Interurbano"
 */
export function stopNetwork(code) {
  const m = String(code).match(/^(\d+)_/);
  return m ? (NETWORKS[m[1]] || "Consorcio") : "Consorcio";
}

/**
 * Nombre corto de una línea a partir de su código interno del Consorcio.
 * En los urbanos (9_) el tercer trozo es el municipio, así que solo vale el segundo.
 * @example lineName("8__157_C__") // "157C"    lineName("8_N_101___") // "N101"    lineName("9__10__006_") // "10"
 */
export function lineName(codLine) {
  const parts = String(codLine).split("_").filter(Boolean);
  if (parts.length < 2) return String(codLine);
  if (parts[0] === "9") return parts[1];
  return parts.slice(1).join("");
}

// =====================================================================================================
// 3. Paradas cercanas
// =====================================================================================================
// Todas devuelven la misma forma de parada:
//   { net: "emt"|"crtm", code: "69"|"06756"|"4_278", kind: "EMT"|"Interurbano"|"Metro"…,
//     name: "Marqués de Valdavia", pos: [lat, lon], lines: ["153", "154"] }

/**
 * Lee la respuesta de GetNearestStopsByLocation del Consorcio. Se queda con EMT (6_), interurbanos (8_),
 * Metro (4_) y Cercanías (5_), sin repetir ninguna parada.
 * @param {object} j  JSON del Consorcio.
 * @returns {Array<object>}  Paradas con la forma de arriba.
 */
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

/**
 * Lee la respuesta de EMT "arroundxy" (paradas alrededor de un punto).
 * Hace falta porque el Consorcio NO tiene todas las paradas de EMT (por ejemplo, las de El Pardo).
 * Ojo: EMT da las coordenadas como [lon, lat]; aquí se devuelven como [lat, lon], igual que el resto.
 * @param {object} j  JSON de EMT.
 * @returns {Array<object>}
 */
export function parseEmtNear(j) {
  return asArray(j && j.data)
    .filter(s => s && s.stopId != null && s.geometry && s.geometry.coordinates)
    .map(s => ({
      net: "emt",
      code: String(s.stopId),
      kind: "EMT",
      name: s.stopName || `Parada ${s.stopId}`,
      pos: [s.geometry.coordinates[1], s.geometry.coordinates[0]],
      lines: [...new Set(asArray(s.lines).map(l => String(l.label || l.line)))],
    }));
}

/**
 * Une listas de paradas de varias fuentes sin repetir (misma red y mismo código).
 * Se queda con la primera que aparezca; si esa no traía líneas y otra sí, copia las líneas.
 * @example mergeStops(paradasDeEmt, paradasDelConsorcio)
 */
export function mergeStops(...lists) {
  const out = new Map();
  for (const s of lists.flat()) {
    const k = `${s.net}:${s.code}`;
    const prev = out.get(k);
    if (!prev) out.set(k, s);
    else if (!prev.lines.length && s.lines.length) out.set(k, { ...prev, lines: s.lines });
  }
  return [...out.values()];
}

// =====================================================================================================
// 4. Formato (lo que se ve en pantalla)
// =====================================================================================================

/**
 * Minutos para mostrar a partir de segundos.
 * EMT manda 999999 cuando el bus está a más de 20 min: se muestra "+20" (nunca "16666").
 * @param {number} s  Segundos.
 * @returns {{txt: string, unit: string}}
 * @example fmtEta(30).txt // "<1"    fmtEta(400).txt // "6"    fmtEta(999999).txt // "+20"
 */
export function fmtEta(s) {
  if (s >= 999000) return { txt: "+20", unit: "min" };
  if (s < 60) return { txt: "<1", unit: "min" };
  return { txt: String(Math.floor(s / 60)), unit: "min" };
}
/**
 * Estado de un bus para el color de la etiqueta: [clase CSS, texto].
 * @example status(60) // ["now","Llegando"]    status(200) // ["near","Cerca"]    status(600) // ["far","En camino"]
 */
export function status(s) {
  return s < 90 ? ["now", "Llegando"] : s < 300 ? ["near", "Cerca"] : ["far", "En camino"];
}
/**
 * Distancia legible. @example fmtDist(350) // "350 m"    fmtDist(1500) // "1,5 km"    fmtDist(null) // ""
 */
export function fmtDist(m) {
  return m == null ? "" : m >= 1000 ? (m / 1000).toFixed(1).replace(".", ",") + " km" : m + " m";
}
/**
 * Antigüedad de unos datos, para el aviso "Sin datos nuevos · son de hace N min".
 * @param {number} ms  Milisegundos.
 * @example fmtAge(30000) // "hace menos de 1 min"    fmtAge(180000) // "hace 3 min"
 */
export function fmtAge(ms) {
  const min = Math.floor(ms / 60000);
  return min < 1 ? "hace menos de 1 min" : min === 1 ? "hace 1 min" : `hace ${min} min`;
}

// =====================================================================================================
// 5. Leer EMT
// =====================================================================================================
// Todas las lecturas devuelven los buses con la misma forma:
//   { key, line: "27", dest: "Plaza Castilla", eta: 240 (segundos), dist: 800 (metros o null),
//     pos: [lat, lon] o null, mode?: "8", live?: true }

/**
 * Lee la respuesta de /emt/arrives/<parada> (la del worker, que es la de EMT tal cual).
 * @param {object} j     JSON de EMT.
 * @param {string} stop  Número de parada (para los mensajes de error).
 * @returns {{id, name, pos, buses}}
 * @throws Si el worker devolvió un error (code "ERR") o la parada no trae datos.
 */
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

// =====================================================================================================
// 6. Leer el Consorcio
// =====================================================================================================

// "Alcobendas - Plaza Castilla" -> "Plaza Castilla" (el Consorcio pone el origen delante)
const cleanDest = d => (d || "").replace(/^.*?-\s*/, "") || d || "";

/**
 * Lee la respuesta de GetStopsTimes (llegadas a una parada del Consorcio).
 * - Calcula el eta con la hora que da el propio Consorcio (actualDate), no con la del dispositivo.
 * - Se queda con los buses de los próximos `maxMinutes` y como mucho `perLineMax` por línea.
 * - `live` indica si el tiempo viene del GPS (true) o del horario teórico (false).
 * @param {object} j     JSON del Consorcio (o lo que devuelve /crtm/stop del worker).
 * @param {string} code  Código completo, p. ej. "8_06756".
 * @returns {{times: Array, buses: Array}}
 * @throws Si la respuesta no trae stopTimes.
 */
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

/**
 * Lee GetLineLocation (posición GPS de los buses de una línea). Descarta los que no traen coordenadas.
 * @param {object} j         JSON del Consorcio.
 * @param {object} fallback  {codLine, line, dest} para completar lo que no venga en la respuesta.
 * @returns {Array<{key, line, dest, pos}>}
 */
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

// =====================================================================================================
// 7. Cuándo salir
// =====================================================================================================

/**
 * Junta las llegadas de una parada por línea y destino: una fila por línea con sus próximos pasos,
 * ordenados del más cercano al más lejano.
 * @param {Array} buses    Buses de una parada.
 * @param {number} elapsed Segundos pasados desde la consulta (se restan a cada eta, sin bajar de 0).
 * @returns {Array<{line, mode, dest, items}>}
 */
export function groupByLine(buses, elapsed = 0) {
  const groups = new Map();
  for (const b of buses.slice().sort((x, y) => x.eta - y.eta)) {
    // EMT manda 999999 cuando el bus está a más de 20 min: se deja tal cual (se muestra "+20")
    const eta = b.eta >= 999000 ? 999999 : Math.max(0, b.eta - elapsed);
    const k = `${b.line}|${b.dest}`;
    if (!groups.has(k)) groups.set(k, { line: b.line, mode: b.mode, dest: b.dest, items: [] });
    groups.get(k).items.push({ ...b, eta });
  }
  return [...groups.values()];
}

/**
 * Cuándo salir para coger un bus de una fila: el primero al que te da tiempo llegar andando
 * (con 30 s de margen).
 * @param {Array} items    Pasos de una línea, ordenados (salen de groupByLine).
 * @param {number} walkMin Minutos andando. Si es 0 o falta, no se calcula nada.
 * @returns {null | {late: true} | {bus, leave, missedFirst}}
 *   null:   no hay minutos andando.
 *   late:   no llegas a ninguno de los que se conocen.
 *   leave:  segundos hasta salir; missedFirst = true si pierdes el primero.
 * @example
 *   // Tardas 6 min (360 s). Pasan en 240 s y 840 s → el primero no da tiempo; sales en 840−360 = 480 s.
 *   leaveInfo([{eta:240},{eta:840}], 6) // { bus:{eta:840}, leave:480, missedFirst:true }
 */
export function leaveInfo(items, walkMin) {
  if (!walkMin) return null;
  const walk = walkMin * 60;
  const target = items.find(b => b.eta >= walk - 30);
  if (!target) return { late: true };
  return { bus: target, leave: target.eta - walk, missedFirst: target !== items[0] };
}

/**
 * La salida más urgente entre varias paradas. Es lo que se ve arriba en la web y lo que manda el aviso.
 * Las paradas favoritas van siempre antes que las demás; dentro de cada grupo, la que antes haya que salir.
 * @param {Array<{stop, meta, elapsed?}>} stops  meta = {alias, walk, fav}. Cada una puede traer su elapsed.
 * @param {number} elapsed      Segundos desde la consulta, para las que no traen el suyo.
 * @param {string|null} onlyLine Si se indica, solo cuenta esa línea (avisos de una línea concreta).
 * @returns {null | {score, stop, group, li, meta}}
 */
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

// =====================================================================================================
// 8. Avisos programados
// =====================================================================================================

/**
 * ¿Está activo un aviso en este momento? Se calcula SIEMPRE en hora de Madrid, aunque quien lo llame
 * (el worker) funcione en UTC; así el cambio de hora no afecta.
 * @param {{days: number[], from: string, to: string}} alert  days: 1..7 (lunes = 1); from/to: "HH:MM".
 * @param {Date} date  Momento a comprobar (por defecto, ahora).
 * @example alertActive({days:[1,2,3,4,5], from:"08:00", to:"08:45"}, new Date("2026-11-02T07:30:00Z")) // true (lunes 8:30 en Madrid)
 */
export function alertActive(alert, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(p => [p.type, p.value]));
  const day = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  const toMin = s => { const [h, m] = String(s || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
  return asArray(alert.days).map(Number).includes(day) && now >= toMin(alert.from) && now <= toMin(alert.to);
}

/**
 * Título y texto de la notificación a partir del resultado de bestLeave.
 * @returns {{title, body, tag}}  tag hace que un aviso nuevo de la misma parada y línea sustituya al anterior.
 * @example { title: "¡Sal ya! 153 · Cole", body: "Plaza Castilla · pasa en 7 min. Tardas 6 min andando.", tag: "06756-153" }
 */
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
