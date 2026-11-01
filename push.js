// Web Push para marquesina, sin dependencias: solo WebCrypto (funciona en Cloudflare Workers y en Node).
//
//  - generateVapidKeys(): par de claves VAPID (P-256). La pública la usa el navegador para suscribirse.
//  - sendPush(subscription, payload, vapid): cifra el mensaje (RFC 8291, aes128gcm), firma la cabecera
//    VAPID (RFC 8292, ES256) y lo envía al servicio de push del navegador (Google, Mozilla, Apple...).

const te = new TextEncoder();

export const b64url = bytes =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const unb64url = str => {
  const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// ---------- Claves VAPID ----------
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    publicKey: b64url(await crypto.subtle.exportKey("raw", kp.publicKey)),   // 65 bytes, formato que pide el navegador
    privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey),
  };
}

// Cabecera Authorization: vapid t=<JWT>, k=<clave pública>
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

// Servicios de push conocidos: solo se envía a estos (evita usar el worker para llamar a cualquier URL)
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];
export const isPushEndpoint = endpoint => {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some(r => r.test(u.hostname));
  } catch { return false; }
};

// Envía una notificación. Devuelve el código HTTP del servicio de push (201 = aceptada; 404/410 = suscripción caducada)
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
