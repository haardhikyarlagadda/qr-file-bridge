// frame.js — the QR File Bridge wire format.
//
// Every QR frame carries one binary frame, Base45-encoded:
//
//   ┌────────┬───────────┬────────────┬──────────────┬─────────┬──────────┐
//   │ magic  │ sessionId │ frameIndex │ totalFrames  │ crc32   │ payload  │
//   │ 1 B    │ 4 B       │ 3 B        │ 3 B          │ 4 B     │ variable │
//   └────────┴───────────┴────────────┴──────────────┴─────────┴──────────┘
//
// Frame 0 is the Manifest (JSON payload with file metadata).
// Frames 1..N carry ciphertext chunks.
// ACK frames use a distinct magic byte and travel receiver → sender.

import { b45encode, b45decode } from "./base45.js";

export const MAGIC_DATA = 0x51; // 'Q' — data / manifest frame
export const MAGIC_ACK = 0x41;  // 'A' — acknowledgement frame
export const HEADER_LEN = 15;

// ── CRC32 (IEEE 802.3, table-driven) ─────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Frame encode / decode ────────────────────────────────────────────────────

/** Build one frame and return its Base45 string ready for QR encoding. */
export function encodeFrame(magic, sessionId, frameIndex, totalFrames, payload) {
  const buf = new Uint8Array(HEADER_LEN + payload.length);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, magic);
  dv.setUint32(1, sessionId >>> 0);
  dv.setUint8(5, (frameIndex >> 16) & 0xff);
  dv.setUint8(6, (frameIndex >> 8) & 0xff);
  dv.setUint8(7, frameIndex & 0xff);
  dv.setUint8(8, (totalFrames >> 16) & 0xff);
  dv.setUint8(9, (totalFrames >> 8) & 0xff);
  dv.setUint8(10, totalFrames & 0xff);
  dv.setUint32(11, crc32(payload));
  buf.set(payload, HEADER_LEN);
  return b45encode(buf);
}

/**
 * Parse a Base45 string back into a frame.
 * Returns null if the string is not a valid QR File Bridge frame
 * (wrong magic, short, or CRC mismatch) — callers treat null as "not ours".
 */
export function decodeFrame(str) {
  let buf;
  try { buf = b45decode(str); } catch { return null; }
  if (buf.length < HEADER_LEN) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint8(0);
  if (magic !== MAGIC_DATA && magic !== MAGIC_ACK) return null;
  const sessionId = dv.getUint32(1);
  const frameIndex = (dv.getUint8(5) << 16) | (dv.getUint8(6) << 8) | dv.getUint8(7);
  const totalFrames = (dv.getUint8(8) << 16) | (dv.getUint8(9) << 8) | dv.getUint8(10);
  const crc = dv.getUint32(11);
  const payload = buf.slice(HEADER_LEN);
  if (crc32(payload) !== crc) return null; // corrupted scan — drop silently
  return { magic, sessionId, frameIndex, totalFrames, payload };
}

// ── Manifest (Frame 0) ───────────────────────────────────────────────────────

const te = new TextEncoder();
const td = new TextDecoder();
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** Serialize file metadata into the Frame-0 payload. */
export function encodeManifest(meta) {
  return te.encode(JSON.stringify({
    name: meta.name,
    origSize: meta.origSize,
    compSize: meta.compSize,
    totalFrames: meta.totalFrames,
    chunkSize: meta.chunkSize,
    compAlgo: meta.compAlgo,
    encAlgo: "AES-256-GCM",
    salt: b64(meta.salt),
    nonce: b64(meta.nonce),
    sha256: meta.sha256,
  }));
}

export function decodeManifest(payload) {
  const m = JSON.parse(td.decode(payload));
  m.salt = unb64(m.salt);
  m.nonce = unb64(m.nonce);
  return m;
}

// ── ACK frames (receiver → sender) ───────────────────────────────────────────

export const ACK_COMPLETE = 0x00;
export const ACK_MISSING = 0x01;

/**
 * Encode missing-frame indices as ranges ("5,9-14,22") so even a large
 * missing set fits comfortably in a single QR code.
 */
export function encodeAck(sessionId, status, missing = []) {
  const ranges = [];
  const sorted = [...missing].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) { end = sorted[++i]; }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
  }
  const payload = te.encode(JSON.stringify({ status, missing: ranges.join(",") }));
  return encodeFrame(MAGIC_ACK, sessionId, 0, 0, payload);
}

/** Expand an ACK payload back into { status, missing:[indices] }. */
export function decodeAck(payload) {
  const a = JSON.parse(td.decode(payload));
  const missing = [];
  if (a.missing) {
    for (const part of a.missing.split(",")) {
      if (!part) continue;
      const [s, e] = part.split("-").map(Number);
      if (e === undefined) missing.push(s);
      else for (let i = s; i <= e; i++) missing.push(i);
    }
  }
  return { status: a.status, missing };
}
