# Instrucciones para asistentes de IA

Este archivo resume lo que un asistente de IA (o una persona nueva) necesita saber **antes de tocar nada**. El detalle está en [docs/](docs/README.md).

## Qué es

Web estática (GitHub Pages) que muestra en tiempo real los autobuses de la Comunidad de Madrid (EMT y Consorcio) y avisa de cuándo salir de casa. Un Cloudflare Worker hace de intermediario con las APIs y envía las notificaciones.

## Mapa del repositorio

| Ruta | Qué es |
|---|---|
| `index.html` | Toda la web: estilos, pantalla y comportamiento (módulo ES, sin compilación) |
| `logic.js` | Funciones puras compartidas por la web y el worker. **Aquí van los cálculos.** |
| `push.js` | Web Push sin librerías (VAPID + aes128gcm) |
| `sw.js` | Service worker: caché de la app y notificaciones |
| `worker.js` | Cloudflare Worker: rutas `/crtm/…`, `/emt/…`, `/push/…`, Durable Object `PushHub` y cron |
| `wrangler.toml` | Configuración del worker (dominio, Durable Object, cron) |
| `relay/` | Repetidor de respaldo en Deno Deploy: reenvía al worker cuando Cloudflare está bloqueado |
| `tests/` | `node:test` con respuestas reales en `tests/fixtures/` |
| `.github/workflows/` | `tests.yml`, `pages.yml`, `worker.yml`, `healthcheck.yml` |
| `docs/` | GUIA (para quien empieza), REFERENCIA (por dentro), ARQUITECTURA (porqués), MANTENIMIENTO (tareas), DOMINIO (DNS), RESPALDO (repetidor) |

## Reglas que no se pueden saltar

1. **No hacer commits en `main`.** Trabajar en `development` y abrir una PR a `main`; la fusiona el dueño.
2. **Autoría de los commits:** `Sergio Santiago Bendaña Quesada <serbenda@gmail.com>`, sin coautores ni menciones a herramientas de IA en commits, PR ni archivos.
3. **Ningún secreto en el repo.** Las claves de EMT están en Cloudflare y el token de despliegue en GitHub. Nunca escribirlas, pedirlas en texto ni ponerlas en ejemplos.
4. **`npm test` en verde** antes de cada commit. Si cambias `logic.js` o `worker.js`, añade o ajusta un test.
5. **Si cambias `logic.js`, `push.js` o iconos, sube `VERSION` en `sw.js`.**
6. **Sin dependencias ni pasos de compilación** salvo que el dueño lo pida.
7. **La documentación forma parte del cambio:** actualiza `docs/` y `CHANGELOG.md` en la misma PR.

## Comandos

```bash
npm test                         # tests (Node 22)
node --check worker.js           # sintaxis
python3 -m http.server 8000      # ver la web en local: http://localhost:8000
```

En local, la web usa el worker publicado (`api.bendi.dev` o `workers.dev`); el worker solo acepta peticiones desde `bendi.dev` y `serbenda.github.io`, así que desde `localhost` el navegador bloqueará las respuestas por CORS. Para probar la lógica, usa los tests.

## Cosas que confunden

- EMT manda `999999` segundos para "más de 20 min": se muestra **+20**.
- EMT da coordenadas como `[lon, lat]`; en el resto del código son `[lat, lon]`.
- El Consorcio manda un objeto cuando hay un solo elemento y una lista cuando hay varios: usa `asArray()`.
- Los códigos del Consorcio llevan prefijo de red: `8_` interurbano, `9_` urbano, `4_` Metro, `5_` Cercanías, `10_` Metro Ligero, `6_` EMT. Lo que se escribe sin prefijo es `8_` (`crtmCode`).
- `api.bendi.dev` solo funciona con el DNS de `bendi.dev` en Cloudflare ([docs/DOMINIO.md](docs/DOMINIO.md)).
- Durante los partidos de LaLiga, varias operadoras bloquean IP de Cloudflare: por eso existe `relay/` y la web prueba tres direcciones (`PROXIES`). Ver [docs/RESPALDO.md](docs/RESPALDO.md).
- Los avisos se calculan en hora de Madrid aunque el worker funcione en UTC (`alertActive`).
