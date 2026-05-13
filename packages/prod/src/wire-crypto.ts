/**
 * Browser-only Ed25519 + JWT helpers for the wallet-vault Wire integration.
 *
 * wire-tools' crypto module uses Node's Buffer in a few places, which doesn't
 * exist in a Chrome MV3 service worker. This is the same shape, but pure
 * Web Crypto + atob/btoa.
 */

export interface KeyPair {
  publicKeyB64: string;
  privateKey: CryptoKey;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64UrlEncodeBytes(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generateKeyPair(): Promise<KeyPair> {
  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  return { publicKeyB64: await derivePublicKeyB64(kp.privateKey), privateKey: kp.privateKey };
}

export async function derivePublicKeyB64(privateKey: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (!jwk.x) throw new Error("Ed25519 jwk missing x coord");
  const pub = jwk.x.replace(/-/g, "+").replace(/_/g, "/");
  return pub + "=".repeat((4 - (pub.length % 4)) % 4);
}

export async function exportPrivateKeyB64(privateKey: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  return bytesToB64(new Uint8Array(pkcs8));
}

export async function importPrivateKey(b64Pkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", b64ToBytes(b64Pkcs8), "Ed25519", true, ["sign"]);
}

const JWT_HEADER_B64URL = b64UrlEncodeBytes(
  new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })),
);

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Wire JWT: claims = { iss, iat, body_hash }. Signed with Ed25519, encoded
 * as compact JWS. Same shape as wire-tools' createAuthJwt.
 */
export async function createAuthJwt(
  privateKey: CryptoKey,
  agentId: string,
  body: string,
): Promise<string> {
  const claims = {
    iss: agentId,
    iat: Math.floor(Date.now() / 1000),
    body_hash: await sha256Hex(body),
  };
  const payloadB64 = b64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${JWT_HEADER_B64URL}.${payloadB64}`;
  const sig = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64UrlEncodeBytes(new Uint8Array(sig))}`;
}
