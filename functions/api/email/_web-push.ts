/**
 * Web Push for Cloudflare Workers
 * Implements RFC 8291 (Message Encryption) + RFC 8292 (VAPID)
 * Uses Web Crypto API (no Node.js dependencies)
 */

// ─── Helpers ───────────────────────────────────────────────

function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(padded + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function encodeLength(len: number): Uint8Array {
  // Big-endian 32-bit
  return new Uint8Array([
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
  ]);
}

// ─── VAPID JWT ────────────────────────────────────────────

async function importVapidPrivateKey(base64UrlKey: string): Promise<CryptoKey> {
  const rawKey = base64UrlDecode(base64UrlKey);
  // VAPID private key is raw 32-byte P-256 scalar
  // We need to build a JWK from it
  const publicKey = await deriveVapidPublicFromPrivate(rawKey);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: base64UrlEncode(rawKey),
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function deriveVapidPublicFromPrivate(privateKeyRaw: Uint8Array): Promise<Uint8Array> {
  // Import as ECDH to derive public key
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: base64UrlEncode(privateKeyRaw),
    // We need x,y but we're deriving them... chicken-and-egg.
    // Instead, let's do: importKey pkcs8 → exportKey raw (public)
  };

  // Build PKCS8 from raw private key
  const pkcs8 = buildPkcs8FromRaw(privateKeyRaw);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  // Export as JWK to get x,y
  const exportedJwk = await crypto.subtle.exportKey("jwk", key);
  const x = base64UrlDecode(exportedJwk.x!);
  const y = base64UrlDecode(exportedJwk.y!);
  // Uncompressed point: 0x04 || x || y
  return concat(new Uint8Array([0x04]), x, y);
}

function buildPkcs8FromRaw(rawPrivateKey: Uint8Array): Uint8Array {
  // PKCS8 wrapper for P-256 EC private key
  // Sequence { Version(0), AlgorithmIdentifier(EC, P-256), OctetString(ECPrivateKey) }
  const ecPrivateKey = buildEcPrivateKey(rawPrivateKey);
  const algorithmId = new Uint8Array([
    0x30, 0x13, // SEQUENCE (19 bytes)
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID: 1.2.840.10045.2.1 (EC)
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID: 1.2.840.10045.3.1.7 (P-256)
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
  const octetStringHeader = asn1OctetString(ecPrivateKey);
  const inner = concat(version, algorithmId, octetStringHeader);
  return asn1Sequence(inner);
}

function buildEcPrivateKey(rawKey: Uint8Array): Uint8Array {
  // ECPrivateKey SEQUENCE { version(1), privateKey }
  const version = new Uint8Array([0x02, 0x01, 0x01]); // INTEGER 1
  const keyOctet = asn1OctetString(rawKey);
  return asn1Sequence(concat(version, keyOctet));
}

function asn1Sequence(content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x30]), asn1Length(content.length), content);
}

function asn1OctetString(content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x04]), asn1Length(content.length), content);
}

function asn1Length(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  if (len < 0x100) return new Uint8Array([0x81, len]);
  return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
}

async function createVapidJwt(
  audience: string,
  subject: string,
  vapidPrivateKey: string,
  expSeconds: number = 12 * 60 * 60
): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + expSeconds,
    sub: subject,
  };

  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  const key = await importVapidPrivateKey(vapidPrivateKey);
  const signatureBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    key,
    new TextEncoder().encode(unsignedToken)
  );

  // Convert DER signature to raw r||s format (each 32 bytes)
  const signature = derToRaw(new Uint8Array(signatureBuffer));
  const signatureB64 = base64UrlEncode(signature);
  return `${unsignedToken}.${signatureB64}`;
}

function derToRaw(der: Uint8Array): Uint8Array {
  // Web Crypto ECDSA signatures are DER-encoded
  // We need raw format: r (32 bytes) || s (32 bytes)
  // DER: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>

  // But Web Crypto on Cloudflare Workers might already return raw...
  // Check: if first byte is 0x30, it's DER; otherwise assume raw
  if (der[0] !== 0x30) {
    // Already raw r||s format (64 bytes)
    if (der.length === 64) return der;
  }

  let offset = 2; // skip 0x30 and length byte
  if (der[1] & 0x80) offset += (der[1] & 0x7f); // long form length

  // Parse r
  if (der[offset] !== 0x02) throw new Error("Invalid DER: expected INTEGER tag for r");
  offset++;
  const rLen = der[offset++];
  let r = der.slice(offset, offset + rLen);
  offset += rLen;
  // Strip leading zero padding
  if (r.length === 33 && r[0] === 0) r = r.slice(1);

  // Parse s
  if (der[offset] !== 0x02) throw new Error("Invalid DER: expected INTEGER tag for s");
  offset++;
  const sLen = der[offset++];
  let s = der.slice(offset, offset + sLen);
  if (s.length === 33 && s[0] === 0) s = s.slice(1);

  // Pad to 32 bytes each
  const result = new Uint8Array(64);
  result.set(r, 32 - r.length);
  result.set(s, 64 - s.length);
  return result;
}

// ─── RFC 8291 Message Encryption ─────────────────────────

interface PushSubscriptionKeys {
  p256dh: string; // base64url - client's public key
  auth: string;   // base64url - client's auth secret
}

async function encryptPayload(
  payload: string,
  subscriptionKeys: PushSubscriptionKeys
): Promise<{ encrypted: Uint8Array; localPublicKey: Uint8Array; salt: Uint8Array }> {
  const clientPublicKeyRaw = base64UrlDecode(subscriptionKeys.p256dh);
  const clientAuthSecret = base64UrlDecode(subscriptionKeys.auth);
  const plaintext = new TextEncoder().encode(payload);

  // Generate local ephemeral ECDH key pair
  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  // Export local public key (uncompressed)
  const localPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey)
  );

  // Import client's public key
  const clientPublicKey = await crypto.subtle.importKey(
    "raw",
    clientPublicKeyRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // ECDH shared secret
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientPublicKey },
      localKeyPair.privateKey,
      256
    )
  );

  // Generate random 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291 key derivation
  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || client_public || server_public, 32)
  const authInfo = concat(
    new TextEncoder().encode("WebPush: info\0"),
    clientPublicKeyRaw,
    localPublicKeyRaw
  );
  const ikm = await hkdf(clientAuthSecret, sharedSecret, authInfo, 32);

  // PRK = HKDF-Extract(salt, IKM)
  // key = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)
  // nonce = HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12)
  const keyInfo = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
  const nonceInfo = new TextEncoder().encode("Content-Encoding: nonce\0");

  const contentKey = await hkdf(salt, ikm, keyInfo, 16);
  const nonce = await hkdf(salt, ikm, nonceInfo, 12);

  // Pad plaintext: add 1 byte delimiter (0x02 for final record) + optional padding
  const paddedPlaintext = concat(plaintext, new Uint8Array([2]));

  // AES-128-GCM encrypt
  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      paddedPlaintext
    )
  );

  // Build aes128gcm content coding header:
  // salt (16) || recordSize (4, big-endian uint32) || keyIdLen (1) || keyId (65 = uncompressed P-256 public key)
  const recordSize = paddedPlaintext.length + 16; // plaintext + 16 byte tag
  const header = concat(
    salt,
    encodeLength(recordSize),
    new Uint8Array([65]), // keyIdLen
    localPublicKeyRaw
  );

  const encrypted = concat(header, ciphertext);
  return { encrypted, localPublicKey: localPublicKeyRaw, salt };
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  // HKDF-Extract
  const prk = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const extract = new Uint8Array(await crypto.subtle.sign("HMAC", prk, ikm));

  // HKDF-Expand
  const prkKey = await crypto.subtle.importKey("raw", extract, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const infoWithCounter = concat(info, new Uint8Array([1]));
  const expanded = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, infoWithCounter));
  return expanded.slice(0, length);
}

// ─── Public API ──────────────────────────────────────────

export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface SendPushResult {
  success: boolean;
  status?: number;
  statusText?: string;
  error?: string;
}

export async function sendWebPush(
  subscription: PushSubscriptionJSON,
  payload: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string = "mailto:admin@cleanenergyexperts.pro"
): Promise<SendPushResult> {
  try {
    // 1. Get audience from endpoint URL
    const endpointUrl = new URL(subscription.endpoint);
    const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;

    // 2. Create VAPID JWT
    const jwt = await createVapidJwt(audience, vapidSubject, vapidPrivateKey);

    // 3. Get the raw VAPID public key for the Authorization header
    const vapidPublicKeyRaw = base64UrlDecode(vapidPublicKey);
    const vapidKeyB64 = base64UrlEncode(vapidPublicKeyRaw);

    // 4. Encrypt the payload per RFC 8291
    const { encrypted } = await encryptPayload(payload, subscription.keys);

    // 5. Send to push service
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        "Content-Length": String(encrypted.byteLength),
        Authorization: `vapid t=${jwt}, k=${vapidKeyB64}`,
        TTL: "86400",
        Urgency: "high",
      },
      body: encrypted,
    });

    return {
      success: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
    };
  } catch (e: any) {
    return {
      success: false,
      error: e.message || String(e),
    };
  }
}

/**
 * Send push notifications to all active subscriptions
 */
export async function broadcastPush(
  subscriptions: Array<{ subscription_json: PushSubscriptionJSON; id: string }>,
  payload: object,
  vapidPublicKey: string,
  vapidPrivateKey: string
): Promise<Array<{ id: string; result: SendPushResult }>> {
  const payloadStr = JSON.stringify(payload);
  const results: Array<{ id: string; result: SendPushResult }> = [];

  for (const sub of subscriptions) {
    if (!sub.subscription_json?.endpoint || !sub.subscription_json?.keys) {
      results.push({ id: sub.id, result: { success: false, error: "Invalid subscription data" } });
      continue;
    }
    const result = await sendWebPush(
      sub.subscription_json,
      payloadStr,
      vapidPublicKey,
      vapidPrivateKey
    );
    results.push({ id: sub.id, result });
  }

  return results;
}
