import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import exifReader from 'exif-reader';
import sharp, { type Metadata, type Sharp } from 'sharp';
import type { Config } from '../config.js';
import { sha256Buffer, sha256File } from '../lib/hashes.js';

/**
 * A photo's look: the gentle fix the app gives a photo that came out dark or flat, the same in the album and in the
 * full-quality download (the original in OneDrive is never changed).
 *   lo, hi  the brightness levels: lo..hi becomes black..white. Measured per colour channel (the darkest channel for
 *           the blacks, the brightest for the whites, leaving out the darkest and brightest 0.5%), so a photo of a
 *           saturated colour or under coloured stage light is never stretched until a colour clips.
 *   gamma   above 1 lifts the mid-tones of a photo that is dark all over and has no bright parts (a stage, lamps or a
 *           night scene has bright parts: it stays as it was taken)
 *   sat     a little more colour for a dull photo that is being fixed anyway
 * The fix moves brightness only: each pixel keeps its own colour (hue and saturation), and no channel is pushed past
 * white. null: the photo is fine as it is, and it is shown and downloaded exactly as it was taken.
 */
export interface Look {
  lo: number;
  hi: number;
  gamma: number;
  sat: number;
}

export interface Prepared {
  /** Upright JPEG, at most workMaxPx on the long side, sRGB. Hashes and faces are taken from this. */
  work: Buffer;
  /** Size of the original once upright. */
  width: number;
  height: number;
  takenAt: Date | null;
  /** SHA-256 of the original file's bytes. */
  sha256: string;
  /** The fix this photo would get (see Look); null when it needs none. */
  look: Look | null;
}

type PrepareConfig = Pick<Config, 'workMaxPx'> & Partial<Pick<Config, 'ffmpegPath'>>;

/** The largest photo the app reads (about 150 megapixels; a 200 MP phone mode is downscaled by the phone's own JPEG). */
export const MAX_PHOTO_PIXELS = 268_402_689;

/** ffmpeg is not there to read an iPhone (HEIC) photo. Nothing is wrong with the photo: it waits, like a video does. */
class PhotoToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoToolsError'; // the same waiting rule as a video without ffmpeg
  }
}

/** The file cannot be read as a photo. Answered as "bad photo" (400), and a synced one is marked failed with this reason. */
class BadPhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadImageError';
  }
}

/** An iPhone photo (HEIC/HEIF, the picture coded as HEVC), which the image library cannot decode. */
export async function isHeic(input: string | Buffer): Promise<boolean> {
  try {
    const meta = await sharp(input, { failOn: 'none' }).metadata();
    return meta.format === 'heif' && meta.compression !== 'av1';
  } catch {
    return false;
  }
}

/** A PNG with an ICC colour profile chunk (iCCP) put in after its header, unless it has one already. */
export function withPngIcc(png: Buffer, icc: Buffer): Buffer {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) return png;
  for (let at = 8; at + 12 <= png.length; ) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'iCCP' || type === 'sRGB') return png; // it says its own colours already
    if (type === 'IDAT' || type === 'IEND') break;
    at += 12 + len;
  }
  const body = Buffer.concat([Buffer.from('iCCP', 'latin1'), Buffer.from('icc\0\0', 'latin1'), zlib.deflateSync(icc)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([png.subarray(0, 33), len, body, crc, png.subarray(33)]); // 8 signature + 25 IHDR
}

/** A JPEG with an ICC colour profile (APP2 ICC_PROFILE segments) put in after its EXIF data. */
export function withJpegIcc(jpeg: Buffer, icc: Buffer): Buffer {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  // Right after SOI and the APP0/APP1 segments (JFIF, EXIF): where cameras put it.
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff && (jpeg[at + 1] === 0xe0 || jpeg[at + 1] === 0xe1)) at += 2 + jpeg.readUInt16BE(at + 2);
  const CHUNK = 65_519; // 65535 - 2 (length) - 14 ("ICC_PROFILE\0" + number + count)
  const count = Math.ceil(icc.length / CHUNK);
  if (!count || count > 255) return jpeg;
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const piece = icc.subarray(i * CHUNK, (i + 1) * CHUNK);
    const head = Buffer.alloc(18);
    head.writeUInt16BE(0xffe2, 0);
    head.writeUInt16BE(piece.length + 16, 2);
    head.write('ICC_PROFILE\0', 4, 'latin1');
    head[16] = i + 1;
    head[17] = count;
    parts.push(head, piece);
  }
  return Buffer.concat([jpeg.subarray(0, at), ...parts, jpeg.subarray(at)]);
}

/**
 * The picture of an iPhone photo as a PNG (stored without compression: it is read once, straight away), at its full
 * size and upright, in its own colours: ffmpeg puts the tiles of its grid together and applies its rotation, and the
 * photo's colour profile (Display P3 on an iPhone) is carried over, since ffmpeg drops it for a tiled photo.
 * ffmpeg needs to move around in a tiled HEIC, so a photo held in memory (an upload) is written to a temp file first.
 */
export async function decodeHeic(input: string | Buffer, ffmpegPath = 'ffmpeg'): Promise<Buffer> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { failOn: 'none' }).metadata();
  } catch {
    throw new BadPhotoError('Cannot read this file as a photo (it is not a HEIC photo that can be read).');
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new BadPhotoError('Cannot read this file as a photo (the HEIC photo has no size).');
  if (w * h > MAX_PHOTO_PIXELS) throw new BadPhotoError('Cannot read this file as a photo: it is larger than the app takes in.');
  let file = typeof input === 'string' ? input : null;
  let dir: string | null = null;
  try {
    if (!file) {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'event-photos-heic-'));
      file = path.join(dir, `${randomUUID()}.heic`);
      await fs.promises.writeFile(file, input as Buffer, { mode: 0o600 });
    }
    // A transparent HEIC (a sticker, a cut-out) keeps its transparency, as a PNG does: the rest of the app puts it on white.
    // Its alpha is a second picture (a second tile grid for a large one); without one, the colour picture alone.
    const tries: string[][] = meta.hasAlpha
      ? [
          ['-filter_complex', '[0:g:0][0:g:1]alphamerge,format=rgba'],
          ['-filter_complex', '[0:v:0][0:v:1]alphamerge,format=rgba'],
          ['-pix_fmt', 'rgb24'],
        ]
      : [['-pix_fmt', 'rgb24']];
    let png: Buffer | null = null;
    let last: unknown = null;
    for (const pick of tries) {
      try {
        png = await ffmpegPng(ffmpegPath, file, pick, w * h * (pick.includes('rgb24') ? 3 : 4) + h * 8 + (2 << 20) + Math.ceil((w * h * 4) / 16_000) * 8);
        break;
      } catch (e) {
        if ((e as Error)?.name !== 'BadImageError') throw e; // ffmpeg is not there: no other way will work
        last = e;
      }
    }
    if (!png) throw last;
    // Its colours: the ICC profile it carries (an iPhone's), or, when it only names them (an 'nclx' colour box),
    // Display P3 when that is what it names. Anything else is taken as sRGB.
    const icc = meta.icc ?? (nclxPrimaries(typeof input === 'string' ? await fs.promises.readFile(input) : input) === 12 ? await p3Icc() : null);
    return icc ? withPngIcc(png, icc) : png;
  } finally {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/** The colour primaries a HEIC names in its first 'nclx' colour box (12 = Display P3), or null. */
export function nclxPrimaries(buf: Buffer): number | null {
  const at = buf.indexOf('colrnclx', 0, 'latin1');
  return at >= 0 && at + 10 <= buf.length ? buf.readUInt16BE(at + 8) : null;
}

let p3: Promise<Buffer | null> | null = null;
/** The Display P3 profile sharp itself attaches. */
const p3Icc = () =>
  (p3 ??= sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
    .withIccProfile('p3')
    .png()
    .toBuffer()
    .then(async (b) => (await sharp(b).metadata()).icc ?? null));

function ffmpegPng(ffmpegPath: string, file: string, pick: string[], maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, ...pick, '-frames:v', '1', '-c:v', 'png', '-compression_level', '0', '-f', 'image2pipe', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, killSignal: 'SIGKILL' },
    );
    const out: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        tooBig = true;
        child.kill('SIGKILL');
      } else out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 4000) err += c.toString();
    });
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' ? new PhotoToolsError(`${ffmpegPath} was not found: it is needed to read iPhone (HEIC) photos. Install ffmpeg, or set FFMPEG_PATH.`) : e),
    );
    child.on('close', (code) => {
      const png = Buffer.concat(out);
      if (!tooBig && code === 0 && png.length) return resolve(png);
      const why = tooBig ? 'larger than its size says' : (err.trim().split('\n').at(-1)?.slice(0, 160) ?? 'no picture');
      reject(new BadPhotoError(`Cannot read this file as a photo (iPhone HEIC: ${why}).`));
    });
  });
}

/** The photo's EXIF data, read as fields (null when it has none or it cannot be read). */
async function exifOf(input: string | Buffer): Promise<any | null> {
  try {
    const meta = await sharp(input, { failOn: 'none' }).metadata();
    return meta.exif ? exifReader(meta.exif) : null;
  } catch {
    return null;
  }
}

const takenAtOf = (exif: any): Date | null => {
  const d = exif?.Photo?.DateTimeOriginal ?? exif?.exif?.DateTimeOriginal ?? exif?.Image?.DateTime ?? exif?.image?.ModifyDate;
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
};

/** Fix rotation, make the working copy, read what the file says about itself, and measure what fix it would need. */
export async function prepare(input: string | Buffer, cfg: PrepareConfig): Promise<Prepared> {
  const sha256 = typeof input === 'string' ? await sha256File(input) : sha256Buffer(input);
  // An iPhone photo is read through ffmpeg (already upright); everything else straight from the file.
  const source: string | Buffer = (await isHeic(input)) ? await decodeHeic(input, cfg.ffmpegPath) : input;
  const meta = await sharp(source, { failOn: 'none' }).metadata();
  if (!meta.width || !meta.height) throw new Error('Cannot read this file as a photo');
  const sideways = (meta.orientation ?? 1) >= 5;
  const takenAt = takenAtOf(await exifOf(input));
  // sRGB (sharp converts from the photo's own profile, e.g. an iPhone's Display P3): what the album and faces use.
  const work = await sharp(source, { failOn: 'none' })
    .rotate() // upright, from the camera's rotation tag
    .resize({ width: cfg.workMaxPx, height: cfg.workMaxPx, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { work, width: sideways ? meta.height : meta.width, height: sideways ? meta.width : meta.height, takenAt, sha256, look: await measureLook(work) };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Measure a photo and decide its fix (see Look). Careful on purpose: a photo with real blacks and whites is left
 * alone, a dark photo with bright parts (a stage, lamps, a night sky) is left alone, and no change is ever strong.
 */
export async function measureLook(work: Buffer): Promise<Look | null> {
  const { data, info } = await sharp(work, { failOn: 'none' }).resize(256, 256, { fit: 'inside' }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  if (!n) return null;
  const luma = new Float64Array(256);
  const darkest = new Float64Array(256); // per pixel: its darkest channel
  const brightest = new Float64Array(256); // per pixel: its brightest channel
  let sum = 0;
  let satSum = 0;
  let satN = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    const y = Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b));
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    luma[y]++;
    darkest[min]++;
    brightest[max]++;
    sum += y;
    if (max > 24) {
      satSum += (max - min) / max;
      satN++;
    }
  }
  const at = (hist: Float64Array, p: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= p * n) return v / 255;
    }
    return 1;
  };
  const black = at(darkest, 0.005);
  const white = at(brightest, 0.995);
  const p90 = at(luma, 0.9);
  const mean = sum / n / 255;

  // Levels, only for a photo that clearly needs them (most good photos are left byte for byte as they are):
  //   lifted blacks (haze, fog, a washed-out phone photo): the black point moves down part of the way, at most 0.1
  //   no real whites (under-exposed, dull): the brightest part becomes nearly white, at most 1.6 times as bright
  let lo = 0;
  let hi = 1;
  const liftedBlacks = black > 0.08;
  const noWhites = white < 0.88;
  if ((liftedBlacks || noWhites) && white - black > 0.05) {
    lo = liftedBlacks ? Math.min(0.1, (black - 0.03) * 0.6) : 0;
    hi = noWhites ? Math.min(1, Math.max(white + 0.02, lo + 1 / 1.6)) : 1;
    if (1 / (hi - lo) < 1.12 && lo < 0.04) {
      lo = 0; // less than a 12% change: not worth touching the original
      hi = 1;
    }
  }
  // Mid-tones: lifted only when the photo is dark all over and nothing in it is bright (90% of it below 62%
  // brightness after the levels, and no colour channel near white).
  const stretch = (v: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  const mean2 = stretch(mean);
  let gamma = 1;
  if (noWhites && mean2 > 0.02 && mean2 < 0.3 && stretch(p90) < 0.62) {
    gamma = Math.min(1.35, Math.log(mean2) / Math.log(0.4));
    if (gamma < 1.04) gamma = 1;
  }
  // Colour: a little more for a dull photo that is being fixed anyway (never a fix on its own, never for black and white).
  const avgSat = satN ? satSum / satN : 0;
  const fixed = lo !== 0 || hi !== 1 || gamma !== 1;
  const sat = fixed && avgSat > 0.04 && avgSat < 0.18 ? 1.06 : 1;
  if (!fixed) return null;
  return { lo: r3(lo), hi: r3(hi), gamma: r3(gamma), sat };
}

/** The new brightness for each brightness 0..255 (in steps of 1/4, so smooth gradients stay smooth): levels, then mid-tones. */
function curveOf(look: Look): Float32Array {
  const steps = 256 * 4;
  const curve = new Float32Array(steps + 2);
  for (let i = 0; i <= steps + 1; i++) {
    let x = Math.min(1, Math.max(0, (i / 4 / 255 - look.lo) / (look.hi - look.lo)));
    if (look.gamma !== 1) x = Math.pow(x, 1 / look.gamma);
    curve[i] = x * 255;
  }
  return curve;
}

/** Pixels done between two looks at the event loop, so a full-size photo never holds up the server's other requests. */
const PIXELS_PER_TURN = 1 << 20;

/**
 * Apply a look to raw 8-bit RGB pixels, in place. Only brightness moves: each pixel is made lighter or darker as a
 * whole (its three channels by the same factor), so its colour stays its own, and never past white in any channel.
 */
export async function applyLook(raw: Buffer, channels: number, look: Look): Promise<void> {
  const curve = curveOf(look);
  const n = Math.floor(raw.length / channels);
  for (let start = 0; start < n; start += PIXELS_PER_TURN) {
    const end = Math.min(n, start + PIXELS_PER_TURN);
    for (let p = start; p < end; p++) {
      const i = p * channels;
      const r = raw[i];
      const g = raw[i + 1];
      const b = raw[i + 2];
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const q = y * 4;
      const k0 = q | 0;
      const ny = curve[k0] + (curve[k0 + 1] - curve[k0]) * (q - k0);
      if (y < 0.5) {
        const v = Math.round(ny);
        raw[i] = raw[i + 1] = raw[i + 2] = v;
        continue;
      }
      let k = ny / y;
      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      if (max * k > 255) k = 255 / max;
      raw[i] = Math.round(r * k);
      raw[i + 1] = Math.round(g * k);
      raw[i + 2] = Math.round(b * k);
    }
    if (end < n) await new Promise<void>((r) => setImmediate(r));
  }
}

/** A raw RGB buffer with the look applied, as a pipeline that carries on from it (with the colour step when there is one). */
async function withLook(raw: Buffer, info: { width: number; height: number; channels: number }, look: Look): Promise<Sharp> {
  await applyLook(raw, info.channels, look);
  const s = sharp(raw, { raw: { width: info.width, height: info.height, channels: info.channels as 3 }, limitInputPixels: MAX_PHOTO_PIXELS });
  return look.sat !== 1 ? s.modulate({ saturation: look.sat }) : s;
}

/**
 * A display copy for the album (thumbnail or web size): WebP, sRGB, with the photo's fix applied and a light
 * sharpening of edges only (flat skin, sky and noise are left as they are) that a smaller copy needs to look as crisp.
 */
export async function displayCopy(work: Buffer, maxPx: number, quality: number, look: Look | null = null): Promise<Buffer> {
  const sized = sharp(work, { failOn: 'none' }).resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true });
  let out: Sharp;
  if (look) {
    const { data, info } = await sized.removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    out = await withLook(data, info, look);
  } else out = sized;
  return out.sharpen({ sigma: maxPx <= 600 ? 0.5 : 0.7, m1: 0, m2: 2 }).webp({ quality, effort: 4 }).toBuffer();
}

/** The copy that bursts are compared on: the same as the web copy the app made before WebP, never with a fix applied. */
export async function sceneCopy(work: Buffer): Promise<Buffer> {
  return sharp(work).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

/** EXIF text fields worth keeping on a full-quality copy: the camera, the lens and the date. Never the GPS position. */
function keptExif(exif: any): Record<string, Record<string, string>> | null {
  if (!exif) return null;
  const image = exif.Image ?? exif.image ?? {};
  const photo = exif.Photo ?? exif.exif ?? {};
  const date = (d: unknown) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().replace('T', ' ').replace(/-/g, ':').slice(0, 19) : null);
  const ifd0: Record<string, string> = {};
  const ifd2: Record<string, string> = {};
  for (const k of ['Make', 'Model', 'Software', 'Artist', 'Copyright'] as const) if (typeof image[k] === 'string' && image[k]) ifd0[k] = image[k].slice(0, 200);
  const when = date(image.DateTime);
  if (when) ifd0.DateTime = when;
  const taken = date(photo.DateTimeOriginal);
  if (taken) ifd2.DateTimeOriginal = taken;
  const digitized = date(photo.DateTimeDigitized);
  if (digitized) ifd2.DateTimeDigitized = digitized;
  if (typeof photo.LensModel === 'string' && photo.LensModel) ifd2.LensModel = photo.LensModel.slice(0, 200);
  const out: Record<string, Record<string, string>> = {};
  if (Object.keys(ifd0).length) out.IFD0 = ifd0;
  if (Object.keys(ifd2).length) out.IFD2 = ifd2;
  return Object.keys(out).length ? out : null;
}

/**
 * The full-quality download of a photo that is not handed over as it is: one with a fix (its look), an iPhone photo
 * (HEIC, which many phones and computers cannot open), or one whose metadata cannot be cleaned of where it was taken.
 * Full size, upright, JPEG at quality 93 (full colour detail when the original had it), in the original's own colours
 * (its colour profile, e.g. an iPhone's Display P3, is kept: nothing is cut down to sRGB). The camera, lens and date
 * are kept; nothing else of the metadata, so never a GPS position or a place name.
 */
export async function fullQuality(file: string, look: Look | null, ffmpegPath = 'ffmpeg'): Promise<Buffer> {
  const exif = keptExif(await exifOf(file));
  const source: string | Buffer = (await isHeic(file)) ? await decodeHeic(file, ffmpegPath) : file;
  const meta = await sharp(source, { failOn: 'none', limitInputPixels: MAX_PHOTO_PIXELS }).metadata();
  // Full colour detail (4:4:4) only when the original had it (a PNG, or a JPEG saved that way); a phone's JPEG or HEIC is 4:2:0.
  const full = source === file && (meta.format === 'png' || meta.chromaSubsampling === '4:4:4');
  const jpeg = { quality: 93, chromaSubsampling: full ? '4:4:4' : '4:2:0', optimiseCoding: false } as const;
  // An RGB photo keeps its own profile (and its values with it); grey, CMYK and anything else becomes sRGB.
  const ownColours = meta.icc && meta.icc.length >= 20 && meta.icc.toString('latin1', 16, 20) === 'RGB ' ? meta.icc : null;
  let s = sharp(source, { failOn: 'none', limitInputPixels: MAX_PHOTO_PIXELS }).rotate().flatten({ background: '#ffffff' });
  s = ownColours ? s.keepIccProfile() : s.toColourspace('srgb');
  // Through raw pixels, with or without the fix: nothing of the original's metadata comes along (not even its EXIF
  // preview picture, which would stay sideways after the photo was turned upright); only what keptExif keeps.
  const { data, info } = await s.removeAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  let fixed = look
    ? await withLook(data, info, look)
    : sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels as 3 }, limitInputPixels: MAX_PHOTO_PIXELS });
  if (exif) fixed = fixed.withExif(exif);
  if (!ownColours) return fixed.withIccProfile('srgb').jpeg(jpeg).toBuffer();
  return withJpegIcc(await fixed.jpeg(jpeg).toBuffer(), ownColours);
}
