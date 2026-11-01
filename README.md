# marquesina

Mapa en tiempo real de los autobuses que llegan a tus paradas (EMT Madrid, y también interurbanos y urbanos de Alcobendas, San Sebastián de los Reyes y el resto de la Comunidad): dónde están, cuánto les falta y si te da tiempo a salir.

## Qué hace

- Muestra en un mapa (OpenStreetMap + Leaflet) los autobuses que se dirigen a tus paradas, con su número de línea.
- Se actualiza cada 30 segundos, 1 minuto o 2 minutos.
- Lista de llegadas con línea, destino, minutos que faltan, distancia y estado (*Llegando*, *Cerca*, *En camino*).
- Cada bus deja un rastro en el mapa para ver por dónde viene. Tocar una llegada centra el mapa en ese bus.
- Sin credenciales funciona en **modo demo** con autobuses simulados.

## Uso con datos reales

1. Regístrate gratis en [Mobility Labs](https://mobilitylabs.emtmadrid.es/) (EMT Madrid) y activa la cuenta desde el correo.
2. Abre la web, pulsa **Ajustes** y escribe tu email, tu contraseña y los números de tus paradas (aparecen en la marquesina de cada parada), separados por comas.

Las credenciales se guardan solo en el `localStorage` de tu navegador.

## Alcobendas, Sanse e interurbanos (Consorcio de Transportes)

Los autobuses que no son de EMT (interurbanos como el 151, 153, 158, 827 o los urbanos de Alcobendas y Sanse) salen de la API del Consorcio Regional de Transportes de Madrid. No necesita registro, pero no admite llamadas directas desde otras webs, así que hay que pasar por el proxy (`worker.js`).

- Da los **tiempos de llegada** por parada, en directo cuando el bus lleva GPS y según horario cuando no. No da la posición de los autobuses, así que en el mapa las llegadas aparecen junto a cada parada.
- Para encontrar tus paradas, pulsa **Buscar paradas**, toca el mapa y añade las que quieras.

## Proxy (Cloudflare Workers)

1. Crea una cuenta gratuita en Cloudflare → **Workers & Pages** → **Create** → **Worker** → **Deploy**.
2. **Edit code**, pega el contenido de `worker.js` y pulsa **Deploy**.
3. Copia la URL del worker (`https://xxx.workers.dev`) en **Ajustes → URL de tu proxy**.

Si publicas la web en otro dominio, añádelo a `ALLOWED_ORIGINS` en `worker.js`.

## Publicar

Es una web estática: activa GitHub Pages sobre la rama `main` (carpeta raíz).

## Datos

- Autobuses: API de EMT Madrid (Mobility Labs) y API del Consorcio Regional de Transportes de Madrid.
- Mapa: © colaboradores de OpenStreetMap.
