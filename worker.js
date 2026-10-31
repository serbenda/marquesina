// Proxy mínimo para la API de EMT Madrid (Cloudflare Workers, plan gratuito).
// Reenvía las peticiones a openapi.emtmadrid.es y añade cabeceras CORS para
// que la web en GitHub Pages pueda llamar a la API desde el navegador.
//
// Despliegue: Cloudflare > Workers > Create > pega este código > Deploy.
// Luego pon la URL del worker (https://xxx.workers.dev) en Ajustes > URL de la API.

const UPSTREAM = "https://openapi.emtmadrid.es";
const ALLOWED_ORIGIN = "https://serbenda.github.io"; // cámbialo si usas otro dominio

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "email,password,accessToken,Content-Type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(req.url);
    if (!url.pathname.startsWith("/v2/")) return new Response("Not found", { status: 404, headers: cors });

    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers: req.headers,
      body: req.method === "POST" ? await req.text() : undefined,
    });

    const res = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};
