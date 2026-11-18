/**
 * The face engine's work, done in a worker thread so the server's event loop never waits for it.
 *
 * This is a port of face-service/app.py (the Python service it replaces), step for step:
 *   detector   : YuNet  (face_detection_yunet_2023mar.onnx) run by onnxruntime, with OpenCV's FaceDetectorYN
 *                pre- and post-processing (pad to 32, BGR blob, decode, NMS) written out below
 *   recogniser : SFace  (face_recognition_sface_2021dec.onnx) run by onnxruntime, with OpenCV's
 *                FaceRecognizerSF.alignCrop (Umeyama similarity transform + warpAffine to 112 x 112)
 *   images     : OpenCV (WebAssembly build) for resizing, ORB keypoints, matching, homographies and warps,
 *                so those come out as they did in Python
 * OpenCV's own dnn module is not used for the two networks: in WebAssembly it is about ten times slower.
 *
 * This file only imports Node's own modules and packages (never another file of the project), so it also runs
 * as plain TypeScript in Node (type stripping) where no TypeScript loader is around (vitest's workers).
 * Keep it to erasable TypeScript: no enums, namespaces or constructor parameter properties.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';
import ort from 'onnxruntime-node';
import sharp from 'sharp';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Cv = any;
type Mat = any;

export const DETECTOR_FILE = 'face_detection_yunet_2023mar.onnx';
export const RECOGNISER_FILE = 'face_recognition_sface_2021dec.onnx';

// The same numbers as face-service/app.py.
const PHOTO_SCORE = 0.6;
const SELFIE_SCORE = 0.5;
const NMS = 0.3;
const TOP_K = 5000;
const STEP = 4; // each smaller copy is a quarter of the one before
const BIG_FACE = 320; // widest face trusted at one size, when a smaller copy exists to read it from instead
const FROM_SMALLER = 64; // a smaller copy only contributes faces at least this wide in it
const SMALLEST_COPY = 64; // no copy with a longer side under this
const SELFIE_SIDE = 1280;
const SCENE_SIDE = 640;
const SCENE_GREY = 320;
const SCENE_FEATURES = 1500;
// ORB drops every keypoint closer than its edge threshold (31 px) to a border, at every pyramid level, so a picture
// with a side under 2 * 31 + 1 px has none. Native OpenCV may also fail on it (a pyramid level 0 px high).
const ORB_SMALLEST = 63;
// Pictures are read at full size up to this many pixels (8160 x 6120, a 50 MP phone photo, fits). Each one takes
// 6 bytes a pixel while it is read. Working copies of event photos are far smaller (WORK_MAX_PX, 4096 px).
const MAX_PIXELS = 50_000_000;
// Never read a picture with more pixels than this, even shrunk on the way in (a 200 MP phone photo fits).
const LARGEST_INPUT = 200_000_000;
// A selfie with more than MAX_PIXELS is shrunk to this on the way in, then to SELFIE_SIDE as usual.
const SELFIE_FIT = 4096;

/** A photo that cannot be read: nothing to retry. */
export class BadImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadImageError';
  }
}

export interface WireFace {
  box: [number, number, number, number];
  score: number;
  vector: Float32Array;
}
export interface WireScene {
  inliers: number;
  ratio: number;
  cover: number;
  ncc: number;
}

const f32 = Math.fround;

/** Python's round(x, n): correctly rounded on the exact binary value. */
export function roundTo(x: number, digits: number): number {
  return Number(x.toFixed(digits));
}

/** Python's round(x) for a float: to the nearest integer, halves to the even one. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// ---- loading OpenCV (WebAssembly) ----------------------------------------------------------------------------------

let cvPromise: Promise<Cv> | null = null;
export function loadCv(): Promise<Cv> {
  if (!cvPromise) {
    cvPromise = (async () => {
      const mod: any = await import('@techstark/opencv-js');
      let cv = mod.default ?? mod;
      if (cv instanceof Promise) cv = await cv;
      else if (!cv.Mat) await new Promise<void>((resolve) => (cv.onRuntimeInitialized = () => resolve()));
      return cv;
    })();
  }
  return cvPromise;
}

// ---- the YuNet file declares a fixed 640 x 640 input; OpenCV ignores that, onnxruntime does not --------------------
// A tiny protobuf rewrite: the input's height and width become free ("h", "w"), the outputs' row count too,
// and the stored intermediate shapes (value_info, all for 640 x 640) are dropped. The weights are untouched.

function readVarint(b: Uint8Array, p: number): [number, number] {
  let v = 0;
  let s = 1;
  let x: number;
  do {
    x = b[p++];
    v += (x & 0x7f) * s;
    s *= 128;
  } while (x & 0x80);
  return [v, p];
}
function varint(n: number): Buffer {
  const o: number[] = [];
  while (n > 127) {
    o.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  o.push(n);
  return Buffer.from(o);
}
interface PbField {
  f: number;
  w: number;
  st: number;
  vs: number;
  ve: number;
}
function pbFields(b: Buffer): PbField[] {
  const out: PbField[] = [];
  let p = 0;
  while (p < b.length) {
    const st = p;
    let key: number;
    [key, p] = readVarint(b, p);
    const f = Math.floor(key / 8);
    const w = key & 7;
    let vs = p;
    if (w === 0) [, p] = readVarint(b, p);
    else if (w === 1) p += 8;
    else if (w === 5) p += 4;
    else if (w === 2) {
      let len: number;
      [len, vs] = readVarint(b, p);
      p = vs + len;
    } else throw new Error(`unexpected protobuf wire type ${w}`);
    out.push({ f, w, st, vs, ve: p });
  }
  return out;
}
/** Rebuild a message; fn returns a new value for a length-delimited field, null to drop it, undefined to keep it. */
function pbRewrite(b: Buffer, fn: (field: PbField, value: Buffer) => Buffer | null | undefined): Buffer {
  const parts: Buffer[] = [];
  for (const x of pbFields(b)) {
    const nv = x.w === 2 ? fn(x, b.subarray(x.vs, x.ve)) : undefined;
    if (nv === undefined) parts.push(b.subarray(x.st, x.ve));
    else if (nv !== null) parts.push(varint(x.f * 8 + 2), varint(nv.length), nv);
  }
  return Buffer.concat(parts);
}
function freeDims(valueInfo: Buffer, names: (string | null)[]): Buffer {
  // ValueInfoProto.type(2) -> TypeProto.tensor_type(1) -> shape(2) -> dim(1) -> dim_param(2)
  return pbRewrite(valueInfo, (a, type) =>
    a.f !== 2
      ? undefined
      : pbRewrite(type, (b, tensor) =>
          b.f !== 1
            ? undefined
            : pbRewrite(tensor, (c, shape) => {
                if (c.f !== 2) return undefined;
                let i = 0;
                return pbRewrite(shape, (d) => {
                  const name = names[i++];
                  if (d.f !== 1 || !name) return undefined;
                  return Buffer.concat([varint(2 * 8 + 2), varint(name.length), Buffer.from(name)]);
                });
              }),
        ),
  );
}
export function freeYunetInput(model: Buffer): Buffer {
  return pbRewrite(model, (g, graph) => {
    if (g.f !== 7) return undefined; // ModelProto.graph
    return pbRewrite(graph, (x, v) => {
      if (x.f === 13) return null; // value_info
      if (x.f === 11) return freeDims(v, [null, null, 'h', 'w']); // input
      if (x.f === 12) return freeDims(v, [null, 'n']); // output
      return undefined;
    });
  });
}

// ---- the engine ------------------------------------------------------------------------------------------------------

export interface WorkInit {
  modelsDir: string;
  /** onnxruntime threads for one network run. */
  threads?: number;
}

export class FaceWork {
  cv: Cv;
  yunet: ort.InferenceSession;
  sface: ort.InferenceSession;

  constructor(cv: Cv, yunet: ort.InferenceSession, sface: ort.InferenceSession) {
    this.cv = cv;
    this.yunet = yunet;
    this.sface = sface;
  }

  static async create(init: WorkInit): Promise<FaceWork> {
    const detector = path.join(init.modelsDir, DETECTOR_FILE);
    const recogniser = path.join(init.modelsDir, RECOGNISER_FILE);
    for (const f of [detector, recogniser]) {
      if (!fs.existsSync(f)) throw new Error(`The face model ${f} is missing.`);
    }
    const opts: ort.InferenceSession.SessionOptions = {
      intraOpNumThreads: Math.max(1, init.threads ?? 1),
      interOpNumThreads: 1,
      executionMode: 'sequential',
      logSeverityLevel: 3,
      // idle threads sleep instead of spinning: the server has other work
      extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
    };
    const [cv, yunet, sface] = await Promise.all([
      loadCv(),
      ort.InferenceSession.create(freeYunetInput(fs.readFileSync(detector)), opts),
      ort.InferenceSession.create(fs.readFileSync(recogniser), opts),
    ]);
    return new FaceWork(cv, yunet, sface);
  }

  async close(): Promise<void> {
    await Promise.all([this.yunet.release(), this.sface.release()]);
  }

  // ---- images ----

  /**
   * The photo upright, as BGR, like cv2.imdecode(..., IMREAD_COLOR). The caller deletes the Mat.
   * A picture with more than MAX_PIXELS is refused (BadImageError), unless fitWhenHuge is given: then it is
   * shrunk on the way in so its longer side is fitWhenHuge, and the full-size pixels are never held in memory.
   */
  async decode(jpeg: Uint8Array, fitWhenHuge = 0): Promise<Mat> {
    let raw: { data: Buffer; info: { width: number; height: number; channels: number } };
    try {
      const meta = await sharp(jpeg, { failOn: 'none', limitInputPixels: LARGEST_INPUT }).metadata();
      let pipeline = sharp(jpeg, { failOn: 'none', limitInputPixels: LARGEST_INPUT }).rotate();
      if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_PIXELS) {
        if (!fitWhenHuge) throw new BadImageError(`The photo is too large to read (${meta.width} x ${meta.height} pixels).`);
        pipeline = pipeline.resize({ width: fitWhenHuge, height: fitWhenHuge, fit: 'inside', withoutEnlargement: true });
      }
      raw = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    } catch (e) {
      if (e instanceof BadImageError) throw e;
      throw new BadImageError(`The photo could not be read: ${(e as Error).message}`);
    }
    const { data, info } = raw;
    const { width, height, channels } = info;
    const n = width * height;
    if (!n) throw new BadImageError('The photo is empty.');
    const wide = data.length === n * channels * 2; // 16 bits per channel: keep the high byte, as OpenCV does
    const at = wide ? (i: number) => data[i * 2 + 1] : (i: number) => data[i];
    const cv = this.cv;
    const mat = new cv.Mat(height, width, cv.CV_8UC3);
    // written straight into the Mat (no allocation happens in WebAssembly while this view is used)
    const bgr: Uint8Array = mat.data;
    if (channels >= 3) {
      for (let i = 0, s = 0, d = 0; i < n; i++, s += channels, d += 3) {
        bgr[d] = at(s + 2);
        bgr[d + 1] = at(s + 1);
        bgr[d + 2] = at(s);
      }
    } else {
      for (let i = 0, s = 0, d = 0; i < n; i++, s += channels, d += 3) bgr[d] = bgr[d + 1] = bgr[d + 2] = at(s);
    }
    return mat;
  }

  /** cv2.resize to a size, INTER_AREA, as the native OpenCV build computes it (see resizeArea). */
  resized(src: Mat, w: number, h: number): Mat {
    const cv = this.cv;
    const cn: number = src.channels();
    const out = resizeArea(src.data as Uint8Array, src.cols, src.rows, cn, w, h);
    if (!out) {
      // enlarging: OpenCV's own code, the same everywhere
      const dst = new cv.Mat();
      cv.resize(src, dst, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
      return dst;
    }
    const dst = new cv.Mat(h, w, cn === 3 ? cv.CV_8UC3 : cv.CV_8UC1);
    dst.data.set(out);
    return dst;
  }

  /** app.py shrink(): a copy whose longer side is at most maxSide, or null when the picture already fits. */
  shrunk(src: Mat, maxSide: number): Mat | null {
    const w = src.cols;
    const h = src.rows;
    const scale = maxSide / Math.max(h, w);
    if (scale >= 1.0) return null;
    return this.resized(src, Math.max(1, Math.trunc(w * scale)), Math.max(1, Math.trunc(h * scale)));
  }

  grey(src: Mat): Mat {
    const cv = this.cv;
    const g = new cv.Mat();
    cv.cvtColor(src, g, cv.COLOR_BGR2GRAY);
    return g;
  }

  // ---- fingerprint ----

  /** 256-bit difference hash: a 17 x 16 grey copy, each bit says a pixel is brighter than its left neighbour. */
  async fingerprint(jpeg: Uint8Array): Promise<Uint8Array> {
    const img = await this.decode(jpeg);
    let g: Mat;
    try {
      g = this.grey(img);
    } finally {
      img.delete();
    }
    let px: Uint8Array;
    try {
      const small = this.resized(g, 17, 16);
      px = Uint8Array.from(small.data as Uint8Array);
      small.delete();
    } finally {
      g.delete();
    }
    const out = new Uint8Array(32);
    let bit = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 1; x < 17; x++, bit++) {
        if (px[y * 17 + x] > px[y * 17 + x - 1]) out[bit >> 3] |= 0x80 >> (bit & 7);
      }
    }
    return out;
  }

  // ---- faces ----

  /** cv2.FaceDetectorYN.detect: rows of 15 (box, five landmarks, score), in the order OpenCV gives them. */
  async detect(img: Mat, threshold: number): Promise<Float32Array[]> {
    const W: number = img.cols;
    const H: number = img.rows;
    const padW = (Math.floor((W - 1) / 32) + 1) * 32;
    const padH = (Math.floor((H - 1) / 32) + 1) * 32;
    const plane = padW * padH;
    const blob = new Float32Array(plane * 3); // blobFromImage(padded): BGR planes, 0..255, zero padding right and below
    const src: Uint8Array = img.data;
    for (let y = 0; y < H; y++) {
      let s = y * W * 3;
      let d = y * padW;
      for (let x = 0; x < W; x++, s += 3, d++) {
        blob[d] = src[s];
        blob[d + plane] = src[s + 1];
        blob[d + 2 * plane] = src[s + 2];
      }
    }
    const out = await this.yunet.run({ input: new ort.Tensor('float32', blob, [1, 3, padH, padW]) });
    const thr = f32(threshold);
    const faces: Float32Array[] = [];
    for (const stride of [8, 16, 32]) {
      const cols = Math.trunc(padW / stride);
      const rows = Math.trunc(padH / stride);
      const cls = out[`cls_${stride}`].data as Float32Array;
      const obj = out[`obj_${stride}`].data as Float32Array;
      const bbox = out[`bbox_${stride}`].data as Float32Array;
      const kps = out[`kps_${stride}`].data as Float32Array;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const clsScore = Math.max(Math.min(cls[idx], 1), 0);
          const objScore = Math.max(Math.min(obj[idx], 1), 0);
          const score = f32(Math.sqrt(f32(clsScore * objScore)));
          if (score < thr) continue;
          const face = new Float32Array(15);
          const cx = f32(f32(c + bbox[idx * 4]) * stride);
          const cy = f32(f32(r + bbox[idx * 4 + 1]) * stride);
          const w = f32(f32(Math.exp(bbox[idx * 4 + 2])) * stride);
          const h = f32(f32(Math.exp(bbox[idx * 4 + 3])) * stride);
          face[0] = cx - f32(w / 2);
          face[1] = cy - f32(h / 2);
          face[2] = w;
          face[3] = h;
          for (let n = 0; n < 5; n++) {
            face[4 + 2 * n] = f32(kps[idx * 10 + 2 * n] + c) * stride;
            face[5 + 2 * n] = f32(kps[idx * 10 + 2 * n + 1] + r) * stride;
          }
          face[14] = score;
          faces.push(face);
        }
      }
    }
    if (faces.length <= 1) return faces;
    // dnn::NMSBoxes on integer boxes, scores above the threshold, highest first (stable), top K
    const boxes = faces.map((f) => [Math.trunc(f[0]), Math.trunc(f[1]), Math.trunc(f[2]), Math.trunc(f[3])]);
    const order = faces
      .map((f, i) => ({ s: f[14], i }))
      .filter((x) => x.s > thr)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, TOP_K);
    const nms = f32(NMS);
    const keep: number[] = [];
    for (const { i } of order) {
      let ok = true;
      for (let k = 0; k < keep.length && ok; k++) ok = overlap(boxes[i], boxes[keep[k]]) <= nms;
      if (ok) keep.push(i);
    }
    return keep.map((i) => faces[i]);
  }

  /** FaceRecognizerSF: alignCrop, then feature(); L2-normalised as app.py does. */
  async vector(img: Mat, face: Float32Array): Promise<Float32Array> {
    const cv = this.cv;
    const m = cv.matFromArray(2, 3, cv.CV_64F, alignMatrix(face));
    const aligned = new cv.Mat();
    cv.warpAffine(img, aligned, m, new cv.Size(112, 112), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
    m.delete();
    const a: Uint8Array = aligned.data;
    const P = 112 * 112;
    const blob = new Float32Array(P * 3); // blobFromImage(aligned, 1, 112x112, 0, swapRB=true): RGB planes
    for (let p = 0, s = 0; p < P; p++, s += 3) {
      blob[p] = a[s + 2];
      blob[p + P] = a[s + 1];
      blob[p + 2 * P] = a[s];
    }
    aligned.delete();
    const out = await this.sface.run({ data: new ort.Tensor('float32', blob, [1, 3, 112, 112]) });
    const v = out.fc1.data as Float32Array;
    let ss = 0;
    for (let i = 0; i < v.length; i++) ss += v[i] * v[i];
    const norm = f32(Math.sqrt(ss));
    const unit = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) unit[i] = v[i] / (norm + 1e-9);
    return unit;
  }

  /** app.py _all_faces: every face at whatever size, read at the copy where it measures BIG_FACE px or less. */
  async allFaces(img: Mat, threshold: number): Promise<{ box: number[]; score: number; vector: Float32Array }[]> {
    const W: number = img.cols;
    const H: number = img.rows;
    const copies: { scale: number; copy: Mat }[] = [];
    let scale = 1.0;
    let copy = img;
    try {
      for (;;) {
        copies.push({ scale, copy });
        scale /= STEP;
        if (Math.max(W, H) * scale < SMALLEST_COPY) break;
        copy = this.resized(img, Math.max(1, Math.trunc(W * scale)), Math.max(1, Math.trunc(H * scale)));
      }
      const kept: { box: number[]; score: number; vector: Float32Array }[] = [];
      for (let n = 0; n < copies.length; n++) {
        const { scale: s, copy: c } = copies[n];
        const last = n === copies.length - 1;
        for (const face of await this.detect(c, threshold)) {
          const width = face[2];
          if ((!last && width > BIG_FACE) || (n > 0 && width < FROM_SMALLER)) continue;
          const box = [face[0] / s, face[1] / s, face[2] / s, face[3] / s];
          if (kept.some((k) => boxOverlap(box, k.box) >= 0.3)) continue;
          kept.push({ box, score: face[14], vector: await this.vector(c, face) });
        }
      }
      return kept;
    } finally {
      for (const { copy: c } of copies) if (c !== img) c.delete();
    }
  }

  async faces(jpeg: Uint8Array, minFace: number): Promise<WireFace[]> {
    const img = await this.decode(jpeg);
    try {
      const out: WireFace[] = [];
      for (const { box, score, vector } of await this.allFaces(img, PHOTO_SCORE)) {
        if (box[2] < minFace) continue;
        out.push({ box: box.map(roundHalfEven) as WireFace['box'], score: roundTo(score, 4), vector });
      }
      return out;
    } finally {
      img.delete();
    }
  }

  async selfie(jpeg: Uint8Array): Promise<{ vector: Float32Array; faces: number } | null> {
    const full = await this.decode(jpeg, SELFIE_FIT);
    let small: Mat | null = null;
    try {
      small = this.shrunk(full, SELFIE_SIDE);
      const img = small ?? full;
      const found = await this.allFaces(img, SELFIE_SCORE);
      if (!found.length) return null;
      let best = found[0];
      for (const f of found) if (f.box[2] * f.box[3] > best.box[2] * best.box[3]) best = f; // the largest face
      return { vector: best.vector, faces: found.length };
    } finally {
      full.delete();
      small?.delete();
    }
  }

  // ---- the same shot, taken twice ----

  async scene(jpeg: Uint8Array): Promise<{ desc: Uint8Array; sharpness: number }> {
    const cv = this.cv;
    const img = await this.decode(jpeg);
    let grey: Mat;
    try {
      grey = this.grey(img);
    } finally {
      img.delete();
    }
    const trash: Mat[] = [grey];
    const keep = (m: Mat): Mat => {
      trash.push(m);
      return m;
    };
    try {
      const bigCopy = this.shrunk(grey, SCENE_SIDE);
      if (bigCopy) keep(bigCopy);
      const big = bigCopy ?? grey;
      const orb = keep(new cv.ORB(SCENE_FEATURES, 1.2, 8, 31, 0, 2, cv.ORB_HARRIS_SCORE, 31, 10));
      const kp = keep(new cv.KeyPointVector());
      const none = keep(new cv.Mat());
      const lap = keep(new cv.Mat());
      const smallCopy = this.shrunk(grey, SCENE_GREY);
      if (smallCopy) keep(smallCopy);
      const small = smallCopy ?? grey;
      // OpenCV finds the keypoints (the same as natively); their angles and descriptors are computed here,
      // because native OpenCV fuses multiply-adds there and WebAssembly does not (see orbDescribe).
      // A picture too thin for ORB has no keypoints: it is not handed to OpenCV, which can fail on it.
      if (Math.min(big.cols, big.rows) >= ORB_SMALLEST) orb.detect(big, kp, none);
      const n: number = kp.size();
      const pts = new Float32Array(n * 2);
      const octaves = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const k = kp.get(i);
        pts[i * 2] = k.pt.x;
        pts[i * 2 + 1] = k.pt.y;
        octaves[i] = k.octave;
      }
      const desBytes = n ? orbDescribe(cv, big, pts, octaves) : new Uint8Array(0);
      cv.Laplacian(big, lap, cv.CV_64F); // how much fine detail: blurred frames score low
      const sharpness = variance(lap.data64F as Float64Array);
      const desc = encodeScene({
        pts,
        des: desBytes,
        n: desBytes.length ? n : 0,
        width: big.cols,
        height: big.rows,
        grey: Uint8Array.from(small.data as Uint8Array),
        greyWidth: small.cols,
        greyHeight: small.rows,
      });
      return { desc, sharpness: roundTo(sharpness, 2) };
    } finally {
      for (const m of trash) m.delete();
    }
  }

  compare(aBytes: Uint8Array, bBytes: Uint8Array): WireScene {
    const cv = this.cv;
    const a = decodeScene(aBytes);
    const b = decodeScene(bBytes);
    const none: WireScene = { inliers: 0, ratio: 0, cover: 0, ncc: 0 };
    if (a.n < 20 || b.n < 20) return none;
    const trash: any[] = [];
    const keep = <T>(m: T): T => {
      trash.push(m);
      return m;
    };
    try {
      const da = keep(cv.matFromArray(a.n, 32, cv.CV_8U, a.des));
      const db = keep(cv.matFromArray(b.n, 32, cv.CV_8U, b.des));
      const matcher = keep(new cv.BFMatcher(cv.NORM_HAMMING, false));
      const pairs = keep(new cv.DMatchVectorVector());
      matcher.knnMatch(da, db, pairs, 2);
      const src: number[] = [];
      const dst: number[] = [];
      for (let i = 0; i < pairs.size(); i++) {
        const p = pairs.get(i);
        if (p.size() === 2) {
          const m = p.get(0);
          const nn = p.get(1);
          if (m.distance < 0.75 * nn.distance) {
            src.push(a.pts[m.queryIdx * 2], a.pts[m.queryIdx * 2 + 1]);
            dst.push(b.pts[m.trainIdx * 2], b.pts[m.trainIdx * 2 + 1]);
          }
        }
        p.delete();
      }
      if (src.length / 2 < 12) return none;
      const sm = keep(cv.matFromArray(src.length / 2, 1, cv.CV_32FC2, src));
      const dm = keep(cv.matFromArray(dst.length / 2, 1, cv.CV_32FC2, dst));
      const mask = keep(new cv.Mat());
      const hmMat = keep(cv.findHomography(sm, dm, cv.RANSAC, 6.0, mask, 2000, 0.995));
      if (hmMat.empty() || hmMat.rows !== 3) return none;
      const hm = Array.from(hmMat.data64F as Float64Array);
      const inliers: number = cv.countNonZero(mask);
      const [wa, ha, wb, hb] = [a.width, a.height, b.width, b.height];
      const quad = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, wa, 0, wa, ha, 0, ha]));
      const cornersMat = keep(new cv.Mat());
      cv.perspectiveTransform(quad, cornersMat, hmMat);
      const corners = Float32Array.from(cornersMat.data32F as Float32Array);
      let shared = 0;
      try {
        const rect = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, wb, 0, wb, hb, 0, hb]));
        const inter = keep(new cv.Mat());
        shared = cv.intersectConvexConvex(cornersMat, rect, inter, true);
      } catch {
        shared = 0; // OpenCV refuses a twisted outline: no shared view
      }
      const cover = shared > 0 ? Math.min(shared / (wb * hb), shared / Math.max(polyArea(corners), 1.0)) : 0;
      // lay photo a on photo b in the small grey copies
      const sa = a.greyWidth / wa;
      const sb = b.greyWidth / wb;
      // np.diag([sb, sb, 1]) @ hm @ np.diag([1 / sa, 1 / sa, 1]), with numpy's order of operations
      const ia = 1 / sa;
      const small = [
        sb * hm[0] * ia, sb * hm[1] * ia, sb * hm[2],
        sb * hm[3] * ia, sb * hm[4] * ia, sb * hm[5],
        hm[6] * ia, hm[7] * ia, hm[8],
      ];
      const sh = keep(cv.matFromArray(3, 3, cv.CV_64F, small));
      const inv = keep(new cv.Mat());
      cv.invert(sh, inv, cv.DECOMP_LU); // warpPerspective maps each output pixel back through the inverse
      const back = Array.from(inv.data64F as Float64Array);
      const gbArr = b.grey;
      const w = warpPerspectiveLinear(a.grey, a.greyWidth, a.greyHeight, back, b.greyWidth, b.greyHeight);
      const inside = warpPerspectiveLinear(new Uint8Array(a.grey.length).fill(255), a.greyWidth, a.greyHeight, back, b.greyWidth, b.greyHeight);
      let count = 0;
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < inside.length; i++) {
        if (inside[i]) {
          count++;
          sx += w[i];
          sy += gbArr[i];
        }
      }
      let ncc = 0;
      if (count > 500) {
        const mx = sx / count;
        const my = sy / count;
        let sxy = 0;
        let sxx = 0;
        let syy = 0;
        for (let i = 0; i < inside.length; i++) {
          if (inside[i]) {
            const dx = w[i] - mx;
            const dy = gbArr[i] - my;
            sxy += dx * dy;
            sxx += dx * dx;
            syy += dy * dy;
          }
        }
        ncc = sxy / count / (Math.sqrt(sxx / count) * Math.sqrt(syy / count) + 1e-6);
      }
      return {
        inliers,
        ratio: roundTo(inliers / Math.min(a.n, b.n), 4),
        cover: roundTo(cover, 4),
        ncc: roundTo(ncc, 4),
      };
    } finally {
      for (const m of trash) m.delete();
    }
  }
}

/** Shared area of two boxes (x, y, w, h) over the area they cover together (app.py box_overlap). */
function boxOverlap(a: number[], b: number[]): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0.0, x1 - x0) * Math.max(0.0, y1 - y0);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9);
}

/** OpenCV's rectOverlap for integer rectangles in NMSBoxes: 1 - (float) jaccardDistance. */
function overlap(a: number[], b: number[]): number {
  const aa = a[2] * a[3];
  const ab = b[2] * b[3];
  if (aa + ab <= 0) return 1;
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - x1;
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - y1;
  const inter = w > 0 && h > 0 ? w * h : 0;
  return f32(1 - f32(1.0 - inter / (aa + ab - inter)));
}

const REF = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
].map((p) => p.map(f32));
const REF_MEAN = [f32(56.0262), f32(71.9008)];

/**
 * FaceRecognizerSF's getSimilarityTransformMatrix (opencv objdetect/src/face_recognize.cpp), with its float steps:
 * Umeyama from the five landmarks to the reference points. For a 2 x 2 problem the proper rotation of the SVD
 * solution is theta = atan2(A10 - A01, A00 + A11), and s0*d0 + s1*d1 = sqrt((A00 + A11)^2 + (A10 - A01)^2).
 */
export function alignMatrix(face: Float32Array): number[] {
  const src = [0, 1, 2, 3, 4].map((i) => [face[4 + 2 * i], face[5 + 2 * i]]);
  const mean = [0, 1].map((k) => f32(f32(f32(f32(f32(src[0][k] + src[1][k]) + src[2][k]) + src[3][k]) + src[4][k]) / 5));
  const sd = src.map((p) => [f32(p[0] - mean[0]), f32(p[1] - mean[1])]);
  const dd = REF.map((p) => [f32(p[0] - REF_MEAN[0]), f32(p[1] - REF_MEAN[1])]);
  const A = (i: number, j: number) => {
    let s = 0;
    for (let k = 0; k < 5; k++) s += f32(dd[k][i] * sd[k][j]);
    return s / 5;
  };
  const a00 = A(0, 0);
  const a01 = A(0, 1);
  const a10 = A(1, 0);
  const a11 = A(1, 1);
  let var1 = 0;
  let var2 = 0;
  for (let k = 0; k < 5; k++) {
    var1 += f32(sd[k][0] * sd[k][0]);
    var2 += f32(sd[k][1] * sd[k][1]);
  }
  var1 /= 5;
  var2 /= 5;
  const p = a00 + a11;
  const q = a10 - a01;
  const r = Math.hypot(p, q);
  const cos = r > 0 ? p / r : 1;
  const sin = r > 0 ? q / r : 0;
  const scale = (1.0 / (var1 + var2)) * r;
  const ts0 = cos * mean[0] - sin * mean[1];
  const ts1 = sin * mean[0] + cos * mean[1];
  return [scale * cos, -scale * sin, REF_MEAN[0] - scale * ts0, scale * sin, scale * cos, REF_MEAN[1] - scale * ts1];
}

// ---- INTER_AREA resize, as native OpenCV 5 (arm64) computes it ------------------------------------------------------
// The algorithm is OpenCV's (imgproc resize.cpp: resizeAreaFast_ for whole-number scales, ResizeArea_Invoker
// otherwise), but the rounding is the native build's: there the compiler fuses `buf += S * alpha` into one
// multiply-add, and of `sum += beta * buf` only the scalar tail after the 4-wide vector loop is fused. Without
// this, about one picture in four came out with a few pixels one level apart, and ORB keypoints moved with them.
// Measured on 73 event photos and synthetic sizes: identical to cv2.resize(..., INTER_AREA) for every one.

function areaTable(ssize: number, dsize: number, cn: number, scale: number): { di: Int32Array; si: Int32Array; alpha: Float32Array } {
  const di: number[] = [];
  const si: number[] = [];
  const alpha: number[] = [];
  for (let dx = 0; dx < dsize; dx++) {
    const fsx1 = dx * scale;
    const fsx2 = fsx1 + scale;
    const cellWidth = Math.min(scale, ssize - fsx1);
    let sx1 = Math.ceil(fsx1);
    let sx2 = Math.floor(fsx2);
    sx2 = Math.min(sx2, ssize - 1);
    sx1 = Math.min(sx1, sx2);
    if (sx1 - fsx1 > 1e-3) {
      di.push(dx * cn);
      si.push((sx1 - 1) * cn);
      alpha.push((sx1 - fsx1) / cellWidth);
    }
    for (let sx = sx1; sx < sx2; sx++) {
      di.push(dx * cn);
      si.push(sx * cn);
      alpha.push(1.0 / cellWidth);
    }
    if (fsx2 - sx2 > 1e-3) {
      di.push(dx * cn);
      si.push(sx2 * cn);
      alpha.push(Math.min(Math.min(fsx2 - sx2, 1), cellWidth) / cellWidth);
    }
  }
  return { di: Int32Array.from(di), si: Int32Array.from(si), alpha: Float32Array.from(alpha) };
}

/** saturate_cast<uchar>(float): round half to even, clamp. */
function toByte(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  const r = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

/** cv2.resize(src, (dw, dh), interpolation=INTER_AREA) for 8-bit pictures; null when it would enlarge. */
export function resizeArea(src: Uint8Array, sw: number, sh: number, cn: number, dw: number, dh: number): Uint8Array | null {
  const scaleX = 1 / (dw / sw);
  const scaleY = 1 / (dh / sh);
  if (scaleX < 1 || scaleY < 1) return null;
  const dst = new Uint8Array(dw * dh * cn);
  const ix = Math.round(scaleX);
  const iy = Math.round(scaleY);
  const rowStep = sw * cn;
  if (Math.abs(scaleX - ix) < Number.EPSILON && Math.abs(scaleY - iy) < Number.EPSILON) {
    // whole-number scale: integer sums (2 x 2 rounds half up, as OpenCV's vector code does)
    const area = ix * iy;
    const inv = f32(1 / area);
    for (let dy = 0; dy < dh; dy++) {
      for (let dx = 0; dx < dw; dx++) {
        for (let c = 0; c < cn; c++) {
          let s = 0;
          let o = dy * iy * rowStep + dx * ix * cn + c;
          for (let y = 0; y < iy; y++, o += rowStep) for (let x = 0; x < ix; x++) s += src[o + x * cn];
          dst[(dy * dw + dx) * cn + c] = area === 4 && ix === 2 ? (s + 2) >> 2 : toByte(f32(s * inv));
        }
      }
    }
    return dst;
  }
  const xt = areaTable(sw, dw, cn, scaleX);
  const yt = areaTable(sh, dh, 1, scaleY);
  const W = dw * cn;
  const vec = W - (W % 4);
  const buf = new Float32Array(W);
  const sum = new Float32Array(W);
  const n = xt.di.length;
  let prev = yt.di[0];
  for (let j = 0; j < yt.di.length; j++) {
    const beta = yt.alpha[j];
    const dy = yt.di[j];
    const row = yt.si[j] * rowStep;
    buf.fill(0);
    if (cn === 1) {
      // the entries of one output pixel are next to each other: keep the running float in a local
      let d = xt.di[0];
      let acc = 0;
      for (let k = 0; k < n; k++) {
        const dk = xt.di[k];
        if (dk !== d) {
          buf[d] = acc;
          d = dk;
          acc = 0;
        }
        acc = f32(acc + src[row + xt.si[k]] * xt.alpha[k]);
      }
      if (n) buf[d] = acc;
    } else {
      for (let k = 0; k < n; k++) {
        const d = xt.di[k];
        const s = row + xt.si[k];
        const a = xt.alpha[k];
        for (let c = 0; c < cn; c++) buf[d + c] = buf[d + c] + src[s + c] * a;
      }
    }
    if (dy !== prev) {
      const o = prev * W;
      for (let x = 0; x < W; x++) {
        dst[o + x] = toByte(sum[x]);
        sum[x] = beta * buf[x];
      }
      prev = dy;
    } else {
      for (let x = 0; x < vec; x++) sum[x] = sum[x] + f32(beta * buf[x]);
      for (let x = vec; x < W; x++) sum[x] = sum[x] + beta * buf[x];
    }
  }
  const o = prev * W;
  for (let x = 0; x < W; x++) dst[o + x] = toByte(sum[x]);
  return dst;
}

// ---- ORB angles and descriptors, as native OpenCV computes them -----------------------------------------------------
// OpenCV (WebAssembly) finds the keypoints: positions, levels and their order come out as natively. The angle
// (intensity centroid, cv::fastAtan2) and the rotated BRIEF descriptor are computed here, following
// features2d/src/orb.cpp, with the native build's fused multiply-adds in fastAtan2's polynomial. The descriptor
// samples the pyramid blurred by GaussianBlur(7x7, sigma 2) as ORB runs it: on a sub-matrix, so OpenCV's float
// path, not the bit-exact one. Measured: angles and descriptors identical to cv2.ORB_create(...) on event photos.

const ORB_LEVELS = 8;
const ORB_SCALE = f32(1.2);
const HALF_PATCH = 15;
const R2D = f32(180 / Math.PI);
const ATAN_P1 = f32(f32(0.9997878412794807) * R2D);
const ATAN_P3 = f32(f32(-0.3258083974640975) * R2D);
const ATAN_P5 = f32(f32(0.1555786518463281) * R2D);
const ATAN_P7 = f32(f32(-0.04432655554792128) * R2D);
const DBL_EPS = f32(Number.EPSILON);
const D2R = f32(Math.PI / 180);

/** cv::fastAtan2 in degrees, with the polynomial's multiply-adds fused. */
function fastAtan2(y: number, x: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const poly = (c: number) => {
    const c2 = f32(c * c);
    return f32(f32(f32(ATAN_P7 * c2 + ATAN_P5) * c2 + ATAN_P3) * c2 + ATAN_P1);
  };
  let a: number;
  if (ax >= ay) {
    const c = f32(ay / f32(ax + DBL_EPS));
    a = f32(poly(c) * c);
  } else {
    const c = f32(ax / f32(ay + DBL_EPS));
    a = f32(90 - poly(c) * c);
  }
  if (x < 0) a = f32(180 - a);
  if (y < 0) a = f32(360 - a);
  return a;
}

const UMAX = (() => {
  const u = new Array<number>(HALF_PATCH + 2).fill(0);
  const vmax = Math.floor((HALF_PATCH * f32(Math.SQRT2)) / 2 + 1);
  const vmin = Math.ceil((HALF_PATCH * f32(Math.SQRT2)) / 2);
  for (let v = 0; v <= vmax; v++) u[v] = roundHalfEven(Math.sqrt(HALF_PATCH * HALF_PATCH - v * v));
  for (let v = HALF_PATCH, v0 = 0; v >= vmin; --v) {
    while (u[v0] === u[v0 + 1]) ++v0;
    u[v] = v0;
    ++v0;
  }
  return u;
})();

/** ORB's 256 point pairs for a 31 px patch (bit_pattern_31_ in orb.cpp): x1, y1, x2, y2. */
const PATTERN = Int8Array.from([
  8, -3, 9, 5, 4, 2, 7, -12, -11, 9, -8, 2, 7, -12, 12, -13, 2, -13, 2, 12, 1, -7, 1, 6, -2, -10, -2, -4, -13, -13, -11, -8,
  -13, -3, -12, -9, 10, 4, 11, 9, -13, -8, -8, -9, -11, 7, -9, 12, 7, 7, 12, 6, -4, -5, -3, 0, -13, 2, -12, -3, -9, 0, -7, 5,
  12, -6, 12, -1, -3, 6, -2, 12, -6, -13, -4, -8, 11, -13, 12, -8, 4, 7, 5, 1, 5, -3, 10, -3, 3, -7, 6, 12, -8, -7, -6, -2,
  -2, 11, -1, -10, -13, 12, -8, 10, -7, 3, -5, -3, -4, 2, -3, 7, -10, -12, -6, 11, 5, -12, 6, -7, 5, -6, 7, -1, 1, 0, 4, -5,
  9, 11, 11, -13, 4, 7, 4, 12, 2, -1, 4, 4, -4, -12, -2, 7, -8, -5, -7, -10, 4, 11, 9, 12, 0, -8, 1, -13, -13, -2, -8, 2,
  -3, -2, -2, 3, -6, 9, -4, -9, 8, 12, 10, 7, 0, 9, 1, 3, 7, -5, 11, -10, -13, -6, -11, 0, 10, 7, 12, 1, -6, -3, -6, 12,
  10, -9, 12, -4, -13, 8, -8, -12, -13, 0, -8, -4, 3, 3, 7, 8, 5, 7, 10, -7, -1, 7, 1, -12, 3, -10, 5, 6, 2, -4, 3, -10,
  -13, 0, -13, 5, -13, -7, -12, 12, -13, 3, -11, 8, -7, 12, -4, 7, 6, -10, 12, 8, -9, -1, -7, -6, -2, -5, 0, 12, -12, 5, -7, 5,
  3, -10, 8, -13, -7, -7, -4, 5, -3, -2, -1, -7, 2, 9, 5, -11, -11, -13, -5, -13, -1, 6, 0, -1, 5, -3, 5, 2, -4, -13, -4, 12,
  -9, -6, -9, 6, -12, -10, -8, -4, 10, 2, 12, -3, 7, 12, 12, 12, -7, -13, -6, 5, -4, 9, -3, 4, 7, -1, 12, 2, -7, 6, -5, 1,
  -13, 11, -12, 5, -3, 7, -2, -6, 7, -8, 12, -7, -13, -7, -11, -12, 1, -3, 12, 12, 2, -6, 3, 0, -4, 3, -2, -13, -1, -13, 1, 9,
  7, 1, 8, -6, 1, -1, 3, 12, 9, 1, 12, 6, -1, -9, -1, 3, -13, -13, -10, 5, 7, 7, 10, 12, 12, -5, 12, 9, 6, 3, 7, 11,
  5, -13, 6, 10, 2, -12, 2, 3, 3, 8, 4, -6, 2, 6, 12, -13, 9, -12, 10, 3, -8, 4, -7, 9, -11, 12, -4, -6, 1, 12, 2, -8,
  6, -9, 7, -4, 2, 3, 3, -2, 6, 3, 11, 0, 3, -3, 8, -8, 7, 8, 9, 3, -11, -5, -6, -4, -10, 11, -5, 10, -5, -8, -3, 12,
  -10, 5, -9, 0, 8, -1, 12, -6, 4, -6, 6, -11, -10, 12, -8, 7, 4, -2, 6, 7, -2, 0, -2, 12, -5, -8, -5, 2, 7, -6, 10, 12,
  -9, -13, -8, -8, -5, -13, -5, -2, 8, -8, 9, -13, -9, -11, -9, 0, 1, -8, 1, -2, 7, -4, 9, 1, -2, 1, -1, -4, 11, -6, 12, -11,
  -12, -9, -6, 4, 3, 7, 7, 12, 5, 5, 10, 8, 0, -4, 2, 8, -9, 12, -5, -13, 0, 7, 2, 12, -1, 2, 1, 7, 5, 11, 7, -9,
  3, 5, 6, -8, -13, -4, -8, 9, -5, 9, -3, -3, -4, -7, -3, -12, 6, 5, 8, 0, -7, 6, -6, 12, -13, 6, -5, -2, 1, -10, 3, 10,
  4, 1, 8, -4, -2, -2, 2, -13, 2, -12, 12, 12, -2, -13, 0, -6, 4, 1, 9, 3, -6, -10, -3, -5, -3, -13, -1, 1, 7, 5, 12, -11,
  4, -2, 5, -7, -13, 9, -9, -5, 7, 1, 8, 6, 7, -8, 7, 6, -7, -4, -7, 1, -8, 11, -7, -8, -13, 6, -12, -8, 2, 4, 3, 9,
  10, -5, 12, 3, -6, -5, -6, 7, 8, -3, 9, -8, 2, -12, 2, 8, -11, -2, -10, 3, -12, -13, -7, -9, -11, 0, -10, -5, 5, -3, 11, 8,
  -2, -13, -1, 12, -1, -8, 0, 9, -13, -11, -12, -5, -10, -2, -10, 11, -3, 9, -2, -13, 2, -3, 3, 2, -9, -13, -4, 0, -4, 6, -3, -10,
  -4, 12, -2, -7, -6, -11, -4, 9, 6, -3, 6, 11, -13, 11, -5, 5, 11, 11, 12, 6, 7, -5, 12, -2, -1, 12, 0, 7, -4, -8, -3, -2,
  -7, 1, -6, 7, -13, -12, -8, -13, -7, -2, -6, -8, -8, 5, -6, -9, -5, -1, -4, 5, -13, 7, -8, 10, 1, 5, 5, -13, 1, 0, 10, -13,
  9, 12, 10, -1, 5, -8, 10, -9, -1, 11, 1, -13, -9, -3, -6, 2, -1, -10, 1, 12, -13, 1, -8, -10, 8, -11, 10, -6, 2, -13, 3, -6,
  7, -13, 12, -9, -10, -10, -5, -7, -10, -8, -8, -13, 4, -6, 8, 5, 3, 12, 8, -13, -4, 2, -3, -3, 5, -13, 10, -12, 4, -13, 5, -1,
  -9, 9, -4, 3, 0, 3, 3, -9, -12, 1, -6, 1, 3, 2, 4, -8, -10, -10, -10, 9, 8, -13, 12, 12, -8, -12, -6, -5, 2, 2, 3, 7,
  10, 6, 11, -8, 6, 8, 8, -12, -7, 10, -6, 5, -3, -9, -3, 9, -1, -13, -1, 5, -3, -7, -3, 4, -8, -2, -8, 3, 4, 2, 12, 12,
  2, -5, 3, 11, 6, -9, 11, -13, 3, -1, 7, 12, 11, -1, 12, 4, -3, 0, -3, 6, 4, -11, 4, 12, 2, -4, 2, 1, -10, -6, -8, 1,
  -13, 7, -11, 1, -13, 12, -11, -13, 6, 0, 11, -13, 0, -1, 1, 4, -13, 3, -9, -2, -9, 8, -6, -3, -13, -6, -8, -2, 5, -9, 8, 10,
  2, 7, 3, -9, -1, -6, -1, -1, 9, 5, 11, -2, 11, -3, 12, -8, 3, 0, 3, 5, -1, 4, 0, 10, 3, -6, 4, 5, -13, 0, -10, 5,
  5, 8, 12, 11, 8, 9, 9, -6, 7, -4, 8, -12, -10, 4, -10, 9, 7, 3, 12, 4, 9, -7, 10, -2, 7, 0, 12, -2, -1, -6, 0, -11,
]);

/** 32-byte rotated BRIEF descriptors for keypoints found by cv.ORB on `img` (8-bit grey). */
export function orbDescribe(cv: Cv, img: Mat, pts: Float32Array, octaves: Int32Array): Uint8Array {
  const n = octaves.length;
  const out = new Uint8Array(n * 32);
  const levels: Mat[] = [img];
  const blurred: Uint8Array[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  const scales: number[] = [];
  const top = Math.max(0, ...Array.from(octaves));
  try {
    for (let l = 0; l <= top && l < ORB_LEVELS; l++) {
      const scale = f32(Math.pow(ORB_SCALE, l));
      scales.push(scale);
      if (l > 0) {
        const size = new cv.Size(roundHalfEven(f32(img.cols / scale)), roundHalfEven(f32(img.rows / scale)));
        const m = new cv.Mat();
        cv.resize(levels[l - 1], m, size, 0, 0, cv.INTER_LINEAR_EXACT);
        levels.push(m);
      }
      const L = levels[l];
      const border = 8;
      const ext = new cv.Mat();
      cv.copyMakeBorder(L, ext, border, border, border, border, cv.BORDER_REFLECT_101);
      const roi = ext.roi(new cv.Rect(border, border, L.cols, L.rows));
      const b = new cv.Mat();
      cv.GaussianBlur(roi, b, new cv.Size(7, 7), 2, 2, cv.BORDER_REFLECT_101);
      blurred.push(Uint8Array.from(b.data as Uint8Array));
      widths.push(L.cols);
      heights.push(L.rows);
      for (const m of [ext, roi, b]) m.delete();
    }
    const raw = levels.map((m) => Uint8Array.from(m.data as Uint8Array));
    for (let i = 0; i < n; i++) {
      const lv = octaves[i];
      const inv = f32(1 / scales[lv]);
      const cx = roundHalfEven(f32(pts[i * 2] * inv));
      const cy = roundHalfEven(f32(pts[i * 2 + 1] * inv));
      const st = widths[lv];
      if (cx < 22 || cy < 22 || cx >= st - 22 || cy >= heights[lv] - 22) {
        throw new Error('ORB keypoint too close to the border'); // cannot happen: ORB keeps 31 px clear
      }
      // intensity centroid (IC_Angle) on the level as it is
      const d = raw[lv];
      const c0 = cy * st + cx;
      let m01 = 0;
      let m10 = 0;
      for (let u = -HALF_PATCH; u <= HALF_PATCH; u++) m10 += u * d[c0 + u];
      for (let v = 1; v <= HALF_PATCH; v++) {
        let vs = 0;
        const dd = UMAX[v];
        for (let u = -dd; u <= dd; u++) {
          const p = d[c0 + u + v * st];
          const m = d[c0 + u - v * st];
          vs += p - m;
          m10 += u * (p + m);
        }
        m01 += v * vs;
      }
      const t = f32(fastAtan2(m01, m10) * D2R);
      const a = f32(Math.cos(t));
      const b = f32(Math.sin(t));
      // rotated BRIEF on the blurred level
      const bd = blurred[lv];
      const value = (j: number) => {
        const px = PATTERN[j * 2];
        const py = PATTERN[j * 2 + 1];
        const x = roundHalfEven(f32(px * a - f32(py * b)));
        const y = roundHalfEven(f32(px * b + f32(py * a)));
        return bd[c0 + y * st + x];
      };
      for (let byte = 0; byte < 32; byte++) {
        let v = 0;
        for (let bit = 0; bit < 8; bit++) {
          const j = byte * 16 + bit * 2;
          if (value(j) < value(j + 1)) v |= 1 << bit;
        }
        out[i * 32 + byte] = v;
      }
    }
    return out;
  } finally {
    for (let l = 1; l < levels.length; l++) levels[l].delete();
  }
}

// ---- warpPerspective, INTER_LINEAR, constant 0 border, as native OpenCV 5 (arm64) computes it ------------------------
// OpenCV 5's float warp kernel in its vector form: the matrix in float, per row M1*y + M2 (fused), per pixel
// M0*x + that (fused), times the reciprocal of the w term, then bilinear interpolation. The WebAssembly build runs
// the scalar form (a division instead), which moves a few pixels by one level and the agreement in the 4th decimal.
export function warpPerspectiveLinear(src: Uint8Array, sw: number, sh: number, inv: number[], dw: number, dh: number): Uint8Array {
  const M = inv.map(f32);
  const out = new Uint8Array(dw * dh);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= sw || y >= sh ? 0 : src[y * sw + x]);
  for (let y = 0; y < dh; y++) {
    const mx = f32(M[1] * y + M[2]);
    const my = f32(M[4] * y + M[5]);
    const mw = f32(M[7] * y + M[8]);
    for (let x = 0; x < dw; x++) {
      const iw = f32(1 / f32(M[6] * x + mw));
      const X = f32(f32(M[0] * x + mx) * iw);
      const Y = f32(f32(M[3] * x + my) * iw);
      if (!(X > -1 && Y > -1 && X < sw && Y < sh)) continue; // outside: the border value, 0
      const ix = Math.floor(X);
      const iy = Math.floor(Y);
      const ax = f32(X - ix);
      const ay = f32(Y - iy);
      const p00 = at(ix, iy);
      const p01 = at(ix + 1, iy);
      const p10 = at(ix, iy + 1);
      const p11 = at(ix + 1, iy + 1);
      const v0 = f32(p00 + ax * (p01 - p00));
      const v1 = f32(p10 + ax * (p11 - p10));
      out[y * dw + x] = toByte(f32(v0 + ay * f32(v1 - v0)));
    }
  }
  return out;
}

/** numpy's var(): mean of squared deviations from the mean. */
function variance(x: Float64Array): number {
  if (!x.length) return 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  const m = s / x.length;
  let v = 0;
  for (let i = 0; i < x.length; i++) v += (x[i] - m) * (x[i] - m);
  return v / x.length;
}

/** app.py _poly_area, with its float32 dot products. */
function polyArea(p: Float32Array): number {
  const n = p.length / 2;
  let d1 = 0;
  let d2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i - 1 + n) % n; // np.roll(.., 1)
    d1 = f32(d1 + f32(p[i * 2] * p[j * 2 + 1]));
    d2 = f32(d2 + f32(p[i * 2 + 1] * p[j * 2]));
  }
  return 0.5 * Math.abs(d1 - d2);
}

// ---- the scene description: a small binary format ------------------------------------------------------------------
//   0  'SCN' + version 1
//   4  u16 keypoints n, u16 width, u16 height (the copy the keypoints are in), u16 grey width, u16 grey height, u16 0
//  16  deflate( n x 2 float32 points | n x 32 bytes ORB descriptors | grey width x height bytes )

export interface Scene {
  n: number;
  pts: Float32Array;
  des: Uint8Array;
  width: number;
  height: number;
  grey: Uint8Array;
  greyWidth: number;
  greyHeight: number;
}
const MAGIC = [0x53, 0x43, 0x4e, 1];

export function encodeScene(s: Scene): Uint8Array {
  const head = Buffer.alloc(16);
  MAGIC.forEach((b, i) => (head[i] = b));
  head.writeUInt16LE(s.n, 4);
  head.writeUInt16LE(s.width, 6);
  head.writeUInt16LE(s.height, 8);
  head.writeUInt16LE(s.greyWidth, 10);
  head.writeUInt16LE(s.greyHeight, 12);
  const pts = Buffer.alloc(s.n * 8);
  for (let i = 0; i < s.n * 2; i++) pts.writeFloatLE(s.pts[i], i * 4);
  const body = zlib.deflateRawSync(Buffer.concat([pts, s.des.subarray(0, s.n * 32), s.grey]));
  return Buffer.concat([head, body]);
}

export function decodeScene(bytes: Uint8Array): Scene {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 16 || MAGIC.some((x, i) => b[i] !== x)) throw new Error('This is not a scene description of this engine.');
  const n = b.readUInt16LE(4);
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  const greyWidth = b.readUInt16LE(10);
  const greyHeight = b.readUInt16LE(12);
  const body = zlib.inflateRawSync(b.subarray(16));
  if (body.length !== n * 8 + n * 32 + greyWidth * greyHeight) throw new Error('The scene description is damaged.');
  const pts = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) pts[i] = body.readFloatLE(i * 4);
  return {
    n,
    pts,
    des: body.subarray(n * 8, n * 40),
    width,
    height,
    grey: body.subarray(n * 40),
    greyWidth,
    greyHeight,
  };
}

// ---- the worker side of the pool (see local.ts) ----------------------------------------------------------------------

export interface WorkRequest {
  id: number;
  op: 'fingerprint' | 'faces' | 'selfie' | 'scene' | 'compare';
  jpeg?: Uint8Array;
  a?: Uint8Array;
  b?: Uint8Array;
  minFace?: number;
}

const boot = workerData as { faceWorker?: WorkInit } | null;
if (parentPort && boot?.faceWorker) {
  const port = parentPort;
  FaceWork.create(boot.faceWorker).then(
    (work) => {
      let chain = Promise.resolve();
      let broken = ''; // set once OpenCV's memory can no longer be trusted: this worker takes no more work
      port.on('message', (req: WorkRequest) => {
        chain = chain.then(async () => {
          if (broken) {
            port.postMessage({ id: req.id, ok: false, poisoned: true, name: 'Error', message: broken });
            return;
          }
          try {
            let result: unknown;
            const transfer: ArrayBuffer[] = [];
            if (req.op === 'fingerprint') result = await work.fingerprint(req.jpeg!);
            else if (req.op === 'faces') {
              const faces = await work.faces(req.jpeg!, req.minFace ?? 0);
              for (const f of faces) transfer.push(f.vector.buffer as ArrayBuffer);
              result = faces;
            } else if (req.op === 'selfie') {
              const s = await work.selfie(req.jpeg!);
              if (s) transfer.push(s.vector.buffer as ArrayBuffer);
              result = s;
            } else if (req.op === 'scene') result = await work.scene(req.jpeg!);
            else if (req.op === 'compare') result = work.compare(req.a!, req.b!);
            else throw new Error(`unknown face work ${String(req.op)}`);
            port.postMessage({ id: req.id, ok: true, result }, transfer);
          } catch (e) {
            const err = e instanceof Error ? e : new Error(cvMessage(work.cv, e));
            if (isPoison(e)) {
              // The pool (local.ts) stops this worker and starts a fresh one when it reads `poisoned`.
              // If it does not within a few seconds, the worker ends itself, which does the same.
              broken = `The face worker had to be restarted after: ${err.message}`;
              port.postMessage({ id: req.id, ok: false, poisoned: true, name: 'Error', message: err.message });
              setTimeout(() => process.exit(1), 5000).unref();
              return;
            }
            port.postMessage({ id: req.id, ok: false, name: err.name, message: err.message });
          }
        });
      });
      port.postMessage({ ready: true });
    },
    (e: unknown) => port.postMessage({ ready: false, message: (e as Error)?.message ?? String(e) }),
  );
}

/**
 * True when a failure leaves this worker's OpenCV (WebAssembly) memory unsafe to use again.
 * This OpenCV build cannot catch C++ exceptions: a cv::Exception (or a failed allocation) leaves WebAssembly as a
 * bare number, skipping its clean-up, and its stack and heap are then left damaged. A WebAssembly.RuntimeError
 * (memory access out of bounds, an abort) means the same. Errors thrown by JavaScript code (sharp, onnxruntime, the
 * checks in this file) are ordinary Error objects and leave nothing damaged.
 */
export function isPoison(e: unknown): boolean {
  return !(e instanceof Error) || e instanceof WebAssembly.RuntimeError;
}

/** OpenCV (WebAssembly) throws a number: the address of its exception. */
function cvMessage(cv: Cv, e: unknown): string {
  try {
    if (typeof e === 'number' && cv?.exceptionFromPtr) return `OpenCV: ${cv.exceptionFromPtr(e).msg}`;
  } catch {
    /* fall through */
  }
  return `OpenCV failed: ${String(e)}`;
}
