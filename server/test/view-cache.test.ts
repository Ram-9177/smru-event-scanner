/**
 * The small view cache: thumbnails and main-view copies are kept on this server (up to IMG_CACHE_MB) so the album
 * opens fast. OneDrive stays the only real store: originals and videos are never cached, the cache never grows past
 * its cap, and a hidden photo is never served from it.
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyPath, makeEvent, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
let album: any[];
const FOLDER = 'Cache Day';
const dir = () => path.join(h.ctx.cfg.dataDir, 'cache');
const files = () => (fs.existsSync(dir()) ? fs.readdirSync(dir()) : []);
const used = () => files().reduce((n, f) => n + fs.statSync(path.join(dir(), f)).size, 0);

/** Waits until the background fill has written the expected number of files. */
async function waitFiles(n: number) {
  for (let i = 0; i < 100 && files().length < n; i++) await new Promise((r) => setTimeout(r, 20));
}

let CAP = 0;

beforeAll(async () => {
  h = await makeHarness({ viewCacheBytes: 10 * 1024 * 1024 });
  event = await makeEvent(h, FOLDER, FOLDER);
  for (let i = 0; i < 4; i++) h.put(FOLDER, `p${i}.jpg`, await makePhoto(700 + i, [{ person: i % 2 ? PERSON.red : PERSON.blue }]));
  await syncNow(h, event.id);
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
  await settle(h);
  album = (await phone(h, 'v').get(`/api/e/${event.slug}/album`).expect(200)).body.photos;
});
afterAll(async () => {
  await h.close();
});

describe('the view cache', () => {
  it('first view goes to OneDrive, then the copy is served from this server with the same bytes', async () => {
    const p = album[0];
    await request(h.app).get(p.thumb).redirects(0).expect(302);
    await waitFiles(1);
    const res = await request(h.app).get(p.thumb).buffer(true).parse((r, cb) => {
      const c: Buffer[] = [];
      r.on('data', (d: Buffer) => c.push(d));
      r.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-served-from']).toBe('cache');
    const row = (await h.ctx.db.query<any>(`select thumb_key from media where id = $1`, [p.id])).rows[0];
    expect((res.body as Buffer).equals(fs.readFileSync(copyPath(h, row.thumb_key)))).toBe(true);
  });

  it('only thumbnails and main-view copies are kept: never originals or anything else', async () => {
    for (const p of album) {
      await request(h.app).get(p.thumb).redirects(0);
      await request(h.app).get(p.web).redirects(0);
    }
    await new Promise((r) => setTimeout(r, 300));
    const keys = (await h.ctx.db.query<any>(`select thumb_key, web_key from media where event_id = $1`, [event.id])).rows
      .flatMap((r) => [r.thumb_key, r.web_key])
      .filter(Boolean)
      .map((k: string) => k.split('/')[1]);
    for (const f of files()) expect(keys).toContain(f.replace(/\.[^.]+$/, ''));
    expect(files().every((f) => /\.(webp|jpg|jpeg|png)$/.test(f))).toBe(true);
  });

  it('a hidden photo is never served from the cache', async () => {
    const p = album[1];
    await request(h.app).get(p.thumb).redirects(0);
    await new Promise((r) => setTimeout(r, 200));
    await h.ctx.db.query(`update media set hidden = true where id = $1`, [p.id]);
    await request(h.app).get(p.thumb).expect(404);
    await h.ctx.db.query(`update media set hidden = false where id = $1`, [p.id]);
  });

  it('never grows past its cap: the least recently viewed copies are dropped', async () => {
    CAP = Math.max(...files().map((f) => fs.statSync(path.join(dir(), f)).size)) * 2 + 10;
    const small = await makeHarness({ viewCacheBytes: CAP });
    try {
      const ev = await makeEvent(small, 'Cap Day', 'Cap Day');
      for (let i = 0; i < 4; i++) small.put('Cap Day', `c${i}.jpg`, await makePhoto(720 + i, [{ person: PERSON.green }]));
      await syncNow(small, ev.id);
      await small.admin.patch(`/api/admin/events/${ev.id}`).send({ status: 'live' }).expect(200);
      await settle(small);
      const photos = (await phone(small, 'w').get(`/api/e/${ev.slug}/album`).expect(200)).body.photos;
      const sdir = path.join(small.ctx.cfg.dataDir, 'cache');
      for (const p of photos) {
        await request(small.app).get(p.thumb).redirects(0);
        await new Promise((r) => setTimeout(r, 150));
      }
      const sizes = (fs.existsSync(sdir) ? fs.readdirSync(sdir) : []).map((f) => fs.statSync(path.join(sdir, f)).size);
      expect(sizes.length).toBeGreaterThan(0);
      expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(CAP);
    } finally {
      await small.close();
    }
  });

  it('an album opening (many views at once) gets every copy into the cache, a few at a time, none skipped', async () => {
    const burst = await makeHarness({ viewCacheBytes: 50 * 1024 * 1024 });
    try {
      const ev = await makeEvent(burst, 'Burst Day', 'Burst Day');
      for (let i = 0; i < 6; i++) burst.put('Burst Day', `b${i}.jpg`, await makePhoto(760 + i, [{ person: i % 2 ? PERSON.red : PERSON.blue }]));
      await syncNow(burst, ev.id);
      await burst.admin.patch(`/api/admin/events/${ev.id}`).send({ status: 'live' }).expect(200);
      await settle(burst);
      const photos = (await phone(burst, 'b').get(`/api/e/${ev.slug}/album`).expect(200)).body.photos;
      expect(photos.length).toBe(6);
      // every thumbnail and main view asked for at the same moment, as a phone does when the album opens
      await Promise.all(photos.flatMap((p: any) => [request(burst.app).get(p.thumb).redirects(0), request(burst.app).get(p.web).redirects(0)]));
      const rows = (await burst.ctx.db.query<any>(`select thumb_key, web_key from media where event_id = $1`, [ev.id])).rows;
      const wanted = new Set(rows.flatMap((r) => [r.thumb_key, r.web_key]).filter(Boolean).map((k: string) => k.split('/')[1]));
      expect(wanted.size).toBeGreaterThan(3); // more than are fetched at once
      const bdir = path.join(burst.ctx.cfg.dataDir, 'cache');
      const cached = () => new Set((fs.existsSync(bdir) ? fs.readdirSync(bdir) : []).map((f) => f.replace(/\.[^.]+$/, '')));
      for (let i = 0; i < 200 && cached().size < wanted.size; i++) await new Promise((r) => setTimeout(r, 25));
      expect([...cached()].sort()).toEqual([...wanted].sort());
      // and the next views are all served from this server
      const again = await Promise.all(photos.map((p: any) => request(burst.app).get(p.thumb).redirects(0)));
      expect(again.map((r) => r.headers['x-served-from'])).toEqual(photos.map(() => 'cache'));
    } finally {
      await burst.close();
    }
  });

  it('with IMG_CACHE_MB=0 nothing is kept on this server', async () => {
    const off = await makeHarness({ viewCacheBytes: 0 });
    try {
      const ev = await makeEvent(off, 'Off Day', 'Off Day');
      off.put('Off Day', 'o.jpg', await makePhoto(740, [{ person: PERSON.red }]));
      await syncNow(off, ev.id);
      await off.admin.patch(`/api/admin/events/${ev.id}`).send({ status: 'live' }).expect(200);
      await settle(off);
      const [p] = (await phone(off, 'o').get(`/api/e/${ev.slug}/album`).expect(200)).body.photos;
      await request(off.app).get(p.thumb).redirects(0).expect(302);
      await request(off.app).get(p.thumb).redirects(0).expect(302);
      expect(fs.existsSync(path.join(off.ctx.cfg.dataDir, 'cache'))).toBe(false);
    } finally {
      await off.close();
    }
  });

  it('the cache stays well under its cap here', () => {
    expect(used()).toBeLessThanOrEqual(10 * 1024 * 1024);
  });
});
