// A synchronous SHA-256 (FIPS 180-4). Web Crypto `digest` is async, but a webhook
// `parse` is synchronous and must still derive an event key from the raw body. Use Web
// Crypto everywhere an async call is possible.

// The round constants and the initial hash are the first 32 bits of the fractional parts
// of the cube roots of the first 64 primes and the square roots of the first 8 primes.
// Computing them is smaller than a literal table, and the test checks the digests.
const K: Uint32Array = new Uint32Array(64);
const H: Uint32Array = new Uint32Array(8);
const fraction = (x: number): number => ((x - Math.floor(x)) * 0x100000000) >>> 0;
for (let n = 2, found = 0; found < 64; n++) {
  let prime = true;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false;
  if (!prime) continue;
  if (found < 8) H[found] = fraction(Math.sqrt(n));
  K[found++] = fraction(Math.cbrt(n));
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** Returns the SHA-256 digest of `data` as lowercase hex. */
export function sha256Hex(data: Uint8Array): string {
  const length = data.length;
  // The message, a 0x80 byte, zero padding, and the 64-bit bit length, in 64-byte blocks.
  const total = (((length + 8) >> 6) + 1) << 6;
  const bytes = new Uint8Array(total);
  bytes.set(data);
  bytes[length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(total - 8, Math.floor(length / 0x20000000));
  view.setUint32(total - 4, (length << 3) >>> 0);
  const h = H.slice();
  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] as number) + s0 + (w[i - 7] as number) + s1;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (hh +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          (K[i] as number) +
          (w[i] as number)) |
        0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] as number) + a;
    h[1] = (h[1] as number) + b;
    h[2] = (h[2] as number) + c;
    h[3] = (h[3] as number) + d;
    h[4] = (h[4] as number) + e;
    h[5] = (h[5] as number) + f;
    h[6] = (h[6] as number) + g;
    h[7] = (h[7] as number) + hh;
  }
  let hex = "";
  for (const word of h) hex += word.toString(16).padStart(8, "0");
  return hex;
}
