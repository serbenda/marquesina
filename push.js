/**
 * push.js — Enviar notificaciones al móvil (Web Push), sin librerías
 * =================================================================
 *
 * QUÉ ES
 *   Todo lo necesario para mandar el aviso "¡Sal ya!" a un navegador. Solo usa WebCrypto
 *   (crypto.subtle), que existe igual en Cloudflare Workers, en Node y en los navegadores.
 *
 * QUIÉN LO USA
 *   - worker.js:  genera las claves, firma y cifra cada aviso y lo envía.
 *   - index.html: solo unb64url, para pasar la clave pública al navegador al suscribirse.
 *   - tests/worker.test.js: comprueba que el cifrado y la firma son válidos.
 *
 * CÓMO FUNCIONA WEB PUSH (en tres frases)
 *   1. El navegador se "suscribe" con nuestra clave pública y nos da una dirección de entrega (endpoint)
 *      en el servicio de push de su fabricante (Google, Mozilla, Apple, Microsoft) y dos claves suyas.
 *   2. Para enviar, ciframos el mensaje con las claves del navegador (solo él puede leerlo) y firmamos
 *      la petición con nuestra clave privada (para que el servicio sepa que somos nosotros).
 *   3. El servicio de push lo entrega al móvil, que lo pasa a sw.js, que enseña la notificación.
 *
 * ESTÁNDARES
 *   RFC 8030 (Web Push) · RFC 8291 (cifrado, aes128gcm) · RFC 8292 (VAPID, firma ES256 con P-256).
 *
 * Diagrama: docs/REFERENCIA.md §7.4.
 */

const te = new TextEncoder();

/** Bytes → texto base64url (base64 sin "+", "/" ni "=", apto para URL y cabeceras). */
export const b64url = bytes =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Texto base64url → bytes. Lo contrario de b64url. */
export const unb64url = str => {
  const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};

// Une varios trozos de bytes en uno
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

// HKDF-SHA256: deriva una clave de `length` bytes a partir de un secreto (ikm), una sal y una etiqueta (info)
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// ---------- Claves VAPID ----------

/**
 * Crea un par de claves VAPID (curva P-256). El worker lo hace UNA sola vez y lo guarda en el
 * Durable Object; si cambiaran, todas las suscripciones existentes dejarían de valer.
 * @returns {Promise<{publicKey: string, privateJwk: object}>}  publicKey en base64url (65 bytes).
 */
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    publicKey: b64url(await crypto.subtle.exportKey("raw", kp.publicKey)),   // 65 bytes, formato que pide el navegador
    privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey),
  };
}

/**
 * Cabecera Authorization para el servicio de push: "vapid t=<JWT firmado>, k=<clave pública>".
 * El JWT dice a quién va (aud = origen del endpoint), hasta cuándo vale (12 h) y quién lo manda (sub).
 * @param {string} endpoint  Dirección de entrega de la suscripción.
 * @param {{publicKey, privateJwk}} vapid
 * @returns {Promise<string>}
 */
export async function vapidAuthorization(endpoint, vapid, subject = "https://bendi.dev/marquesina") {
  const header = b64url(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(te.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${vapid.publicKey}`;
}

// ---------- Cifrado del mensaje (aes128gcm) ----------

/**
 * Cifra un texto para una suscripción concreta (RFC 8291). Pasos:
 *   1. Clave temporal ECDH nuestra + clave pública del navegador (p256dh) → secreto compartido.
 *   2. HKDF con el secreto de autenticación del navegador (auth) → clave de contenido y nonce.
 *   3. AES-128-GCM del texto. Delante va una cabecera con la sal, el tamaño de registro y nuestra clave temporal.
 * @param {{keys: {p256dh: string, auth: string}}} subscription
 * @param {string} plaintext  Normalmente el JSON {title, body, tag, url}.
 * @returns {Promise<Uint8Array>}  Cuerpo listo para enviar.
 */
export async function encryptPayload(subscription, plaintext) {
  const uaPublic = unb64url(subscription.keys.p256dh);   // clave pública del navegador (65 bytes)
  const authSecret = unb64url(subscription.keys.auth);   // secreto de autenticación (16 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(te.encode("WebPush: info\u0000"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\u0000"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\u0000"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(te.encode(plaintext), new Uint8Array([2]));   // 0x02 = último (y único) registro
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// Servicios de push conocidos: solo se envía a estos (evita que alguien use el worker para llamar a cualquier URL)
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];
/** ¿Es una dirección de entrega HTTPS de un servicio de push conocido? (Google, Mozilla, Apple, Microsoft) */
export const isPushEndpoint = endpoint => {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some(r => r.test(u.hostname));
  } catch { return false; }
};

/**
 * Envía una notificación.
 * @param {{endpoint, keys}} subscription  La que dio el navegador.
 * @param {object|string} payload  Se manda como JSON; sw.js lo lee en el evento "push".
 * @param {{publicKey, privateJwk}} vapid
 * @param {number} ttl  Segundos que el servicio lo guarda si el móvil está apagado (después se descarta).
 * @returns {Promise<number>}  Código HTTP: 201 aceptada · 404/410 suscripción caducada (hay que borrarla)
 *                             · 400 dirección no permitida (no se llega a enviar).
 */
export async function sendPush(subscription, payload, vapid, ttl = 300) {
  if (!isPushEndpoint(subscription.endpoint)) return 400;
  const body = await encryptPayload(subscription, typeof payload === "string" ? payload : JSON.stringify(payload));
  const r = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "high",
    },
    body,
  });
  return r.status;
}
