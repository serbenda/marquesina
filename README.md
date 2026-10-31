# marquesina

Mapa en tiempo real de los autobuses de EMT Madrid que llegan a tus paradas: dónde están, cuánto les falta y si te da tiempo a salir.

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

## Proxy opcional (CORS)

Si el navegador no puede llamar directamente a la API de EMT, despliega `worker.js` en Cloudflare Workers (plan gratuito):

1. Cloudflare → Workers → Create → pega el contenido de `worker.js` → Deploy.
2. Ajusta `ALLOWED_ORIGIN` si la web no está en `https://serbenda.github.io`.
3. Pon la URL del worker (`https://xxx.workers.dev`) en **Ajustes → URL de la API**.

## Publicar

Es una web estática: activa GitHub Pages sobre la rama `main` (carpeta raíz).

## Datos

- Autobuses: API de EMT Madrid (Mobility Labs).
- Mapa: © colaboradores de OpenStreetMap.
