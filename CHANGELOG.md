# Historial de cambios

Lo más reciente, arriba. Cada entrada dice qué cambia para quien usa la web y en qué Pull Request está.

## Sin publicar

- **Interfaz más cómoda en el móvil:** la lista ocupa más que el mapa; las acciones caben en una fila y *Ajustes* pasa a un icono ⚙; botones de al menos 40 px; destinos legibles (*San Sebastián de los Reyes* en vez de *SAN SEBASTIÁN DE LOS REYES*) en dos líneas en vez de cortados; *luego 14 y 26 min*; pista para poner los minutos andando; el mapa se centra en tu parada en cuanto llega.
- **Arreglado:** tocar *Editar* a veces no hacía nada (la lista se redibujaba cada segundo debajo del dedo).
- **Seguridad:** el nombre de la parada se escapa también en la ventanita del mapa.

## 2 de noviembre de 2026

- **Arreglado (urgente):** tras publicar una versión, la web podía quedarse en *Cargando…* hasta recargar dos veces. Ahora siempre usa los archivos nuevos y, si algo falla al arrancar, ofrece **Recargar** — #30

## 1 de noviembre de 2026 (noche)

- **Aviso mientras busca:** *Buscando paradas…* con ruedita y, al terminar, cuántas hay. Mensaje claro en paradas sin servicio — #29
- **Compartir paradas por enlace** (Ajustes → *Compartir mis paradas*) — #29
- **Prueba en navegador** en cada PR, tras publicar y cada 3 horas, con un bloqueo de Cloudflare simulado — #29
- **Chequeo horario con tiempos:** avisa también si algo va lento — #29
- **Más margen para el Consorcio:** 15 s para los minutos de una parada; el nombre de cada parada y los recorridos de las líneas, 1 día en caché. Prueba de campo en 10 localidades — #28
- **Búsqueda de paradas más fiable y rápida:** el worker guarda 1 día las búsquedas del Consorcio (tardaban 4–10 s y a veces fallaban) y la web les da más margen — #27
- **Arreglado:** con el repetidor, *Zona*, *Buscar paradas* y *Cerca de mí* casi no encontraban paradas (Deno Deploy rechaza las rutas `.php`). La web las pide sin `.php`; chequeo real de la búsqueda por Deno — #26
- **Documentación de ingeniería:** historia del proyecto ([docs/HISTORIA.md](docs/HISTORIA.md)), operación del servicio ([docs/OPERACIONES.md](docs/OPERACIONES.md)) y arquitectura de seguridad ([docs/SEGURIDAD.md](docs/SEGURIDAD.md)); el repetidor, integrado en toda la documentación — #26
- **Seguridad:** Leaflet se carga con huella SRI — #26
- **Repetidor documentado** como montado y probado con el bloqueo activo — #25
- **Repetidor de respaldo fuera de Cloudflare** (Deno Deploy, `marquesina.serbenda.deno.net`) para los bloqueos de LaLiga, que cortan IP de Cloudflare en Movistar, MasOrange, Vodafone y DIGI ([docs/RESPALDO.md](docs/RESPALDO.md)) — #24
- **Acciones de GitHub al día** (Dependabot): `checkout` 7, `setup-node` 7, `configure-pages` 6, `deploy-pages` 5 y `wrangler-action` 4 — #19–#23
- **Documentación:** referencia técnica con diagramas ([docs/REFERENCIA.md](docs/REFERENCIA.md)), código comentado archivo por archivo, [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [AGENTS.md](AGENTS.md), plantillas de issues y PR y README nuevo; `api.bendi.dev` funcionando con el DNS de bendi.dev en Cloudflare — #18

## 1 de noviembre de 2026 (mañana y tarde)

- **Guía paso a paso para empezar de cero**, con 14 diagramas ([GUIA.md](docs/GUIA.md)) — #17
- **Dominio propio `api.bendi.dev`**, con paso automático a `workers.dev` si una dirección no responde. Arregla el "No se pudo conectar" en redes que bloquean `*.workers.dev` — #16
- **Resiste los fallos del Consorcio:** reintento, últimos datos buenos (15 min) y menos peticiones a la vez. Los buses de EMT a más de 20 min salen como "+20" — #15
- **Carga rápida:** la posición de los buses ya no retrasa los minutos, cada parada aparece en cuanto llega y ninguna petición espera más de 10 s — #14
- **Sin modo demo ni proxy configurable.** Ajustes conserva los nombres y los avisos de las paradas — #13
- **Paradas de EMT que faltaban** (El Pardo): la búsqueda une EMT y el Consorcio — #12
- **Avisos para salir de casa** (notificaciones), botón **Zona** con municipios, Metro y Cercanías, mapa más limpio, bienvenida, datos antiguos marcados y tests automáticos — #11
- **Autobuses del Consorcio en movimiento** en el mapa (GPS real) — #10
- **Cuándo salir**, paradas con nombre, app instalable y despliegue automático del worker — #9
- **Documentación de mantenimiento**; Ajustes sin cuenta de EMT — #8
- **EMT Madrid sin registrarse:** el worker usa las claves de la aplicación — #7
- **Arranca en vivo** con paradas de Alcobendas y botón **Cerca de mí** — #6
- **Proxy configurado por defecto** — #5
- **Alcobendas, Sanse e interurbanos** (Consorcio de Transportes) — #4
- Publicación con GitHub Actions — #3

## 31 de octubre de 2026

- Publicación en GitHub Pages — #2
- **Primera versión:** mapa en tiempo real de autobuses de EMT — #1
