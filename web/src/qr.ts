/**
 * A small QR code maker (from the darkroom design), so the ticket always shows this app's own address without a
 * library or a call to the server. Byte mode, error correction level M, versions 1 to 6 (up to 106 bytes).
 */

/** Per version: total codewords, error-correction codewords per block, blocks. */
const SPEC: ReadonlyArray<readonly [number, number, number] | null> = [null, [26, 10, 1], [44, 16, 1], [70, 26, 1], [100, 18, 2], [134, 24, 2], [172, 16, 4]];

const MASKS: ReadonlyArray<(a: number, b: number) => boolean> = [
  (a, b) => (a + b) % 2 === 0,
  (_a, b) => b % 2 === 0,
  (a) => a % 3 === 0,
  (a, b) => (a + b) % 3 === 0,
  (a, b) => (Math.floor(a / 3) + Math.floor(b / 2)) % 2 === 0,
  (a, b) => ((a * b) % 2) + ((a * b) % 3) === 0,
  (a, b) => (((a * b) % 2) + ((a * b) % 3)) % 2 === 0,
  (a, b) => (((a + b) % 2) + ((a * b) % 3)) % 2 === 0,
];

/** Galois field GF(256) tables for the Reed-Solomon error correction. */
const EXP: number[] = [];
const LOG: number[] = [];
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d;
  }
}
const mul = (a: number, b: number) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);

/** The modules of the QR code for `text` (1 = dark), or null when the text is too long for version 6. */
export function qrMatrix(text: string, forceMask = -1): number[][] | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 0;
  let dataLen = 0;
  for (let i = 1; i <= 6 && !ver; i++) {
    const s = SPEC[i]!;
    dataLen = s[0] - s[1] * s[2];
    if (bytes.length + 2 <= dataLen) ver = i;
  }
  if (!ver) return null;
  const [, ecLen, blocks] = SPEC[ver]!;
  const n = 17 + 4 * ver;

  // the message as bits: mode, length, the bytes, a terminator, then padding
  const bits: number[] = [];
  const put = (val: number, len: number) => {
    for (let b = len - 1; b >= 0; b--) bits.push((val >>> b) & 1);
  };
  put(4, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  for (let i = 0; i < 4 && bits.length < dataLen * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let k = 0;
    for (let j = 0; j < 8; j++) k = (k << 1) | bits[i + j];
    data.push(k);
  }
  for (let i = 0; data.length < dataLen; i++) data.push(i % 2 ? 0x11 : 0xec);

  // Reed-Solomon
  const gen: number[] = new Array(ecLen).fill(0);
  gen[ecLen - 1] = 1;
  let root = 1;
  for (let i = 0; i < ecLen; i++) {
    for (let j = 0; j < ecLen; j++) {
      gen[j] = mul(gen[j], root);
      if (j + 1 < ecLen) gen[j] ^= gen[j + 1];
    }
    root = mul(root, 2);
  }
  const ecc = (block: number[]) => {
    const rem: number[] = new Array(ecLen).fill(0);
    for (const v of block) {
      const f = v ^ (rem.shift() as number);
      rem.push(0);
      for (let t = 0; t < ecLen; t++) rem[t] ^= mul(gen[t], f);
    }
    return rem;
  };
  const per = dataLen / blocks;
  const dBlocks: number[][] = [];
  const eBlocks: number[][] = [];
  for (let i = 0; i < blocks; i++) {
    dBlocks.push(data.slice(i * per, (i + 1) * per));
    eBlocks.push(ecc(dBlocks[i]));
  }
  const all: number[] = [];
  for (let i = 0; i < per; i++) for (let j = 0; j < blocks; j++) all.push(dBlocks[j][i]);
  for (let i = 0; i < ecLen; i++) for (let j = 0; j < blocks; j++) all.push(eBlocks[j][i]);

  // the grid: m holds the modules, fn marks the ones that are not data
  const m: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const fn: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const set = (px: number, py: number, dark: boolean | number) => {
    m[py][px] = dark ? 1 : 0;
    fn[py][px] = 1;
  };
  for (let i = 0; i < n; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const xx = cx + dx;
        const yy = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (xx >= 0 && xx < n && yy >= 0 && yy < n) set(xx, yy, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(n - 4, 3);
  finder(3, n - 4);
  if (ver > 1) for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(n - 7 + j, n - 7 + i, Math.max(Math.abs(i), Math.abs(j)) !== 1);
  for (let i = 0; i < 9; i++) {
    if (!fn[8][i]) set(i, 8, 0);
    if (!fn[i][8]) set(8, i, 0);
  }
  for (let i = 0; i < 8; i++) {
    set(n - 1 - i, 8, 0);
    set(8, n - 1 - i, 0);
  }
  set(8, n - 8, 1);
  let at = 0;
  const total = all.length * 8;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++)
      for (let j = 0; j < 2; j++) {
        const px = right - j;
        const py = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
        if (!fn[py][px] && at < total) {
          m[py][px] = (all[at >>> 3] >>> (7 - (at & 7))) & 1;
          at++;
        }
      }
  }

  const build = (mask: number) => {
    const g = m.map((row) => row.slice());
    for (let yy = 0; yy < n; yy++) for (let xx = 0; xx < n; xx++) if (!fn[yy][xx] && MASKS[mask](xx, yy)) g[yy][xx] ^= 1;
    let rem = mask;
    for (let b = 0; b < 10; b++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537); // level M is 00, so the data bits are just the mask
    const fmt = ((mask << 10) | rem) ^ 0x5412;
    const bit = (q: number) => (fmt >>> q) & 1;
    for (let b = 0; b <= 5; b++) g[b][8] = bit(b);
    g[7][8] = bit(6);
    g[8][8] = bit(7);
    g[8][7] = bit(8);
    for (let b = 9; b < 15; b++) g[8][14 - b] = bit(b);
    for (let b = 0; b < 8; b++) g[8][n - 1 - b] = bit(b);
    for (let b = 8; b < 15; b++) g[n - 15 + b][8] = bit(b);
    g[n - 8][8] = 1;
    return g;
  };
  const penalty = (g: number[][]) => {
    let s = 0;
    const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let yy = 0; yy < n; yy++)
      for (let run = 1, xx = 1; xx < n; xx++) {
        if (g[yy][xx] === g[yy][xx - 1]) {
          run++;
          if (run === 5) s += 3;
          else if (run > 5) s++;
        } else run = 1;
      }
    for (let xx = 0; xx < n; xx++)
      for (let run = 1, yy = 1; yy < n; yy++) {
        if (g[yy][xx] === g[yy - 1][xx]) {
          run++;
          if (run === 5) s += 3;
          else if (run > 5) s++;
        } else run = 1;
      }
    for (let yy = 0; yy < n - 1; yy++)
      for (let xx = 0; xx < n - 1; xx++) {
        const c = g[yy][xx];
        if (c === g[yy][xx + 1] && c === g[yy + 1][xx] && c === g[yy + 1][xx + 1]) s += 3;
      }
    for (let yy = 0; yy < n; yy++)
      for (let xx = 0; xx <= n - 11; xx++) {
        let a1 = 1;
        let a2 = 1;
        let b1 = 1;
        let b2 = 1;
        for (let q = 0; q < 11; q++) {
          if (g[yy][xx + q] !== P1[q]) a1 = 0;
          if (g[yy][xx + q] !== P2[q]) a2 = 0;
          if (g[xx + q][yy] !== P1[q]) b1 = 0;
          if (g[xx + q][yy] !== P2[q]) b2 = 0;
        }
        s += 40 * (a1 + a2 + b1 + b2);
      }
    let dark = 0;
    for (let yy = 0; yy < n; yy++) for (let xx = 0; xx < n; xx++) dark += g[yy][xx];
    return s + 10 * Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n));
  };
  if (forceMask >= 0 && forceMask < 8) return build(forceMask);
  let best: number[][] | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < 8; i++) {
    const grid = build(i);
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
    }
  }
  return best;
}

/** The QR as one SVG path (with a quiet zone of 2 modules): `size` is the viewBox's side, `d` the dark modules. */
export function qrPath(text: string): { size: number; d: string } | null {
  const g = qrMatrix(text);
  if (!g) return null;
  const n = g.length;
  let d = '';
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (!g[y][x]) continue;
      let run = 1;
      while (x + run < n && g[y][x + run]) run++;
      d += `M${x + 2} ${y + 2}h${run}v1h-${run}z`;
      x += run - 1;
    }
  return { size: n + 4, d };
}
