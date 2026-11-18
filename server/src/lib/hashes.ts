import crypto from 'node:crypto';
import fs from 'node:fs';

const BITS = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i;
  let c = 0;
  while (v) {
    c += v & 1;
    v >>= 1;
  }
  BITS[i] = c;
}

/** Number of differing bits between two look-alike hashes (32 bytes each). */
export function bitsApart(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += BITS[a[i] ^ b[i]];
  return d + Math.abs(a.length - b.length) * 8;
}

export function sha256Buffer(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
