/**
 * The image route with the copies in OneDrive: the signed link and the "is it visible" check stay on this server;
 * only then is the phone sent (302) to a short-lived OneDrive link (in tests the stand-in drive's /_drive link), or
 * the bytes stream through (pipe=1). Links are cached in Redis while at least 20 minutes of them are left.
 */
import fs from 'node:fs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DriveDownError } from '../src/drive/types.js';
import { itemOf } from '../src/media/copies.js';
import { clearFlag, hasFlag, purgeUrls, setFlag, setUrlClock, warmFolder } from '../src/media/copyurls.js';
import { copyPath, expectNoLocalMedia, fetchImage, makeEvent, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { binary } from './helpers/media.js';
import { makePhoto, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
const FOLDER = 'Serving Day';
let album: any[];
const viewer = () => phone(h, 'viewer');

/** Every call to the drive the image route could make, counted. */
function spyDrive() {
  const calls = { item: 0, children: 0, read: 0 };
  const d = h.ctx.drive as any;
  const real = { item: d.item.bind(d), children: d.children.bind(d), read: d.read.bind(d) };
  d.item = (...a: any[]) => (calls.item++, real.item(...a));
  d.children = (...a: any[]) => (calls.children++, real.children(...a));
  d.read = (...a: any[]) => (calls.read++, real.read(...a));
  return { calls, restore: () => Object.assign(d, real) };
}

/** Forget every cached link of the event (and the "listed lately" marks), as after 20 quiet minutes. */
async function coldCache() {
  const rows = (await h.ctx.db.query<any>(`select thumb_key, web_key from media where event_id = $1`, [event.id])).rows;
  await purgeUrls(h.ctx, rows.flatMap((r) => [r.thumb_key, r.web_key]).filter(Boolean).map(itemOf));
  const folders = (await h.ctx.db.query<any>(`select copies_folders from events where id = $1`, [event.id])).rows[0].copies_folders;
  for (const id of Object.values(folders)) await h.ctx.redis.del(`cuw:${id}`);
}

beforeAll(async () => {
  h = await makeHarness();
  event = await makeEvent(h, FOLDER, FOLDER, { crowd_uploads: true });
  for (let i = 0; i < 6; i++) h.put(FOLDER, `IMG_${i}.jpg`, await makePhoto(500 + i, [{ person: i % 2 ? PERSON.red : PERSON.blue }]));
  await syncNow(h, event.id);
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
  await settle(h);
  album = (await viewer().get(`/api/e/${event.slug}/album`).expect(200)).body.photos;
});
afterEach(async () => {
  setUrlClock(null);
  await clearFlag(h.ctx, 'drive:down');
  await clearFlag(h.ctx, 'drive:throttled');
});
afterAll(async () => {
  await expectNoLocalMedia(h);
  await h.close();
});

describe('the album', () => {
  it('gets a 302 to the copy in OneDrive, kept 5 minutes by a student\'s browser and never by an organiser\'s', async () => {
    const res = await request(h.app).get(album[0].thumb).redirects(0).expect(302);
    expect(res.headers.location).toMatch(/^\/_drive\/[^?]+\?e=\d+&s=/);
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const img = await fetchImage(h, album[0].web);
    expect(img).toMatchObject({ status: 200, redirected: true });
    expect(img.type).toMatch(/^image\/webp/);
    const row = (await h.ctx.db.query<any>(`select web_key from media where id = $1`, [album[0].id])).rows[0];
    expect(img.body.equals(fs.readFileSync(copyPath(h, row.web_key)))).toBe(true);

    const admin = (await h.admin.get(`/api/admin/events/${event.id}/media?limit=10`).expect(200)).body.media[0];
    const a = await request(h.app).get(admin.thumb).redirects(0).expect(302);
    expect(a.headers['cache-control']).toBe('private, no-store');
  });

  it('refuses a changed or expired link (403), and a hidden, waiting or copy photo (404), before any OneDrive call', async () => {
    const spy = spyDrive();
    try {
      await request(h.app).get(album[1].thumb.replace(/s=.{4}/, 's=AAAA')).expect(403);
      await request(h.app).get(album[1].thumb.replace(/e=\d+/, 'e=1000')).expect(403);
      await h.admin.patch('/api/admin/media').send({ ids: [album[1].id], action: 'hide' }).expect(200);
      await request(h.app).get(album[1].thumb).redirects(0).expect(404);
      await request(h.app).get(album[1].web).redirects(0).expect(404);
      // a student's upload still waiting for review
      const up = (await phone(h, 'volunteer').upload(event.slug, await makePhoto(560, [{ person: PERSON.green }])).expect(201)).body;
      await settle(h);
      const { imageUrl } = await import('../src/lib/links.js');
      await request(h.app).get(imageUrl(h.ctx.cfg, up.id, 't')).redirects(0).expect(404);
      // a copy (duplicate)
      await h.ctx.db.query(`update media set duplicate_of = $2 where id = $1`, [album[2].id, album[3].id]);
      await request(h.app).get(album[2].thumb).redirects(0).expect(404);
      await h.ctx.db.query(`update media set duplicate_of = null where id = $1`, [album[2].id]);
      expect(spy.calls).toMatchObject({ item: 0, read: 0 }); // the permission check came first
    } finally {
      spy.restore();
      await h.admin.patch('/api/admin/media').send({ ids: [album[1].id], action: 'unhide' }).expect(200);
      await settle(h);
    }
  });

  it('pipe=1 streams the same bytes through the app, with the type of the copy', async () => {
    const via = await fetchImage(h, album[0].web);
    const piped = await request(h.app).get(`${album[0].web}&pipe=1`).buffer(true).parse(binary).expect(200);
    expect(piped.headers['content-type']).toBe('image/webp');
    expect(piped.headers['cache-control']).toBe('private, max-age=300');
    expect((piped.body as Buffer).equals(via.body)).toBe(true);
  });
});

describe('the link cache', () => {
  it('a second request makes no OneDrive call; one listing fills the links of the whole album', async () => {
    await coldCache();
    const spy = spyDrive();
    try {
      expect(await warmFolder(h.ctx, event.id, 't')).toBeGreaterThanOrEqual(album.length);
      expect(spy.calls.children).toBe(1);
      for (const p of album) await request(h.app).get(p.thumb).redirects(0).expect(302);
      expect(spy.calls.item).toBe(0);
      expect(await warmFolder(h.ctx, event.id, 't')).toBe(0); // listed lately: not again for 20 minutes
      expect(spy.calls.children).toBe(1);
    } finally {
      spy.restore();
    }
  });

  it('the album page warms the cache itself before the phone asks', async () => {
    await coldCache();
    const spy = spyDrive();
    try {
      await viewer().get(`/api/e/${event.slug}/album`).expect(200);
      await settle(h);
      expect(spy.calls.children).toBe(1);
      for (const p of album) await request(h.app).get(p.thumb).redirects(0).expect(302);
      expect(spy.calls.item).toBe(0);
    } finally {
      spy.restore();
    }
  });

  it('the whole album asking at once while the listing is still running: one listing, no lookup per image', async () => {
    await coldCache();
    const d = h.ctx.drive as any;
    const spy = spyDrive();
    const listing = d.children;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    d.children = async (...a: any[]) => (await gate, listing(...a)); // a slow listing (Microsoft takes its time)
    try {
      await viewer().get(`/api/e/${event.slug}/album`).expect(200); // starts the listing, answers at once
      const asks = Promise.all(album.map((p) => request(h.app).get(p.thumb).redirects(0)));
      await new Promise((r) => setTimeout(r, 100));
      open();
      for (const res of await asks) expect(res.status).toBe(302);
      await settle(h);
      expect(spy.calls.children).toBe(1);
      expect(spy.calls.item).toBe(0);
    } finally {
      d.children = listing;
      spy.restore();
    }
  });

  it('never hands out a cached link with less than 20 minutes left (the stand-in links last an hour)', async () => {
    await coldCache();
    const first = await request(h.app).get(album[4].web).redirects(0).expect(302);
    const spy = spyDrive();
    try {
      setUrlClock(() => Date.now() + 30 * 60_000); // 30 minutes on: 30 left, still handed out
      expect((await request(h.app).get(album[4].web).redirects(0).expect(302)).headers.location).toBe(first.headers.location);
      expect(spy.calls.item + spy.calls.children).toBe(0);
      setUrlClock(() => Date.now() + 45 * 60_000); // 15 left: looked up afresh
      await request(h.app).get(album[4].web).redirects(0).expect(302);
      expect(spy.calls.item + spy.calls.children).toBeGreaterThan(0);
    } finally {
      spy.restore();
    }
  });
});

describe('when a copy or OneDrive is not there', () => {
  it('a copy deleted in OneDrive: "being prepared" (503), marked missing and asked for first', async () => {
    const row = (await h.ctx.db.query<any>(`select thumb_key from media where id = $1`, [album[5].id])).rows[0];
    fs.rmSync(copyPath(h, row.thumb_key));
    await coldCache();
    const folders = (await h.ctx.db.query<any>(`select copies_folders from events where id = $1`, [event.id])).rows[0].copies_folders;
    await h.ctx.redis.set(`cuw:${folders.t}`, '1'); // no listing: the single lookup finds it gone
    const res = await request(h.app).get(album[5].thumb).redirects(0).expect(503);
    expect(res.body).toEqual({ error: 'copy_preparing', message: 'This photo is being prepared. It will appear in a moment.' });
    expect(res.headers['retry-after']).toBe('20');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await h.ctx.db.query<any>(`select copies_missing from media where id = $1`, [album[5].id])).rows[0].copies_missing).toBe(true);
    expect(await h.ctx.redis.zrange('rebuild:hot', '0', '-1')).toContain(album[5].id);
    // the rebuild job makes it again from the original
    const { rebuildPass } = await import('../src/media/rebuild.js');
    expect((await rebuildPass(h.ctx)).done).toBeGreaterThanOrEqual(1);
    await settle(h);
    expect((await fetchImage(h, album[5].thumb)).status).toBe(200);
  });

  it('a listing that misses a copy marks it missing (someone deleted it by hand)', async () => {
    const row = (await h.ctx.db.query<any>(`select web_key from media where id = $1`, [album[0].id])).rows[0];
    fs.rmSync(copyPath(h, row.web_key));
    await coldCache();
    await warmFolder(h.ctx, event.id, 'w');
    expect((await h.ctx.db.query<any>(`select copies_missing from media where id = $1`, [album[0].id])).rows[0].copies_missing).toBe(true);
    const { rebuildPass } = await import('../src/media/rebuild.js');
    await rebuildPass(h.ctx);
    await settle(h);
    expect((await h.ctx.db.query<any>(`select copies_missing from media where id = $1`, [album[0].id])).rows[0].copies_missing).toBe(false);
  });

  it('OneDrive down: 503 images_unavailable, remembered for the album ("images_ok": false)', async () => {
    await coldCache();
    const d = h.ctx.drive as any;
    const real = { item: d.item, children: d.children };
    d.item = async () => {
      throw new DriveDownError();
    };
    d.children = async () => {
      throw new DriveDownError();
    };
    try {
      const res = await request(h.app).get(album[2].thumb).redirects(0).expect(503);
      expect(res.body.error).toBe('images_unavailable');
      expect(res.headers['retry-after']).toBe('30');
      expect(await hasFlag(h.ctx, 'drive:down')).toBe(true);
    } finally {
      Object.assign(d, real);
    }
    expect((await viewer().get(`/api/e/${event.slug}/album`).expect(200)).body.images_ok).toBe(false);
    await clearFlag(h.ctx, 'drive:down');
    expect((await viewer().get(`/api/e/${event.slug}/album`).expect(200)).body.images_ok).toBe(true);
  });

  it('OneDrive limiting requests: a link not cached gets 503 at once, without asking OneDrive', async () => {
    await coldCache();
    await setFlag(h.ctx, 'drive:throttled', 30_000);
    const spy = spyDrive();
    try {
      const res = await request(h.app).get(album[3].thumb).redirects(0).expect(503);
      // a few seconds of throttling is not an outage: "try again" after Retry-After, and no "cannot be loaded" banner
      expect(res.body.error).toBe('busy');
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(5);
      expect(spy.calls).toEqual({ item: 0, children: 0, read: 0 });
      expect(await hasFlag(h.ctx, 'drive:down')).toBe(false);
    } finally {
      spy.restore();
    }
  });

  it('a stand-in drive link that was changed or has expired is refused', async () => {
    const res = await request(h.app).get(album[0].thumb).redirects(0).expect(302);
    const loc = String(res.headers.location);
    await request(h.app).get(loc.replace(/s=[^&]+/, 's=nope')).expect(403);
    await request(h.app).get(loc.replace(/e=\d+/, 'e=1000')).expect(403);
  });
});
