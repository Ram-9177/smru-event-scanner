import sharp from 'sharp';
import type { FaceEngine, FoundFace } from '../../src/face/index.js';

/**
 * A stand-in for the Python face service, so the tests need no models and no real faces.
 *
 *   "Face" = a block of one saturated colour. The colour's hue is the person:
 *            same hue -> same person (similarity 1), another hue -> a stranger (0).
 *            A dim block of the same hue scores about 0.45 against a bright selfie ("maybe" tier).
 *   Look-alike hash = the same 256-bit difference hash as the real service, made with sharp.
 */
const DIM_MIX = 1.98; // 1 / sqrt(1 + 1.98^2) = 0.45

function hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

async function detect(jpeg: Buffer): Promise<FoundFace[]> {
  const meta = await sharp(jpeg).metadata();
  const W = 160;
  const { data, info } = await sharp(jpeg).resize({ width: W }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const scale = meta.width! / info.width;
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number; n: number; v: number }>();
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      const [h, s, v] = hsv(data[i], data[i + 1], data[i + 2]);
      if (s < 0.7 || v < 0.35) continue;
      const bucket = Math.round(h / 30) % 12;
      const b = boxes.get(bucket) ?? { x0: x, y0: y, x1: x, y1: y, n: 0, v: 0 };
      b.x0 = Math.min(b.x0, x);
      b.y0 = Math.min(b.y0, y);
      b.x1 = Math.max(b.x1, x);
      b.y1 = Math.max(b.y1, y);
      b.n++;
      b.v += v;
      boxes.set(bucket, b);
    }
  }
  const out: FoundFace[] = [];
  for (const [bucket, b] of boxes) {
    if (b.n < 6) continue;
    const vector = new Float32Array(128);
    const dim = b.v / b.n < 0.75;
    vector[bucket] = 1;
    if (dim) vector[127] = DIM_MIX;
    const norm = Math.hypot(...vector);
    for (let k = 0; k < 128; k++) vector[k] /= norm;
    out.push({ x: b.x0 * scale, y: b.y0 * scale, w: (b.x1 - b.x0 + 1) * scale, h: (b.y1 - b.y0 + 1) * scale, score: 0.99, vector });
  }
  return out.sort((a, b) => a.x - b.x);
}

export function stubFace(): FaceEngine & { calls: { fingerprint: number; faces: number; selfie: number } } {
  const calls = { fingerprint: 0, faces: 0, selfie: 0 };
  return {
    model: 'stub',
    calls,
    async health() {
      return true;
    },
    async fingerprint(jpeg) {
      calls.fingerprint++;
      const px = await sharp(jpeg).greyscale().resize(17, 16, { fit: 'fill' }).raw().toBuffer();
      const out = Buffer.alloc(32);
      for (let r = 0; r < 16; r++) {
        for (let c = 0; c < 16; c++) {
          if (px[r * 17 + c + 1] > px[r * 17 + c]) out[(r * 16 + c) >> 3] |= 0x80 >> ((r * 16 + c) & 7);
        }
      }
      return out;
    },
    async faces(jpeg, minFacePx) {
      calls.faces++;
      return (await detect(jpeg)).filter((f) => f.w >= minFacePx);
    },
    async selfie(jpeg) {
      calls.selfie++;
      const found = await detect(jpeg);
      if (!found.length) return null;
      const largest = found.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
      return { vector: largest.vector, faces: found.length };
    },
    // The same shot: a 32 x 32 grey copy, compared by correlation. A burst frame (a slightly moved or brightened
    // copy of a picture) correlates above 0.97; two different test pictures stay far below.
    async scene(jpeg) {
      const px = await sharp(jpeg).greyscale().resize(32, 32, { fit: 'fill' }).raw().toBuffer();
      const sharpness = (await sharp(jpeg).metadata()).width ?? 0;
      return { desc: Buffer.from(px), sharpness };
    },
    async compare(a, b) {
      const n = Math.min(a.length, b.length);
      const mean = (x: Buffer) => x.subarray(0, n).reduce((s, v) => s + v, 0) / n;
      const ma = mean(a);
      const mb = mean(b);
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let i = 0; i < n; i++) {
        sab += (a[i] - ma) * (b[i] - mb);
        saa += (a[i] - ma) ** 2;
        sbb += (b[i] - mb) ** 2;
      }
      const ncc = sab / Math.sqrt(saa * sbb + 1e-9);
      return ncc >= 0.97 ? { inliers: 600, ratio: 0.4, cover: 0.98, ncc } : { inliers: 30, ratio: 0.02, cover: 0.5, ncc };
    },
  };
}
