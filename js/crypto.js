// crypto.js — key derivation, AES-256-GCM, SHA-256, compression.
// Everything runs on the Web Crypto API and CompressionStream — no libraries,
// no network. Ciphertext is the only thing that ever reaches the QR channel.

const PBKDF2_ITERATIONS = 100_000;

/** Derive a 256-bit AES-GCM key from a passphrase + salt via PBKDF2-SHA-256. */
export async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt bytes with AES-256-GCM. Returns { ciphertext, nonce, salt }. */
export async function encrypt(plainBytes, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, key, plainBytes
  );
  return { ciphertext: new Uint8Array(ct), nonce, salt };
}

/** Decrypt AES-256-GCM ciphertext. Throws on auth-tag failure (wrong passphrase / tampering). */
export async function decrypt(cipherBytes, passphrase, salt, nonce) {
  const key = await deriveKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce }, key, cipherBytes
  );
  return new Uint8Array(pt);
}

/** SHA-256 digest as lowercase hex. */
export async function sha256hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export const compressionSupported =
  typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

/** Deflate-compress bytes; returns input unchanged if the API is unavailable. */
export async function compress(bytes) {
  if (!compressionSupported) return { data: bytes, algo: "none" };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  const data = new Uint8Array(await new Response(stream).arrayBuffer());
  // Incompressible data can grow; keep whichever is smaller.
  return data.length < bytes.length ? { data, algo: "deflate" } : { data: bytes, algo: "none" };
}

/** Inverse of compress(). */
export async function decompress(bytes, algo) {
  if (algo === "none") return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(algo));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
