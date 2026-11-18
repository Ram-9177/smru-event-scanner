import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { WireFace, WireScene, WorkInit, WorkRequest } from './face-worker.js';
import { FaceDownError, type FaceEngine, type FoundFace, type SceneMatch } from './index.js';

/**
 * The face engine inside the server: YuNet + SFace (onnxruntime) and OpenCV (WebAssembly) in a few worker threads,
 * so the event loop never waits for face work. It does what face-service/app.py did, with the same numbers.
 * The workers start on the first call (or health()) and are closed with close().
 */
export interface LocalFaceOptions {
  /** The folder with face_detection_yunet_2023mar.onnx and face_recognition_sface_2021dec.onnx. */
  modelsDir: string;
  /** Worker threads; each does one photo at a time. Default 2. */
  workers?: number;
  /** Stored with every vector. Default 'sface_2021dec', the Python service's name: its vectors stay comparable. */
  model?: string;
  /** onnxruntime threads per worker. Default: the cores shared between the workers, at most 4. */
  threads?: number;
  /** A selfie is turned away (FaceDownError: "busy, try again") when this many jobs are already waiting. Default 40. */
  maxWaiting?: number;
  /** ... or when the photos waiting take this many bytes. Default 200 MB. */
  maxWaitingBytes?: number;
  /** A job that runs longer than this fails, and its worker is replaced. Default 2 minutes. */
  jobTimeoutMs?: number;
  /** Tests only: another worker script, speaking the same messages as face-worker.ts. */
  workerUrl?: URL;
}

const MODEL_FILES = ['face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec.onnx'];

/**
 * The worker's file next to this one: face-worker.js when compiled (dist), face-worker.ts when run from the sources
 * (tsx, vitest). A .ts worker is loaded by tsx's loader when the parent has it (its flags are passed on in execArgv),
 * otherwise by Node's own type stripping (Node 22.18+ / 23.6+).
 */
function workerUrl(): URL {
  const js = new URL('./face-worker.js', import.meta.url);
  if (fs.existsSync(fileURLToPath(js))) return js;
  return new URL('./face-worker.ts', import.meta.url);
}

type Op = WorkRequest['op'];
interface Job {
  op: Op;
  jpeg?: Uint8Array;
  a?: Uint8Array;
  b?: Uint8Array;
  minFace?: number;
  bytes: number;
  resolve(v: unknown): void;
  reject(e: Error): void;
}
interface Slot {
  worker: Worker;
  ready: boolean;
  /** Taken out of the pool: whatever it still says is ignored. */
  retired: boolean;
  job: Job | null;
  jobId: number;
  timer: NodeJS.Timeout | null;
}

/** A private copy of the bytes, so it can be moved to the worker without copying the caller's buffer pool. */
function own(b: Uint8Array): Uint8Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return copy;
}

/** A failed job's error as the worker named it (BadImageError for a photo that cannot be read). */
function workError(msg: any): Error {
  const err = new Error(msg?.message || 'face work failed');
  if (typeof msg?.name === 'string' && msg.name) err.name = msg.name;
  return err;
}

export interface LocalFaceStats {
  /** Workers ready for work. */
  workers: number;
  /** Replacement workers being started. */
  starting: number;
  /** Jobs waiting for a worker, and the bytes they hold. */
  waiting: number;
  waitingBytes: number;
}

export function localFace(opts: LocalFaceOptions): FaceEngine & { close(): Promise<void>; stats(): LocalFaceStats } {
  const size = Math.max(1, Math.floor(opts.workers ?? 2));
  const threads = Math.max(1, Math.floor(opts.threads ?? Math.min(4, Math.floor(os.availableParallelism() / size))));
  const maxWaiting = Math.max(1, Math.floor(opts.maxWaiting ?? 40));
  const maxWaitingBytes = Math.max(1, opts.maxWaitingBytes ?? 200 * 1024 * 1024);
  const jobTimeoutMs = Math.max(1, opts.jobTimeoutMs ?? 120_000);
  const init: WorkInit = { modelsDir: path.resolve(opts.modelsDir), threads };
  const slots: Slot[] = [];
  const queue: Job[] = [];
  let waitingBytes = 0;
  let starting: Promise<void> | null = null;
  let closed = false;
  let nextId = 1;
  let replacing = 0; // replacement workers being started
  let failedInARow = 0; // replacements that could not start, one after another
  let retry: NodeJS.Timeout | null = null;

  function spawn(): Promise<Slot> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(opts.workerUrl ?? workerUrl(), { workerData: { faceWorker: init }, execArgv: process.execArgv });
      } catch (e) {
        reject(e as Error);
        return;
      }
      const slot: Slot = { worker, ready: false, retired: false, job: null, jobId: 0, timer: null };
      worker.unref(); // an idle engine does not keep the process alive; a busy one does (see pump)
      worker.on('message', (msg: any) => {
        if (slot.retired) return;
        if (!slot.ready) {
          if (msg?.ready) {
            slot.ready = true;
            resolve(slot);
          } else {
            slot.retired = true;
            void worker.terminate();
            reject(new Error(msg?.message || 'the face worker did not start'));
          }
          return;
        }
        const job = slot.job;
        if (!job || msg?.id !== slot.jobId) return;
        free(slot);
        if (msg.ok) job.resolve(msg.result);
        else job.reject(workError(msg));
        // OpenCV failed in a way that damages the worker's memory: every later photo would fail there. Replace it.
        if (msg.poisoned) retire(slot, msg.message || 'OpenCV failed');
        else pump();
      });
      worker.on('error', (e) => {
        if (!slot.ready) reject(e as Error);
        else retire(slot, (e as Error).message);
      });
      worker.on('exit', (code) => {
        if (!slot.ready) reject(new Error(`the face worker stopped (exit code ${code})`));
        else retire(slot, `the face worker stopped (exit code ${code})`);
      });
    });
  }

  /** The slot's job is over (answered, failed or given up on). */
  function free(slot: Slot) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    slot.worker.unref();
  }

  /**
   * A worker is out of the pool: it died, its memory is damaged, or its job took too long. Its job (if any) fails,
   * the worker is stopped and a new one takes its place. Jobs still waiting are not touched: they go to the others.
   */
  function retire(slot: Slot, why: string, jobError?: Error) {
    slot.retired = true;
    const i = slots.indexOf(slot);
    if (i < 0) return;
    slots.splice(i, 1);
    slot.ready = false;
    slot.retired = true;
    const job = slot.job;
    free(slot);
    job?.reject(jobError ?? new Error(`Face work failed: ${why}`));
    void slot.worker.terminate();
    replace();
  }

  /** Bring the pool back to its size, one worker at a time; a worker that cannot start is tried again later. */
  function replace() {
    if (closed || !starting || retry) return; // not started (start() builds the whole pool), or a retry is waiting
    if (slots.length + replacing >= size) return;
    replacing++;
    spawn().then(
      (s) => {
        replacing--;
        failedInARow = 0;
        if (closed || slots.length >= size) {
          s.retired = true;
          void s.worker.terminate();
          return;
        }
        slots.push(s);
        pump();
        replace();
      },
      (err: Error) => {
        replacing--;
        failedInARow++;
        if (closed) return;
        if (!slots.length && !replacing) {
          // nothing left to do the work: what waits fails now (and is tried again later); the next call starts again
          starting = null;
          failedInARow = 0;
          rejectWaiting(new FaceDownError(`The face engine stopped: ${err.message}`));
          return;
        }
        retry = setTimeout(() => {
          retry = null;
          replace();
        }, Math.min(30_000, 500 * 2 ** Math.min(failedInARow - 1, 6)));
        retry.unref();
      },
    );
  }

  function rejectWaiting(e: Error) {
    waitingBytes = 0;
    for (const j of queue.splice(0)) j.reject(e);
  }

  function start(): Promise<void> {
    if (closed) return Promise.reject(new FaceDownError('The face engine is closed.'));
    if (!starting) {
      starting = (async () => {
        const missing = MODEL_FILES.filter((f) => !fs.existsSync(path.join(init.modelsDir, f)));
        if (missing.length) {
          throw new FaceDownError(`The face models are missing in ${init.modelsDir}: ${missing.join(', ')}. npm run launch downloads them, or set FACE_MODELS to the folder that has them.`);
        }
        const started = await Promise.allSettled(Array.from({ length: size }, () => spawn()));
        const ok = started.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
        const bad = started.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (bad || closed) {
          await Promise.all(ok.map((s) => s.worker.terminate()));
          throw new FaceDownError(closed ? 'The face engine is closed.' : `The face engine could not start: ${(bad!.reason as Error)?.message ?? bad!.reason}`);
        }
        slots.push(...ok.filter((s) => !s.retired)); // one that stopped meanwhile is replaced below
        replace();
      })();
      starting.catch(() => {
        starting = null; // tried again on the next call
      });
    }
    return starting;
  }

  function pump() {
    for (const slot of slots) {
      if (!queue.length) return;
      if (!slot.ready || slot.job) continue;
      const job = queue.shift()!;
      waitingBytes -= job.bytes;
      slot.job = job;
      slot.jobId = nextId++;
      const req: WorkRequest = { id: slot.jobId, op: job.op, jpeg: job.jpeg, a: job.a, b: job.b, minFace: job.minFace };
      const transfer = [job.jpeg, job.a, job.b].flatMap((x) => (x ? [x.buffer as ArrayBuffer] : []));
      slot.worker.ref();
      try {
        slot.worker.postMessage(req, transfer);
      } catch (e) {
        free(slot);
        job.reject(e as Error);
        continue;
      }
      // A worker that does not answer in time is replaced, so the work behind it is not stuck.
      slot.timer = setTimeout(() => {
        if (slot.job !== job) return;
        retire(slot, `${job.op} took longer than ${Math.round(jobTimeoutMs / 1000)} s`, Object.assign(new Error('The photo took too long to read.'), { name: 'FaceTimeoutError' }));
      }, jobTimeoutMs);
      slot.timer.unref();
    }
  }

  /**
   * One job for the pool. Its bytes are copied (see own) once it is accepted.
   * turnAway: a job that may be refused when too much is waiting (a guest's selfie); the server's own work
   * (photos being read) is limited by its callers and always waits its turn.
   */
  async function run<T>(op: Op, fields: Pick<Job, 'jpeg' | 'a' | 'b' | 'minFace'>, turnAway = false): Promise<T> {
    await start();
    const bytes = (fields.jpeg?.byteLength ?? 0) + (fields.a?.byteLength ?? 0) + (fields.b?.byteLength ?? 0);
    if (turnAway && (queue.length >= maxWaiting || waitingBytes + bytes > maxWaitingBytes)) {
      throw new FaceDownError(`The face engine is busy: ${queue.length} photos are waiting.`);
    }
    const job: Omit<Job, 'resolve' | 'reject'> = {
      op,
      jpeg: fields.jpeg && own(fields.jpeg),
      a: fields.a && own(fields.a),
      b: fields.b && own(fields.b),
      minFace: fields.minFace,
      bytes,
    };
    return new Promise<T>((resolve, reject) => {
      queue.push({ ...job, resolve: resolve as (v: unknown) => void, reject });
      waitingBytes += bytes;
      pump();
    });
  }

  return {
    model: opts.model ?? 'sface_2021dec',
    async health() {
      try {
        await start();
        return slots.length > 0;
      } catch {
        return false;
      }
    },
    stats() {
      return { workers: slots.length, starting: replacing, waiting: queue.length, waitingBytes };
    },
    async fingerprint(jpeg) {
      const h = await run<Uint8Array>('fingerprint', { jpeg });
      return Buffer.from(h.buffer, h.byteOffset, h.byteLength);
    },
    async faces(jpeg, minFacePx) {
      const faces = await run<WireFace[]>('faces', { jpeg, minFace: minFacePx });
      return faces.map(
        (f): FoundFace => ({ x: f.box[0], y: f.box[1], w: f.box[2], h: f.box[3], score: f.score, vector: f.vector }),
      );
    },
    async selfie(jpeg) {
      return run<{ vector: Float32Array; faces: number } | null>('selfie', { jpeg }, true);
    },
    async scene(jpeg) {
      const s = await run<{ desc: Uint8Array; sharpness: number }>('scene', { jpeg });
      return { desc: Buffer.from(s.desc.buffer, s.desc.byteOffset, s.desc.byteLength), sharpness: s.sharpness };
    },
    async compare(a, b) {
      const m = await run<WireScene>('compare', { a, b });
      return m satisfies SceneMatch;
    },
    async close() {
      closed = true;
      if (retry) clearTimeout(retry);
      retry = null;
      rejectWaiting(new FaceDownError('The face engine is closed.'));
      await starting?.catch(() => undefined);
      const all = slots.splice(0);
      for (const s of all) {
        s.ready = false;
        s.retired = true;
        const job = s.job;
        free(s);
        job?.reject(new FaceDownError('The face engine is closed.'));
      }
      await Promise.all(all.map((s) => s.worker.terminate()));
    },
  };
}
