import sharp from 'sharp';

/** People in the test pictures are colours. PERSON.red in two photos = the same person. */
export const PERSON = { red: 0, yellow: 2, green: 4, cyan: 6, blue: 8, magenta: 10 } as const;

export interface TestFace {
  person: number;
  /** A dim block: scores in the "maybe" tier against a bright selfie. */
  dim?: boolean;
  size?: number;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgb(person: number, dim: boolean): { r: number; g: number; b: number } {
  const h = person * 30;
  const v = dim ? 0.55 : 1;
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return { r: f(5), g: f(3), b: f(1) };
}

/**
 * A synthetic "event photo": a grey block pattern that is different for every seed
 * (so every picture has its own look-alike hash), with one coloured block per person in it.
 */
export async function makePhoto(seed: number, faces: TestFace[] = [], opts: { w?: number; h?: number; format?: 'jpeg' | 'png' | 'webp'; quality?: number } = {}): Promise<Buffer> {
  const w = opts.w ?? 800;
  const h = opts.h ?? 600;
  const rand = rng(seed + 1);
  const gw = 8;
  const gh = 6;
  const grid = Buffer.alloc(gw * gh * 3);
  for (let i = 0; i < gw * gh; i++) {
    const g = 40 + Math.floor(rand() * 180);
    grid[i * 3] = grid[i * 3 + 1] = grid[i * 3 + 2] = g;
  }
  const base = sharp(grid, { raw: { width: gw, height: gh, channels: 3 } }).resize(w, h, { kernel: 'nearest' });
  const overlays = faces.map((f, i) => {
    const size = f.size ?? Math.round(w / 9);
    return {
      input: { create: { width: size, height: size, channels: 3 as const, background: rgb(f.person, !!f.dim) } },
      left: Math.round(((i + 0.5) * w) / Math.max(faces.length, 1) - size / 2),
      top: Math.round(h / 2 - size / 2),
    };
  });
  const img = base.composite(overlays);
  if (opts.format === 'png') return img.png().toBuffer();
  if (opts.format === 'webp') return img.webp({ quality: opts.quality ?? 90 }).toBuffer();
  return img.jpeg({ quality: opts.quality ?? 92, chromaSubsampling: '4:4:4' }).toBuffer();
}

/** What a chat app does to a photo: smaller and compressed harder. */
export async function chatCopy(photo: Buffer, width = 480, quality = 60): Promise<Buffer> {
  return sharp(photo).resize({ width }).jpeg({ quality }).toBuffer();
}

/** A selfie of one person. */
export const makeSelfie = (person: number) => makePhoto(9000 + person, [{ person, size: 300 }], { w: 640, h: 480 });
