/**
 * GET /healthz, which the Docker health check and outside monitoring call: 200 {"ok":true} when PostgreSQL and Redis
 * both answer, 503 naming the one that does not, whether it fails at once or hangs (each gets 2 seconds, side by side).
 * No sign-in, never cached, nothing of the error in the answer, and never the web app's page, which used to answer
 * /healthz with 200 whatever the state.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Ctx } from '../src/context.js';
import { createRedis } from '../src/lib/redis.js';
import { makeHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let webDir: string;
beforeAll(async () => {
  h = await makeHarness();
  // As on the server: the built web app answers every path it does not know with its page.
  webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-web-'));
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Event Photos</title>');
});
afterAll(async () => {
  await h.close();
  fs.rmSync(webDir, { recursive: true, force: true });
});

/** The app with the built web app, and with what is in `down` in place of the working database or Redis. */
const appWith = (down: Partial<Pick<Ctx, 'db' | 'redis'>> = {}) => createApp({ ...h.ctx, ...down }, { webDir });

/** A Redis client made as the app makes it, for a Redis on this port. */
function redisAt(port: number) {
  const redis = createRedis({ redisUrl: `redis://127.0.0.1:${port}`, redisPrefix: 'ept:healthz:' });
  redis.on('error', () => {}); // it keeps trying to connect until disconnected: expected here
  return redis;
}

/** A port nothing listens on: a stopped server. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

/** A server that takes connections and never answers: a hanging one. */
async function silentServer() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => void sockets.add(socket));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: (server.address() as net.AddressInfo).port,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((done) => server.close(done));
    },
  };
}

it('answers 200 {"ok":true} when PostgreSQL and Redis both answer, without a sign-in, and is never cached', async () => {
  const app = appWith();
  const res = await request(app).get('/healthz').expect(200);
  expect(res.headers['content-type']).toMatch(/^application\/json/);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({ ok: true });
  await request(app).get('/e/some-event').expect(200).expect(/<title>Event Photos<\/title>/); // the page is still there
});

it('answers 503 naming the database when PostgreSQL fails, with nothing of the error in the answer', async () => {
  const db: Ctx['db'] = {
    ...h.ctx.db,
    query: async () => {
      throw new Error('connect ECONNREFUSED 10.9.8.7:5432');
    },
  };
  const res = await request(appWith({ db })).get('/healthz').expect(503);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({ ok: false, failed: ['database'] });
  expect(res.text).not.toMatch(/ECONNREFUSED|10\.9\.8\.7/);
});

it('answers 503 naming Redis when it is stopped', async () => {
  const redis = redisAt(await closedPort());
  try {
    const res = await request(appWith({ redis })).get('/healthz').expect(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ ok: false, failed: ['redis'] });
  } finally {
    redis.disconnect();
  }
});

it('names both when both hang, in about 2 seconds: they are asked side by side, inside the 5-second health check', async () => {
  const silent = await silentServer();
  const redis = redisAt(silent.port);
  const db: Ctx['db'] = { ...h.ctx.db, query: () => new Promise<never>(() => {}) };
  try {
    const started = Date.now();
    const res = await request(appWith({ db, redis })).get('/healthz').expect(503);
    const took = Date.now() - started;
    expect(res.body).toEqual({ ok: false, failed: ['database', 'redis'] });
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(4000); // one after the other would take 4 seconds
  } finally {
    redis.disconnect();
    await silent.close();
  }
});
