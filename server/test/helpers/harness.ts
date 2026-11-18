import { remakesIdle } from '../../src/media/upgrade.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createContext, type Ctx } from '../../src/context.js';
import type { Mail, Mailer } from '../../src/lib/mail.js';
import { createRedis, dropPrefix } from '../../src/lib/redis.js';
import { openTestDb, testId, TEST_DATABASE_URL, TEST_REDIS_URL } from './db.js';
import type { Drive } from '../../src/drive/index.js';
import { LocalDrive } from '../../src/drive/index.js';
export { videosIdle };
import { stubFace } from './stub-face.js';
import { setDiskProbe } from '../../src/ops/disk.js';
import { COPIES_FOLDER, copiesIdle, emptyCopyTrash, isDriveKey, itemOf } from '../../src/media/copies.js';
import { rebuildIdle } from '../../src/media/rebuild.js';
import { videosIdle } from '../../src/media/video.js';
import { expect } from 'vitest';

// The tests must not depend on how full this Mac's disk is: they see a roomy disk unless a test sets its own.
setDiskProbe(async () => ({ free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 }));

export const ADMIN = { email: 'organiser@college.test', password: 'a-long-test-password' };

export interface Harness {
  ctx: Ctx;
  app: ReturnType<typeof createApp>;
  /** The folder that stands in for Apps > Event Photos. */
  driveDir: string;
  face: ReturnType<typeof stubFace>;
  /** Every email the app sent (newest last). */
  mail: Mail[];
  /** A signed-in organiser. */
  admin: ReturnType<typeof request.agent>;
  /** Write a file into an event folder of the stand-in drive. */
  put(folder: string, name: string, data: Buffer): string;
  close(): Promise<void>;
}

/**
 * A fresh app for one test file: its own temp folder, its own empty PostgreSQL schema, its own Redis key prefix,
 * an email outbox it can read, and the stand-in face engine.
 */
export async function makeHarness(overrides: Partial<Config> = {}, opts: { drive?: (ctxDir: string) => Drive; driveDir?: string } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-test-'));
  const id = testId();
  const driveDir = opts.driveDir ?? path.join(dir, 'drive');
  const cfg = loadConfig(
    {},
    {
      dataDir: path.join(dir, 'data'),
      localDriveDir: driveDir,
      databaseUrl: TEST_DATABASE_URL,
      redisUrl: TEST_REDIS_URL,
      redisPrefix: `ept:${id}:`,
      sessionSecret: 'test-secret-that-is-long-enough-for-tests',
      publicUrl: 'https://photos.college.test',
      adminEmail: ADMIN.email,
      adminPassword: ADMIN.password,
      orgName: 'Test College',
      workers: 3,
      viewCacheBytes: 0, // the local view cache is off unless a test turns it on
      machine: 'Mac', // the wording the tests expect wherever they run (the app says 'server' on anything but macOS)
      ...overrides,
    },
  );
  const db = await openTestDb(id);
  const redis = createRedis(cfg);
  const mail: Mail[] = [];
  const mailer: Mailer = {
    configured: true,
    async send(m) {
      mail.push(m);
      return true;
    },
  };
  const face = stubFace();
  // drive: 'graph' in the overrides = the real OneDrive adapter (pointed at the imitation of Microsoft's endpoints)
  const drive = opts.drive ? opts.drive(dir) : cfg.drive === 'graph' ? undefined : new LocalDrive(driveDir);
  const ctx = await createContext(cfg, { db, face, drive, redis, mailer, quiet: !process.env.TEST_LOUD });
  const app = createApp(ctx, { webDir: path.join(dir, 'no-web') });
  const admin = request.agent(app);
  await admin.post('/api/admin/login').send(ADMIN).expect(200);
  return {
    ctx,
    app,
    driveDir,
    face,
    mail,
    admin,
    put(folder, name, data) {
      const abs = path.join(driveDir, folder, name);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      return abs;
    },
    async close() {
      await ctx.close();
      await dropPrefix(redis, cfg.redisPrefix);
      redis.disconnect();
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Create an event through the API and link it to a folder of the stand-in drive. */
export async function makeEvent(h: Harness, title: string, folder?: string, extra: Record<string, unknown> = {}): Promise<any> {
  const made = await h.admin.post('/api/admin/events').send({ title, starts_on: '2026-11-20', venue: 'Main hall', ...extra }).expect(201);
  let event = made.body.event;
  if (folder) {
    fs.mkdirSync(path.join(h.driveDir, folder), { recursive: true });
    const folders = (await h.admin.get('/api/admin/onedrive/folders').expect(200)).body.folders;
    const f = folders.find((x: any) => x.name === folder);
    event = (await h.admin.patch(`/api/admin/events/${event.id}`).send({ onedrive_folder_id: f.id }).expect(200)).body.event;
  }
  return event;
}

/** Sync now and wait for it to finish; returns the progress counters. */
export async function syncNow(h: Harness, eventId: string): Promise<any> {
  const { syncEvent } = await import('../../src/sync/sync.js');
  const summary = await syncEvent(h.ctx, eventId);
  const progress = (await h.admin.get(`/api/admin/events/${eventId}/progress`).expect(200)).body;
  return { summary, ...progress };
}

/** A student's phone: no login, just the random token it keeps. */
export function phone(h: Harness, name: string) {
  const token = `${name}-device-token-0123456789`;
  const on = (r: request.Test) => r.set('x-device', token);
  return {
    token,
    get: (url: string) => on(request(h.app).get(url)),
    post: (url: string) => on(request(h.app).post(url)),
    del: (url: string) => on(request(h.app).delete(url)),
    selfie: (slug: string, image: Buffer) => on(request(h.app).post(`/api/e/${slug}/selfie`)).set('x-consent', 'v1').set('content-type', 'image/jpeg').send(image),
    upload: (slug: string, image: Buffer, mime = 'image/jpeg', by?: string) => {
      const r = on(request(h.app).post(`/api/e/${slug}/uploads`)).set('content-type', mime);
      if (by) r.set('x-uploader-name', encodeURIComponent(by));
      return r.send(image);
    },
  };
}

/**
 * Everything in the background is done: the photo workers, album copies being made again (Improve photos), the
 * copies work (the trash emptied, clean video copies, rekeys, a rebuild pass).
 */
export const settle = async (h: Harness) => {
  await h.ctx.work.idle();
  await remakesIdle();
  await h.ctx.work.idle();
  await rebuildIdle(h.ctx);
  await copiesIdle(h.ctx);
  // Copies a test took out of the database by hand (SQL) are queued too: removed now, as the 10-minute pass would.
  await emptyCopyTrash(h.ctx).catch(() => 0);
};

/** Where a copy (an od/ key) is in the stand-in drive; a path that is not there when the copy is gone. */
export function copyPath(h: Harness, key: string): string {
  if (!isDriveKey(key)) return path.join(h.ctx.cfg.dataDir, key);
  try {
    return (h.ctx.drive as LocalDrive).pathOf(itemOf(key));
  } catch {
    return path.join(h.driveDir, '__gone__', key.replace(/\//g, '_'));
  }
}

/** The files in one copies folder of an event (t, w, v, s, clean, full) in the stand-in drive. */
export function copyFiles(h: Harness, eventId: string, kind: string): string[] {
  const dir = path.join(h.driveDir, COPIES_FOLDER, eventId, kind);
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/**
 * Load an album image link as a browser does: the app answers 302 to the copy (a short-lived OneDrive link; in tests
 * the stand-in drive's /_drive link), which is followed. Returns what the browser ends up with.
 */
export async function fetchImage(
  h: Harness,
  url: string,
  opts: { range?: string; agent?: ReturnType<typeof request.agent> } = {},
): Promise<{ status: number; type: string; body: Buffer; cache: string | null; redirected: boolean; headers: Record<string, string> }> {
  const first = await (opts.agent ?? request(h.app)).get(url).redirects(0).buffer(true).parse(binary);
  if (first.status !== 302) return { status: first.status, type: String(first.headers['content-type'] ?? ''), body: first.body, cache: first.headers['cache-control'] ?? null, redirected: false, headers: first.headers };
  const loc = String(first.headers.location);
  expect(loc).toMatch(/^\/_drive\//);
  let next = request(h.app).get(loc).buffer(true).parse(binary);
  if (opts.range) next = next.set('range', opts.range);
  const res = await next;
  return { status: res.status, type: String(res.headers['content-type'] ?? ''), body: res.body, cache: first.headers['cache-control'] ?? null, redirected: true, headers: res.headers };
}

/**
 * The owner's rule, end to end: nothing of a photo or video is kept on this server. data/ holds no media/, full/ or
 * people/ folder, and data/tmp is empty once the background work is done; only keys, the outbox and the like remain.
 */
export async function expectNoLocalMedia(h: Harness): Promise<void> {
  await settle(h);
  const dir = h.ctx.cfg.dataDir;
  const ALLOWED = new Set(['tmp', 'jwt-rs256.pem', 'vapid.json', 'dev-secret', 'outbox']);
  const top = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  expect(top.filter((n) => !ALLOWED.has(n))).toEqual([]);
  const tmp = path.join(dir, 'tmp');
  expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toEqual([]);
}

/** The files of a ZIP stored without compression (as Download all makes it): name -> bytes, read from its central directory. */
export function zipFiles(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const skip = nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out.set(name, zip.subarray(data, data + size));
    at += 46 + skip;
  }
  return out;
}

/** Number of files in a ZIP, read from its end-of-central-directory record. */
export function zipEntries(zip: Buffer): number {
  const at = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  return at < 0 ? -1 : zip.readUInt16LE(at + 10);
}
