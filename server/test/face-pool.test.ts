import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { localFace } from '../src/face/local.js';
import { errorHandler } from '../src/lib/http.js';

/**
 * The worker pool of the face engine (local.ts), with a stand-in worker (helpers/fake-face-worker.mjs), so the
 * pool's own rules are tested quickly and without models: a damaged worker is replaced, a stuck job gives up,
 * too many waiting selfies are turned away, a worker that cannot be replaced is tried again.
 */
const FAKE = new URL('./helpers/fake-face-worker.mjs', import.meta.url);
const models = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-face-pool-'));
for (const f of ['face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec.onnx']) fs.writeFileSync(path.join(models, f), '');
const failStart = path.join(models, 'fail-start');

const engines: ReturnType<typeof localFace>[] = [];
function engine(opts: Partial<Parameters<typeof localFace>[0]> = {}) {
  const e = localFace({ modelsDir: models, workers: 1, workerUrl: FAKE, ...opts });
  engines.push(e);
  return e;
}
const job = (what: string) => Buffer.from(what);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('waited too long');
    await sleep(20);
  }
}

afterEach(async () => {
  fs.rmSync(failStart, { force: true });
  await Promise.all(engines.splice(0).map((e) => e.close()));
});
afterAll(() => fs.rmSync(models, { recursive: true, force: true }));

describe('face engine worker pool', () => {
  it('keeps the name of a worker error, so an unreadable selfie is a 400, not a server error', async () => {
    const face = engine();
    const err = await face.selfie(job('bad')).catch((e: Error) => e);
    expect((err as Error).name).toBe('BadImageError');

    const logged: string[] = [];
    const app = express();
    app.post('/selfie', express.raw({ type: () => true }), async (req, res, next) => {
      try {
        res.json(await face.selfie(req.body));
      } catch (e) {
        next(e);
      }
    });
    app.use(errorHandler((msg) => logged.push(msg)));
    const res = await request(app).post('/selfie').set('content-type', 'text/plain').send('bad').expect(400);
    expect(res.body.error).toBe('bad_photo');
    expect(res.body.message).toBe('That photo could not be read. Try a JPG or PNG photo.');
    expect(logged).toEqual([]); // not logged as an unhandled error
  });

  it('replaces a worker whose OpenCV memory is damaged; the photos waiting behind it are not failed', async () => {
    const face = engine();
    const before = (await face.selfie(job('ok')))!.faces;
    const poisoned = face.selfie(job('poison')).catch((e: Error) => e);
    const behind = [face.selfie(job('ok')), face.fingerprint(job('ok')).then(() => null), face.selfie(job('ok'))];
    const err = (await poisoned) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe('FaceDownError'); // the photo that broke it fails for good: retrying would break the next worker
    const after = await Promise.all(behind);
    expect(after[0]!.faces).not.toBe(before); // a fresh worker did them
    expect(after[2]!.faces).toBe(after[0]!.faces);
    expect(await face.health()).toBe(true);
    expect(face.stats().workers).toBe(1);
  });

  it('gives up on a job that takes too long and replaces its worker, so the work behind it carries on', async () => {
    const face = engine({ jobTimeoutMs: 300 });
    const stuck = face.selfie(job('hang')).catch((e: Error) => e);
    const next = face.selfie(job('ok'));
    expect(((await stuck) as Error).message).toBe('The photo took too long to read.');
    expect((await next)!.vector).toHaveLength(128);
    expect(face.stats().workers).toBe(1);
  });

  it('turns selfies away when too many are waiting, but never the server\'s own photo work', async () => {
    const face = engine({ maxWaiting: 2 });
    const running = face.selfie(job('sleep:400'));
    await sleep(50); // it is on the worker now
    const waiting = [face.selfie(job('ok')), face.selfie(job('ok'))];
    const turned = await face.selfie(job('ok')).catch((e: Error) => e);
    expect((turned as Error).name).toBe('FaceDownError'); // the route answers 503 busy
    expect(face.stats().waiting).toBe(2);
    const own = face.fingerprint(job('ok')); // reading event photos is limited by its own callers
    await Promise.all([running, ...waiting, own]);
    expect(face.stats()).toMatchObject({ waiting: 0, waitingBytes: 0 });
    expect(await face.selfie(job('ok'))).not.toBeNull();
  });

  it('turns selfies away when the photos waiting are too large in all', async () => {
    const face = engine({ maxWaitingBytes: 1000 });
    const running = face.selfie(job('sleep:300'));
    await sleep(50);
    const first = face.selfie(Buffer.alloc(900, 1));
    const turned = await face.selfie(Buffer.alloc(200, 1)).catch((e: Error) => e);
    expect((turned as Error).name).toBe('FaceDownError');
    await Promise.all([running, first]);
  });

  it('tries again to replace a worker that could not be started, until the pool is full again', async () => {
    const face = engine({ workers: 2 });
    expect(await face.health()).toBe(true);
    expect(face.stats().workers).toBe(2);
    fs.writeFileSync(failStart, '');
    await face.selfie(job('die')).catch(() => undefined);
    await until(() => face.stats().workers === 1 && face.stats().starting === 0);
    await sleep(100); // the replacement failed; the pool works on with one worker
    expect(face.stats().workers).toBe(1);
    expect(await face.selfie(job('ok'))).not.toBeNull();
    fs.rmSync(failStart);
    await until(() => face.stats().workers === 2);
    await sleep(1500); // and no more than its size
    expect(face.stats().workers).toBe(2);
  });

  it('when no worker is left and none can start, waiting work fails with FaceDownError and the next call starts again', async () => {
    const face = engine();
    expect(await face.health()).toBe(true);
    fs.writeFileSync(failStart, '');
    const dying = face.selfie(job('die')).catch((e: Error) => e);
    const waiting = face.selfie(job('ok')).catch((e: Error) => e);
    expect(((await dying) as Error).name).not.toBe('FaceDownError');
    expect(((await waiting) as Error).name).toBe('FaceDownError');
    expect(await face.health()).toBe(false);
    fs.rmSync(failStart);
    expect(await face.health()).toBe(true);
    expect(await face.selfie(job('ok'))).not.toBeNull();
  });
});
