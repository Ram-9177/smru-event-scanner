import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { localFace } from '../src/face/local.js';

/**
 * The face engine inside the server (YuNet + SFace through onnxruntime, OpenCV in WebAssembly), with the real
 * models and real photos. Skipped when the model files or the sample photos are not there.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const MODELS = process.env.FACE_MODELS_TEST || path.join(ROOT, 'server/models');
const FACE_PHOTO = path.join(ROOT, 'samples/art-fest/IMG_2304.jpg'); // one face, about 100 px wide
const OTHER_PHOTO = path.join(ROOT, 'samples/art-fest/IMG_2301.jpg');
const ready = [
  path.join(MODELS, 'face_detection_yunet_2023mar.onnx'),
  path.join(MODELS, 'face_recognition_sface_2021dec.onnx'),
  FACE_PHOTO,
  OTHER_PHOTO,
].every((f) => fs.existsSync(f));

const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

describe.skipIf(!ready)('local face engine', () => {
  const face = localFace({ modelsDir: MODELS, workers: 2 });
  afterAll(() => face.close());

  it('starts', async () => {
    expect(await face.health()).toBe(true);
    expect(face.model).toBe('sface_2021dec');
  });

  it('finds the face, with a unit vector, and the same person at another size', async () => {
    const jpeg = fs.readFileSync(FACE_PHOTO);
    const found = await face.faces(jpeg, 24);
    expect(found.length).toBeGreaterThanOrEqual(1);
    for (const f of found) {
      expect(f.vector).toBeInstanceOf(Float32Array);
      expect(f.vector.length).toBe(128);
      expect(Math.abs(Math.sqrt(dot(f.vector, f.vector)) - 1)).toBeLessThan(1e-4);
      expect(Number.isInteger(f.x) && Number.isInteger(f.w)).toBe(true);
      expect(f.score).toBeGreaterThanOrEqual(0.6);
    }
    const main = found.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    const meta = await sharp(jpeg).metadata();
    const half = await sharp(jpeg).resize(Math.round(meta.width! * 0.6)).jpeg({ quality: 92 }).toBuffer();
    const again = await face.faces(half, 24);
    const best = Math.max(...again.map((f) => dot(f.vector, main.vector)));
    expect(best).toBeGreaterThan(0.9);
    // a minimum face size above every face: nothing
    expect(await face.faces(jpeg, 5000)).toEqual([]);
  });

  it('reads a selfie, and says so when there is no face', async () => {
    const jpeg = fs.readFileSync(FACE_PHOTO);
    const [main] = await face.faces(jpeg, 24);
    const { x, y, w, h } = main;
    const meta = await sharp(jpeg).metadata();
    const left = Math.max(0, x - w);
    const top = Math.max(0, y - h);
    const crop = await sharp(jpeg)
      .extract({ left, top, width: Math.min(meta.width! - left, w * 3), height: Math.min(meta.height! - top, h * 3) })
      .jpeg()
      .toBuffer();
    const selfie = await face.selfie(crop);
    expect(selfie).not.toBeNull();
    expect(dot(selfie!.vector, main.vector)).toBeGreaterThan(0.9);
    const blank = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#808080' } }).jpeg().toBuffer();
    expect(await face.selfie(blank)).toBeNull();
  });

  it('fingerprints: 32 bytes, the same for a re-saved copy', async () => {
    const jpeg = fs.readFileSync(FACE_PHOTO);
    const a = await face.fingerprint(jpeg);
    const b = await face.fingerprint(await sharp(jpeg).jpeg({ quality: 80 }).toBuffer());
    expect(a.length).toBe(32);
    let bits = 0;
    for (let i = 0; i < 32; i++) for (let v = a[i] ^ b[i]; v; v &= v - 1) bits++;
    expect(bits).toBeLessThan(20);
  });

  it('tells the same shot taken twice from a different photo', async () => {
    const jpeg = fs.readFileSync(FACE_PHOTO);
    const meta = await sharp(jpeg).metadata();
    const W = meta.width!;
    const H = meta.height!;
    // a second frame: the camera moved a little (2 % crop), saved again
    const moved = await sharp(jpeg)
      .extract({ left: Math.round(W * 0.02), top: Math.round(H * 0.01), width: Math.round(W * 0.97), height: Math.round(H * 0.98) })
      .resize(W, H, { fit: 'fill' })
      .jpeg({ quality: 85 })
      .toBuffer();
    const [a, b, c] = await Promise.all([face.scene(jpeg), face.scene(moved), face.scene(fs.readFileSync(OTHER_PHOTO))]);
    expect(a.sharpness).toBeGreaterThan(0);
    expect(a.desc.length).toBeLessThan(200_000);
    const same = await face.compare(a.desc, b.desc);
    expect(same.inliers).toBeGreaterThanOrEqual(150);
    expect(same.cover).toBeGreaterThanOrEqual(0.9);
    expect(same.ncc).toBeGreaterThanOrEqual(0.7);
    const other = await face.compare(a.desc, c.desc);
    expect(other.inliers >= 150 && other.cover >= 0.9 && other.ncc >= 0.7).toBe(false);
  });

  it('rejects a file that is not a picture with BadImageError', async () => {
    const err = await face.faces(Buffer.from('not a picture'), 24).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('BadImageError'); // the routes answer 400 for it
    expect((await face.selfie(Buffer.from('not a picture either')).catch((e: Error) => e) as Error).name).toBe('BadImageError');
    // the engine keeps working after it
    expect((await face.fingerprint(fs.readFileSync(OTHER_PHOTO))).length).toBe(32);
  });

  it('reads pictures too thin for OpenCV, again and again, and keeps working for normal photos', async () => {
    const photo = fs.readFileSync(FACE_PHOTO);
    const before = { hash: await face.fingerprint(photo), faces: await face.faces(photo, 24), scene: await face.scene(photo) };
    const thin = async (w: number, h: number, seed: number) =>
      sharp({ create: { width: w, height: h, channels: 3, background: { r: seed % 256, g: (seed * 7) % 256, b: 90 } } }).png().toBuffer();
    // a 1600 x 1 web copy (from a 4000 x 2 upload) once broke OpenCV's memory for good: ORB asked for a 0 px pyramid level
    for (const [w, h] of [[1600, 1], [1, 1600], [4000, 2], [1, 1], [2, 2], [62, 62], [63, 200]]) {
      const s = await face.scene(await thin(w, h, w + h));
      expect(s.sharpness).toBeGreaterThanOrEqual(0);
      expect(await face.fingerprint(await thin(w, h, 3))).toHaveLength(32);
    }
    await Promise.all(Array.from({ length: 30 }, async (_, i) => face.scene(await thin(1600, 1, i))));
    // the same answers as before, on both workers
    for (let i = 0; i < 2; i++) {
      const [hash, faces, scene] = await Promise.all([face.fingerprint(photo), face.faces(photo, 24), face.scene(photo)]);
      expect(hash.equals(before.hash)).toBe(true);
      expect(faces.map((f) => [f.x, f.y, f.w, f.h, f.score])).toEqual(before.faces.map((f) => [f.x, f.y, f.w, f.h, f.score]));
      expect(scene.desc.equals(before.scene.desc)).toBe(true);
    }
    expect(face.stats().workers).toBe(2);
  });

  it('does not read a huge picture at full size: refused for photo work, shrunk on the way in for a selfie', async () => {
    // about 54 million pixels in a few hundred KB: at full size it would take over 300 MB in each worker
    const huge = await sharp({ create: { width: 9000, height: 6000, channels: 3, background: '#808080' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(huge.length).toBeLessThan(2_000_000);
    const err = await face.fingerprint(huge).catch((e: Error) => e);
    expect((err as Error).name).toBe('BadImageError');
    expect((err as Error).message).toMatch(/too large/);
    expect(await face.selfie(huge)).toBeNull(); // read (shrunk), and no face in it
    // far beyond any camera: not read at all
    const bomb = await sharp({ create: { width: 16000, height: 14000, channels: 3, background: '#000000' } }).png({ compressionLevel: 9 }).toBuffer();
    expect((await face.selfie(bomb).catch((e: Error) => e) as Error).name).toBe('BadImageError');
  });
});

describe('face worker failures', () => {
  it('treats an OpenCV throw (a number) or a WebAssembly fault as damage that needs a new worker', async () => {
    const { isPoison } = await import('../src/face/face-worker.js');
    expect(isPoison(5242880)).toBe(true);
    expect(isPoison(new WebAssembly.RuntimeError('memory access out of bounds'))).toBe(true);
    expect(isPoison(new Error('The photo could not be read'))).toBe(false);
    expect(isPoison(new TypeError('x is not a function'))).toBe(false);
  });
});

describe('local face engine without models', () => {
  it('throws FaceDownError and reports unhealthy', async () => {
    const face = localFace({ modelsDir: path.join(HERE, 'no-such-models'), workers: 1 });
    expect(await face.health()).toBe(false);
    const err = await face.fingerprint(Buffer.from('x')).catch((e: Error) => e);
    expect((err as Error).name).toBe('FaceDownError');
    await face.close();
  });
});
