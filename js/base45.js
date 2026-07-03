// base45.js — Base45 encoding per draft-faltstrom-base45
// The Base45 alphabet is a strict subset of the QR alphanumeric character set,
// which lets QR codes use alphanumeric mode (~45% denser than byte mode).

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const REVERSE = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

/**
 * Encode a Uint8Array into a Base45 string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function b45encode(bytes) {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i + 1 < n; i += 2) {
    const v = bytes[i] * 256 + bytes[i + 1]; // 0..65535
    const e = Math.floor(v / (45 * 45));
    const d = Math.floor((v % (45 * 45)) / 45);
    const c = v % 45;
    out += ALPHABET[c] + ALPHABET[d] + ALPHABET[e];
  }
  if (n % 2 === 1) {
    const v = bytes[n - 1]; // 0..255
    const d = Math.floor(v / 45);
    const c = v % 45;
    out += ALPHABET[c] + ALPHABET[d];
  }
  return out;
}

/**
 * Decode a Base45 string into a Uint8Array.
 * @param {string} str
 * @returns {Uint8Array}
 * @throws {Error} on invalid characters or malformed length
 */
export function b45decode(str) {
  const len = str.length;
  if (len % 3 === 1) throw new Error("Base45: invalid length");
  const outLen = Math.floor(len / 3) * 2 + (len % 3 === 2 ? 1 : 0);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i + 2 < len + 1; i += 3) {
    if (i + 3 <= len) {
      const c = REVERSE[str[i]], d = REVERSE[str[i + 1]], e = REVERSE[str[i + 2]];
      if (c === undefined || d === undefined || e === undefined)
        throw new Error("Base45: invalid character");
      const v = c + d * 45 + e * 45 * 45;
      if (v > 65535) throw new Error("Base45: value overflow");
      out[o++] = v >> 8;
      out[o++] = v & 0xff;
    } else if (i + 2 <= len) {
      const c = REVERSE[str[i]], d = REVERSE[str[i + 1]];
      if (c === undefined || d === undefined)
        throw new Error("Base45: invalid character");
      const v = c + d * 45;
      if (v > 255) throw new Error("Base45: value overflow");
      out[o++] = v;
    }
  }
  return out;
}
