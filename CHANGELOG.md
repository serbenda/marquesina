# Historial de cambios

Lo más reciente, arriba. Cada entrada dice qué cambia para quien usa la web y en qué Pull Request está.

## Sin publicar

- **Repetidor de respaldo fuera de Cloudflare** (Deno Deploy) para que marquesina siga funcionando durante los bloqueos de LaLiga, que cortan IP de Cloudflare en Movistar, MasOrange, Vodafone y DIGI. La web prueba las tres direcciones a la vez y recuerda la que funciona ([docs/RESPALDO.md](docs/RESPALDO.md)).
- **`api.bendi.dev` ya funciona:** el DNS de bendi.dev está en Cloudflare y el worker responde en su dominio propio.
- **Documentación:** referencia técnica con diagramas ([docs/REFERENCIA.md](docs/REFERENCIA.md)), código comentado archivo por archivo, normas para hacer cambios ([CONTRIBUTING.md](CONTRIBUTING.md)), seguridad ([SECURITY.md](SECURITY.md)), guía para asistentes de IA ([AGENTS.md](AGENTS.md)), plantillas de issues y PR, y README nuevo.

## 1 de noviembre de 2026

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
