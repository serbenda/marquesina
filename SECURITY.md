# Seguridad

## Cómo avisar de un problema

Si encuentras un fallo de seguridad (por ejemplo, una forma de leer las claves de EMT o de usar el worker para otra cosa), **no abras un issue público**. Escribe a serbenda@gmail.com explicando qué has visto y cómo reproducirlo.

## Qué datos se manejan

| Dato | Dónde se guarda | Quién lo ve |
|---|---|---|
| Tus paradas, nombres, minutos andando y avisos | Solo en tu navegador (`localStorage`) | Solo tú |
| Avisos activados (parada, horario, minutos) y la dirección de entrega de notificaciones | Durable Object del worker en Cloudflare | Nadie más; no incluye nombre, correo ni ubicación |
| Tu ubicación (botón **Cerca de mí**) | No se guarda; solo se usa para pedir las paradas cercanas | El worker y las APIs de EMT y del Consorcio la reciben para buscar paradas. El worker guarda 1 día la lista de paradas de esa zona (redondeada a ~100 m), sin nada que te identifique |

Si se usa el repetidor de respaldo ([docs/RESPALDO.md](docs/RESPALDO.md)), las mismas peticiones pasan por Deno Deploy, que no guarda nada más que sus registros de acceso habituales.

No hay cuentas, cookies, analítica ni anuncios.

## Secretos

| Secreto | Dónde vive | Si se filtra |
|---|---|---|
| `EMT_CLIENT_ID`, `EMT_PASSKEY` | Cloudflare → worker → Variables and Secrets | Regenerar en Mobility Labs y sustituir ([MANTENIMIENTO §1.5](docs/MANTENIMIENTO.md)) |
| `EMT_EMAIL`, `EMT_PASSWORD` | Igual | Cambiar la contraseña en Mobility Labs y sustituir |
| `CLOUDFLARE_API_TOKEN` | GitHub → Settings → Secrets and variables → Actions | Revocar en Cloudflare (My Profile → API Tokens) y crear otro ([GUIA fase 6](docs/GUIA.md)) |
| Clave privada VAPID | Durable Object del worker (la crea él solo) | No sale nunca del worker |

**Nunca** se escribe un secreto en el código, en un issue, en una PR ni en un chat.

## Medidas en el código

Resumen en [docs/REFERENCIA.md §10](docs/REFERENCIA.md#10-seguridad): CORS limitado, rutas cerradas, validación de todo lo que manda el navegador, límite de suscripciones, envío de avisos solo a servicios de push conocidos y escape de todo el texto que se pinta.
