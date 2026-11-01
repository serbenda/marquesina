// Proxy de marquesina (Cloudflare Workers, plan gratuito).
//
//  /crtm/<Get*.php>?...   -> API del Consorcio de Transportes (www.crtm.es/widgets/api):
//                            tiempos de interurbanos y urbanos de Alcobendas, Sanse, etc.
//                            El Consorcio no permite llamadas desde otras webs (CORS).
//  /emt/arrives/<parada>  -> Llegadas de EMT Madrid (con posición GPS de cada bus).
//                            El worker inicia sesión en Mobility Labs con las claves de la
//                            aplicación marquesina, así nadie tiene que registrarse.
//  /v2/...                -> Paso directo a la API de EMT (para quien use su propia cuenta).
//
// Secretos necesarios (Cloudflare > Worker > Settings > Variables and Secrets):
//   EMT_CLIENT_ID  -> X-ClientId de la aplicación en Mobility Labs
//   EMT_PASSKEY    -> passKey de la aplicación en Mobility Labs
//
// Despliegue: Cloudflare > Worker marquesina > Edit code > pegar este archivo > Deploy.

const EMT = "https://openapi.emtmadrid.es";
const CRTM = "https://www.crtm.es/widgets/api";
const ALLOWED_ORIGINS = ["https://bendi.dev", "https://serbenda.github.io"];
const CACHE_SECONDS = 20;

function corsHeaders(req) {
  const origin = req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "email,password,accessToken,Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

// ---------- Sesión de EMT (se reutiliza mientras el worker siga activo) ----------
let emtToken = null, emtTokenExp = 0;

async function emtLogin(env, force = false) {
  if (!force && emtToken && Date.now() < emtTokenExp) return emtToken;
  if (!env.EMT_CLIENT_ID || !env.EMT_PASSKEY) throw new Error("Faltan los secretos EMT_CLIENT_ID y EMT_PASSKEY en el worker");
  const r = await fetch(`${EMT}/v2/mobilitylabs/user/login/`, {
    headers: { "X-ClientId": env.EMT_CLIENT_ID, passKey: env.EMT_PASSKEY },
  });
  const j = await r.json();
  const d = j.data && j.data[0];
  if (!d || !d.accessToken) throw new Error(`EMT rechazó el inicio de sesión (${j.code || r.status}: ${j.description || j.message || JSON.stringify(j).slice(0, 200)})`);
  emtToken = d.accessToken;
  emtTokenExp = Date.now() + ((d.tokenSecExpiration || 3600) - 120) * 1000;
  return emtToken;
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

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);

    // ---- Consorcio ----
    if (url.pathname.startsWith("/crtm/")) {
      const file = url.pathname.slice("/crtm/".length);
      if (!/^Get[A-Za-z]+\.php$/.test(file)) return new Response("Not found", { status: 404, headers: cors });
      const upstream = await fetch(`${CRTM}/${file}${url.search}`, { cf: { cacheTtl: CACHE_SECONDS } });
      const res = new Response(upstream.body, upstream);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }

    // ---- EMT con las claves de marquesina ----
    const m = url.pathname.match(/^\/emt\/arrives\/(\d{1,6})\/?$/);
    if (m) {
      const cache = caches.default;
      const key = new Request(`https://cache.marquesina/emt/${m[1]}`);
      let res = await cache.match(key);
      if (!res) {
        try {
          const data = await emtArrivals(m[1], env);
          res = new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `max-age=${CACHE_SECONDS}` },
          });
          if (data && data.data) ctx.waitUntil(cache.put(key, res.clone()));
        } catch (e) {
          return json({ code: "ERR", description: e.message }, 502, cors);
        }
      }
      res = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }

    // ---- EMT directo (cuenta propia) ----
    if (url.pathname.startsWith("/v2/")) {
      const upstream = await fetch(EMT + url.pathname + url.search, {
        method: req.method, headers: req.headers,
        body: req.method === "POST" ? await req.text() : undefined,
      });
      const res = new Response(upstream.body, upstream);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }

    return new Response("Not found", { status: 404, headers: cors });
  },
};
