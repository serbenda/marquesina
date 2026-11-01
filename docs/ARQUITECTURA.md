# marquesina: arquitectura y mantenimiento

Este documento explica cómo está montada marquesina, de dónde salen los datos y qué hay que hacer para mantenerla. Es la referencia para cualquier cambio. El [README](../README.md) cubre solo el uso, y los pasos concretos en Mobility Labs, Cloudflare y GitHub están en [MANTENIMIENTO.md](MANTENIMIENTO.md).

## 1. Qué es

Una web estática que muestra en un mapa los autobuses que van a llegar a las paradas que elige el usuario, con los minutos que faltan, y se actualiza sola cada 30 s, 1 min o 2 min.

- **Web:** https://bendi.dev/marquesina/ (GitHub Pages, repo `serbenda/marquesina`).
- **Proxy:** https://marquesina.serbenda.workers.dev (Cloudflare Workers, cuenta de serbenda).
- **No hay servidor propio ni base de datos.** Los ajustes de cada usuario se guardan en su navegador.

## 2. Piezas

```mermaid
flowchart LR
  U[Navegador del usuario<br/>index.html] -- "/emt/... y /crtm/..." --> W[Cloudflare Worker<br/>worker.js]
  W -- "claves de la app<br/>(secretos)" --> EMT[(API EMT Madrid<br/>openapi.emtmadrid.es)]
  W --> CRTM[(API Consorcio<br/>crtm.es/widgets/api)]
  U -- "teselas del mapa" --> OSM[(OpenStreetMap)]
  GH[GitHub repo<br/>rama main] -- "GitHub Actions" --> P[GitHub Pages<br/>bendi.dev/marquesina]
  P -- sirve --> U
```

| Pieza | Archivo | Dónde se ejecuta | Cómo se publica |
|---|---|---|---|
| Web | `index.html` | Navegador del usuario | Automático: push a `main` → workflow `pages.yml` |
| Proxy | `worker.js` | Cloudflare Workers | **Manual:** se copia el código en el panel de Cloudflare |
| Despliegue | `.github/workflows/pages.yml` | GitHub Actions | Forma parte del repo |
| Sin Jekyll | `.nojekyll` | GitHub Pages | Hace que GitHub sirva los archivos tal cual |

`index.html` es un único archivo con HTML, CSS y JS. Lo único externo que carga es Leaflet 1.9.4 (desde cdnjs) y las fuentes de Google Fonts (Barlow Condensed y Figtree).

## 3. Fuentes de datos

### 3.1 EMT Madrid (Mobility Labs)

- **Qué cubre:** autobuses urbanos de la ciudad de Madrid.
- **Qué da:** tiempo de llegada, distancia **y posición GPS** de cada bus. Es lo que permite pintar buses moviéndose en el mapa.
- **Acceso:** la aplicación `marquesina` está registrada en [Mobility Labs](https://mobilitylabs.emtmadrid.es/) con la cuenta de serbenda. Sus claves (**X-ClientId** y **passKey**) están guardadas como secretos del worker (`EMT_CLIENT_ID`, `EMT_PASSKEY`). Como respaldo, el worker también puede entrar con la cuenta de Mobility Labs (`EMT_EMAIL`, `EMT_PASSWORD`): EMT responde código 84 a las claves de una aplicación que aún no ha habilitado. El worker inicia sesión y consulta EMT, así que **los usuarios no necesitan registrarse**.
- **Llamadas:**
  - `GET /v2/mobilitylabs/user/login/`, con cabeceras `X-ClientId` y `passKey` (o `email` y `password` como respaldo). Lo hace solo el worker; la web nunca habla directamente con EMT. Devuelve `accessToken` y `tokenSecExpiration`. El token se reutiliza hasta poco antes de que caduque; si EMT lo rechaza, el worker lo renueva y reintenta una vez.
  - `POST /v2/transport/busemtmad/stops/{parada}/arrives/`, con cabecera `accessToken`. Devuelve la parada (`StopInfo`) y las llegadas (`Arrive[]`: `line`, `destination`, `estimateArrive` en segundos, `DistanceBus` en metros, `geometry.coordinates` como [lon, lat]).

### 3.2 Consorcio Regional de Transportes de Madrid (CRTM)

- **Qué cubre:** interurbanos (151, 153, 158, 827…) y urbanos de otros municipios (Alcobendas, San Sebastián de los Reyes…). Sus paradas tienen código `8_XXXXX`; en la web se escriben solo las 5 cifras.
- **Qué da:** tiempo de llegada por parada. **No da la posición de los autobuses**, así que en el mapa las llegadas se muestran como etiqueta junto a la parada.
- **Acceso:** sin registro, pero **no admite CORS**: el navegador no puede llamarla desde otra web. Por eso pasa por el worker.
- **Llamadas** (siempre vía `https://marquesina.serbenda.workers.dev/crtm/...`):
  - `GetStops.php?codStop=8_06756`: nombre y coordenadas de la parada. Se guarda en caché en memoria mientras la página está abierta.
  - `GetStopsTimes.php?codStop=8_06756&type=1&orderBy=2&stopTimesByIti=3`: próximas llegadas (`stopTimes.times.Time[]`, con `line.shortDescription`, `destination`, `time` en ISO y `codIssue`).
  - `GetNearestStopsByLocation.php?latitude=..&longitude=..&mode=&method=1&precision=350`: paradas cercanas a un punto. Lo usan los botones **Buscar paradas** (punto tocado en el mapa) y **Cerca de mí** (ubicación del navegador; se quedan las 3 más cercanas).
- **Búsqueda de paradas:** `GetNearestStopsByLocation` también devuelve paradas de EMT con prefijo `6_` (el número que sigue es el código de parada de EMT). La web usa esta llamada para encontrar paradas de las dos redes: `6_` va a la lista de EMT y `8_` a la del Consorcio.
- **Peculiaridades:**
  - Cuando solo hay un elemento, la API devuelve un objeto en vez de una lista. Por eso existe `asArray()`.
  - El tiempo restante se calcula como `time − actualDate`, ambos dados por la API, para no depender del reloj del usuario.
  - **En directo / Según horario:** si `codIssue` empieza por el código de la línea (p. ej. `8__153____3_09:05:00...`), el tiempo es de horario. Si no (p. ej. `VCM20033413`), viene del GPS. **Es una deducción propia, no está documentada por el Consorcio.**
  - Devuelve llegadas de horas vista. La web se queda con las 2 primeras de cada línea en los próximos 90 minutos.
  - Es una API no oficial: la usan los widgets de crtm.es y no tiene contrato ni documentación pública. Puede cambiar sin aviso (ver §7).

### 3.3 Mapa

Teselas de OpenStreetMap (`tile.openstreetmap.org`) con atribución. Para un uso intensivo, la política de OSM pide usar otro proveedor de teselas.

## 4. Cómo funciona la web por dentro (`index.html`)

1. **Arranque:** lee los ajustes de `localStorage` (clave `marquesina`) y los combina con los valores por defecto (`DEF`). Si no hay proxy guardado, usa `PROXY`.
2. **Modo:**
   - *En vivo*, si hay paradas de EMT o del Consorcio. Sin ajustes guardados se usan las paradas de ejemplo `06756, 06758` (Alcobendas, constante `DEF.crtm`), así la web arranca en vivo para cualquiera.
   - *Demo*, solo si el usuario la elige (Ajustes → Usar demo, campo `demo: true`): buses simulados que se acercan a Cibeles.
3. **Ciclo:** `setInterval(tick, 1000)`.
   - Cada segundo se actualizan la cuenta atrás del anillo y los minutos de la lista (restando el tiempo transcurrido desde la última consulta, sin volver a llamar a la API).
   - Cuando llega a cero, `refresh()` consulta todas las paradas en paralelo (`Promise.all`). Si una falla, se muestra su error y las demás siguen funcionando.
4. **Mapa:** cada bus de EMT es un marcador con el número de línea y un rastro (`polyline`) que crece en cada consulta. Los buses que dejan de aparecer se borran. Las paradas del Consorcio llevan una etiqueta permanente con las 3 próximas llegadas.
5. **Colores de línea:** salen de un hash del número de línea sobre una paleta fija (`colorFor`), así cada línea tiene siempre el mismo color.
6. **Tema:** claro u oscuro según el sistema, con variables CSS en `:root`.

### Ajustes guardados (`localStorage["marquesina"]`)

| Campo | Significado |
|---|---|
| `stops` | Paradas EMT, separadas por comas |
| `crtm` | Paradas del Consorcio (5 cifras) |
| `proxy` | URL del worker. Vacío en el formulario = usar `PROXY` |
| `every` | Segundos entre consultas (30, 60 o 120) |
| `demo` | `true` si el usuario eligió el modo demo |

## 5. El proxy (`worker.js`)

- `/crtm/<Archivo>.php?...` → `https://www.crtm.es/widgets/api/<Archivo>.php?...`. Solo deja pasar nombres que encajan con `Get*.php`, así no se puede usar como proxy abierto. Cloudflare cachea 20 s, de modo que varios usuarios mirando la misma parada generan una sola llamada al Consorcio.
- `/emt/arrives/<parada>` → inicia sesión en EMT con los secretos de la aplicación (o los de la cuenta si fallan) y devuelve las llegadas de la parada (mismo JSON que EMT). Guarda la respuesta 20 s en la caché de Cloudflare (`caches.default`), así varios usuarios mirando la misma parada generan una sola consulta.
- **CORS:** responde con `Access-Control-Allow-Origin` solo para los orígenes de `ALLOWED_ORIGINS` (`https://bendi.dev`, `https://serbenda.github.io`).
- **Secretos:** `EMT_CLIENT_ID` y `EMT_PASSKEY` (y de respaldo `EMT_EMAIL` y `EMT_PASSWORD`) se configuran en Cloudflare → Worker `marquesina` → Settings → Variables and Secrets (tipo *Secret*). No están en el repo. Para cambiarlos (por ejemplo, si se regeneran en Mobility Labs), se editan ahí y se pulsa Deploy.
- **No guarda ni registra las credenciales de los usuarios.**
- **Límites del plan gratuito de Cloudflare:** 100.000 peticiones al día. Cada usuario con la web abierta hace unas 2 peticiones por parada y minuto (tiempos más, la primera vez, datos de la parada).

## 6. Despliegue

### Web
1. Trabajar en la rama `development`. **Nunca hacer commits directos a `main`.**
2. Abrir una PR `development → main`. La fusiona serbenda.
3. Al fusionar, el workflow **Publicar en GitHub Pages** sube el repo entero a Pages. Tarda unos 30–60 s y se puede seguir en la pestaña *Actions*. También se puede lanzar a mano con *Run workflow*.
4. GitHub Pages cachea unos 10 minutos. Para ver el cambio al momento, recarga forzando (Ctrl/Cmd + Shift + R) o abre la URL con `?v=N`.

Configuración necesaria en el repo: **Settings → Pages → Source: GitHub Actions**. El dominio `bendi.dev` viene del repo `serbenda.github.io`: `bendi.dev/marquesina` funciona porque este repo es un "project site".

### Proxy
Los cambios en `worker.js` **no se despliegan solos**:
1. Cloudflare → Compute (Workers) → `marquesina` → **Edit code**.
2. Pegar el contenido de `worker.js` (copiarlo desde la vista *raw* de GitHub) → **Deploy**.
3. Comprobar en `https://marquesina.serbenda.workers.dev/crtm/GetStops.php?codStop=8_06756`: debe devolver JSON con "MARQUÉS VALDAVIA".

Mejora posible: desplegarlo desde GitHub Actions con `wrangler` y un token de Cloudflare guardado como secreto del repo.

## 7. Mantenimiento: problemas típicos

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| La web sigue mostrando la versión vieja | Caché de Pages o del navegador | Recarga forzada o `?v=N`; revisar que el workflow terminó en verde |
| El workflow no arranca | Pages no está en "GitHub Actions" o Actions desactivadas | Settings → Pages / Settings → Actions → General |
| "No se pudo conectar con el Consorcio…" | Worker caído, URL mal o origen no permitido | Abrir la URL de prueba del §6; si la web está en un dominio nuevo, añadirlo a `ALLOWED_ORIGINS` y volver a desplegar |
| Paradas del Consorcio sin datos o datos raros | El Consorcio cambió su API | Abrir `GetStopsTimes.php` en el navegador, ver el JSON nuevo y ajustar `crtmArrivals()` |
| Paradas de EMT con "EMT rechazó el inicio de sesión" o "Faltan los secretos…" | Secretos del worker sin poner, mal copiados o claves revocadas | Revisar `EMT_CLIENT_ID` y `EMT_PASSKEY` en Cloudflare y la aplicación en Mobility Labs |
| Worker devuelve 429 o deja de responder | Límite diario del plan gratuito | Ver métricas en Cloudflare; subir `cacheTtl` o el intervalo por defecto |
| Todos los tiempos salen "Según horario" | El Consorcio cambió el formato de `codIssue` | Revisar la regla `live` en `crtmArrivals()` |

### Revisiones periódicas
- **Cada pocos meses:** comprobar que las tres APIs siguen respondiendo igual (ver las URLs de prueba).
- **Leaflet:** está fijado a 1.9.4. Para actualizarlo, cambiar la versión en las dos etiquetas (`<link>` del CSS y `<script>`) y probar el mapa.
- **Acciones del workflow:** `checkout@v4`, `configure-pages@v5`, `upload-pages-artifact@v3`, `deploy-pages@v4`. GitHub avisa en *Actions* cuando alguna queda obsoleta.

## 8. Seguridad y privacidad

- Las claves de la aplicación de EMT viven solo como secretos del worker. **Nunca deben aparecer en `index.html` ni en el repo.**
- Todas las consultas de EMT se hacen con la aplicación `marquesina`; los usuarios no ponen ninguna cuenta. Si hubiera abuso, se pueden regenerar las claves en Mobility Labs y actualizar los secretos.
- El worker solo reenvía las consultas de paradas y tiempos del Consorcio y responde a los orígenes permitidos.
- La web no tiene analítica ni cookies propias.

## 9. Ideas pendientes

- Aviso de "sal ya" según el tiempo que se tarda andando a la parada.
- Convertir la web en PWA (instalable y con icono).
- Paradas compartibles por enlace.
- Despliegue automático del worker desde GitHub Actions.
