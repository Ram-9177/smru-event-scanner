import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HDR video to the normal (SDR, BT.709) picture every browser shows. iPhones from the 12 on film in HDR by default
 * (HLG, BT.2020 colours, 10 bit); some Android phones and cameras use PQ. Shown as it is, such a video looks washed
 * out (grey whites, pale colours) in the album, on its poster and to the face engine.
 *
 * The ffmpeg on a Mac from Homebrew has no zscale or libplacebo, so the conversion is a 3D lookup table (lut3d, which
 * every ffmpeg has), made here once from the standard formulas:
 *   1. HLG: the inverse OETF gives scene light, the OOTF (system gamma 1.2 for a 1000-nit display) display light.
 *      PQ: the EOTF gives display light directly.
 *   2. BT.2020 colours to BT.709 colours (in linear light).
 *   3. The tone curve, the same factor for a pixel's three channels (each pixel keeps its colour), keyed on its
 *      brightest channel: HDR reference white (203 nits, BT.2408)
 *      becomes nearly SDR white, and everything brighter, up to the source's peak (1000 nits: HLG's nominal display,
 *      and the usual PQ mastering peak), rolls off smoothly into the top, each level keeping its own value; a
 *      bright coloured light stays its colour instead of clipping to another hue or to white.
 *   4. Display light to the signal a screen expects: the inverse sRGB curve for a still frame (the poster and the
 *      face engine read it as sRGB), the inverse BT.1886 (gamma 2.4) for the preview video (BT.2408's SDR path).
 *      Not the BT.709 camera curve: that is for scene light, and on display light it darkens mid-tones by ~0.8 stop.
 */

export type Hdr = 'hlg' | 'pq';

/** The HDR kind of a video stream from ffprobe's colour transfer, or null for a normal video. */
export const hdrOf = (colorTransfer: unknown): Hdr | null => (colorTransfer === 'arib-std-b67' ? 'hlg' : colorTransfer === 'smpte2084' ? 'pq' : null);

const SIZE = 33;
const VERSION = 'v4';
/** HDR reference white, in nits (BT.2408). */
const REF_WHITE = 203;

function hlgToNits(r: number, g: number, b: number): [number, number, number] {
  const a = 0.17883277;
  const bb = 1 - 4 * a;
  const c = 0.5 - a * Math.log(4 * a);
  const inv = (e: number) => (e <= 0.5 ? (e * e) / 3 : (Math.exp((e - c) / a) + bb) / 12);
  const R = inv(r);
  const G = inv(g);
  const B = inv(b);
  const ys = 0.2627 * R + 0.678 * G + 0.0593 * B;
  const k = 1000 * Math.pow(Math.max(ys, 1e-6), 1.2 - 1);
  return [R * k, G * k, B * k];
}

function pqToNits(r: number, g: number, b: number): [number, number, number] {
  const m1 = 2610 / 16384;
  const m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096;
  const c2 = (2413 / 4096) * 32;
  const c3 = (2392 / 4096) * 32;
  const eotf = (e: number) => {
    const p = Math.pow(Math.max(e, 0), 1 / m2);
    return 10000 * Math.pow(Math.max(p - c1, 0) / (c2 - c3 * p), 1 / m1);
  };
  return [eotf(r), eotf(g), eotf(b)];
}

/** The brightest the source holds, relative to reference white (1000 nits / 203). */
const PEAK = 1000 / REF_WHITE;
const KNEE = 0.75;

/**
 * Display light (relative to reference white) to SDR light 0..1: as it is up to the knee, then a smooth curve that
 * starts with the same slope and reaches exactly 1 at the source's peak (rational, so every level keeps its own value).
 */
export function tone(x: number): number {
  if (x <= KNEE) return Math.max(0, x);
  if (x >= PEAK) return 1;
  const t = (x - KNEE) / (PEAK - KNEE);
  const slope = (PEAK - KNEE) / (1 - KNEE); // f'(0) in t, so the curve meets the straight part without a bend
  return KNEE + (1 - KNEE) * ((slope * t) / (1 + (slope - 1) * t));
}

/** What the SDR picture is for: a still frame read as sRGB, or the preview video (BT.709 / BT.1886). */
export type Target = 'srgb' | 'bt1886';
const encode = (target: Target, l: number) => (target === 'srgb' ? (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055) : Math.pow(l, 1 / 2.4));

/** One HDR signal value (R'G'B', 0..1, BT.2020) to its SDR BT.709 value (R'G'B', 0..1). */
export function hdrToSdr(kind: Hdr, r: number, g: number, b: number, target: Target = 'srgb'): [number, number, number] {
  const [R, G, B] = (kind === 'hlg' ? hlgToNits : pqToNits)(r, g, b).map((v) => v / REF_WHITE) as [number, number, number];
  // BT.2020 to BT.709 primaries (linear light)
  let r7 = 1.6605 * R - 0.5876 * G - 0.0728 * B;
  let g7 = -0.1246 * R + 1.1329 * G - 0.0083 * B;
  let b7 = -0.0182 * R - 0.1006 * G + 1.1187 * B;
  // Out of BT.709's colours below zero: cut. Then the curve, keyed on each pixel's brightest channel and applied
  // to all three alike: hue and saturation stay, no channel passes white, and a bright coloured light stays coloured
  // (keyed on luminance, a red stage light would be pushed past white in red and turn pink).
  r7 = Math.max(0, r7);
  g7 = Math.max(0, g7);
  b7 = Math.max(0, b7);
  const max = Math.max(r7, g7, b7);
  if (max > 1e-9) {
    const k = tone(max) / max;
    r7 *= k;
    g7 *= k;
    b7 *= k;
  } else r7 = g7 = b7 = 0;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [encode(target, clamp(r7)), encode(target, clamp(g7)), encode(target, clamp(b7))];
}

/** The .cube file for one HDR kind, made once (in the system's temp folder: a path without spaces or quotes). */
export function hdrLutFile(kind: Hdr, target: Target): string {
  const dir = path.join(os.tmpdir(), 'event-photos-luts');
  const file = path.join(dir, `${kind}-to-${target}-${VERSION}-${SIZE}.cube`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const lines = [`TITLE "${kind} to SDR BT.709"`, `LUT_3D_SIZE ${SIZE}`];
  // .cube order: red changes fastest, then green, then blue.
  for (let bi = 0; bi < SIZE; bi++) {
    for (let gi = 0; gi < SIZE; gi++) {
      for (let ri = 0; ri < SIZE; ri++) {
        const [r, g, b] = hdrToSdr(kind, ri / (SIZE - 1), gi / (SIZE - 1), bi / (SIZE - 1), target);
        lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
      }
    }
  }
  const part = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`;
  fs.writeFileSync(part, lines.join('\n') + '\n');
  fs.renameSync(part, file);
  return file;
}

/**
 * The ffmpeg filters that turn an HDR picture, already scaled, into SDR: RGB from BT.2020 YCbCr, the table, then
 * `out` (a pixel format: rgb24 for a frame, or yuv420p in BT.709 for the preview).
 */
export function hdrFilters(kind: Hdr, out: 'rgb24' | 'yuv420p'): string {
  const lut = hdrLutFile(kind, out === 'rgb24' ? 'srgb' : 'bt1886');
  if (/[\\':,;\[\]\s]/.test(lut)) throw new Error(`the temp folder's path cannot be given to ffmpeg: ${lut}`);
  const toRgb = 'scale=in_color_matrix=bt2020:in_range=auto,format=gbrp16le';
  const table = `lut3d=file='${lut}':interp=tetrahedral`;
  // The preview says what it is now (ffmpeg takes the colour tags from the frames, not from output options).
  const toOut = out === 'rgb24' ? 'format=rgb24' : 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
  return `${toRgb},${table},${toOut}`;
}
