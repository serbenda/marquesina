// Proxy mínimo para marquesina (Cloudflare Workers, plan gratuito).
//
//  /v2/...    -> API de EMT Madrid (openapi.emtmadrid.es). Normalmente no hace falta:
//                EMT admite llamadas directas desde el navegador.
//  /crtm/...  -> API del Consorcio de Transportes (www.crtm.es/widgets/api), con los
//                tiempos de llegada de interurbanos y urbanos de Alcobendas, Sanse, etc.
//                Esta sí lo necesita, porque el Consorcio no permite llamadas desde otras webs.
//
// Despliegue: Cloudflare > Workers & Pages > Create > Worker > pega este código > Deploy.
// Luego pon la URL del worker (https://xxx.workers.dev) en Ajustes > URL de tu proxy.

const EMT = "https://openapi.emtmadrid.es";
const CRTM = "https://www.crtm.es/widgets/api";
const ALLOWED_ORIGINS = ["https://bendi.dev", "https://serbenda.github.io"];

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

export default {
  async fetch(req) {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(req.url);
    let upstream;

    if (url.pathname.startsWith("/crtm/")) {
      // Solo se permiten las consultas de paradas y tiempos del Consorcio
      const file = url.pathname.slice("/crtm/".length);
      if (!/^Get[A-Za-z]+\.php$/.test(file)) return new Response("Not found", { status: 404, headers: cors });
      upstream = await fetch(`${CRTM}/${file}${url.search}`, { cf: { cacheTtl: 20 } });
    } else if (url.pathname.startsWith("/v2/")) {
      upstream = await fetch(EMT + url.pathname + url.search, {
        method: req.method,
        headers: req.headers,
        body: req.method === "POST" ? await req.text() : undefined,
      });
    } else {
      return new Response("Not found", { status: 404, headers: cors });
    }

    const res = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};
