/**
 * Hiding a photo: new links stop at once (404 before any OneDrive call), and a OneDrive link already handed out
 * stops too once its copies get new names (in the background, within a minute or two), instead of living about an
 * hour. Shown again, the photo is served from its new copies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { expectNoLocalMedia, fetchImage, makeEvent, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, PERSON } from './helpers/photos.js';
import { DriveDownError } from '../src/drive/types.js';

let h: Harness;
let event: any;
const FOLDER = 'Hide Day';

beforeAll(async () => {
  h = await makeHarness();
  event = await makeEvent(h, FOLDER, FOLDER);
  h.put(FOLDER, 'a.jpg', await makePhoto(950, [{ person: PERSON.red }]));
  h.put(FOLDER, 'b.jpg', await makePhoto(951, [{ person: PERSON.blue }]));
  h.put(FOLDER, 'c.jpg', await makePhoto(952, [{ person: PERSON.green }]));
  h.put(FOLDER, 'd.jpg', await makePhoto(953, [{ person: PERSON.cyan }]));
  h.put(FOLDER, 'e.jpg', await makePhoto(954, [{ person: PERSON.red }]));
  await syncNow(h, event.id);
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
  await settle(h);
});
afterAll(async () => {
  await expectNoLocalMedia(h);
  await h.close();
});

describe('hide', () => {
  it('a link handed out before the hide stops working; new requests get 404 at once; unhide serves new copies', async () => {
    const album = (await phone(h, 'v').get(`/api/e/${event.slug}/album`).expect(200)).body.photos;
    const p = album[0];
    const before = (await h.ctx.db.query<any>(`select thumb_key, web_key from media where id = $1`, [p.id])).rows[0];
    const handedOut = String((await request(h.app).get(p.web).redirects(0).expect(302)).headers.location);
    await request(h.app).get(handedOut).expect(200); // the phone has it

    await h.admin.patch('/api/admin/media').send({ ids: [p.id], action: 'hide' }).expect(200);
    await request(h.app).get(p.web).redirects(0).expect(404); // at once
    await settle(h); // the copies get new names; the old ones are deleted
    await request(h.app).get(handedOut).expect(404); // the link handed out earlier is dead
    const after = (await h.ctx.db.query<any>(`select thumb_key, web_key from media where id = $1`, [p.id])).rows[0];
    expect(after.thumb_key).not.toBe(before.thumb_key);
    expect(after.web_key).not.toBe(before.web_key);
    expect((await h.ctx.db.query(`select count(*)::int as n from copy_trash`)).rows[0].n).toBe(0);

    await h.admin.patch('/api/admin/media').send({ ids: [p.id], action: 'unhide' }).expect(200);
    const again = await fetchImage(h, p.web);
    expect(again.status).toBe(200);
    expect(again.type).toMatch(/webp/);
    // the other photo was never touched
    const other = (await h.ctx.db.query<any>(`select thumb_key from media where id = $1`, [album[1].id])).rows[0];
    expect((await fetchImage(h, album[1].thumb)).status).toBe(200);
    expect(other.thumb_key).toMatch(/^od\//);
  });
});

describe('every way of hiding stops links already handed out', () => {
  const one = async (sql: string, params: unknown[] = []) => (await h.ctx.db.query<any>(sql, params)).rows[0];
  const idOf = async (name: string) => (await one(`select id from media where event_id = $1 and name = $2`, [event.id, name])).id as string;
  /** The OneDrive link a phone got for a photo's web copy (and checks that it works). */
  async function handedOut(id: string): Promise<string> {
    const p = (await phone(h, 'v').get(`/api/e/${event.slug}/album`).expect(200)).body.photos.find((x: any) => x.id === id);
    const loc = String((await request(h.app).get(p.web).redirects(0).expect(302)).headers.location);
    await request(h.app).get(loc).expect(200);
    return loc;
  }

  it('"Remove me" approved: the old link dies, as with Hide', async () => {
    const id = await idOf('c.jpg');
    const link = await handedOut(id);
    const guest = await one(`insert into guests (event_id, device_token_hash) values ($1, 'hash-rekey') returning id`, [event.id]);
    const q = await one(`insert into requests (event_id, guest_id, kind, reason, media_id) values ($1, $2, 'removal', null, null) returning id`, [event.id, guest.id]);
    await h.ctx.db.query(`insert into request_media (request_id, media_id) values ($1, $2)`, [q.id, id]);
    await h.admin.patch(`/api/admin/requests/${q.id}`).send({ status: 'approved' }).expect(200);
    await settle(h);
    await request(h.app).get(link).expect(404);
  });

  it('a report approved: the old link dies, as with Hide', async () => {
    const id = await idOf('d.jpg');
    const link = await handedOut(id);
    const q = await one(`insert into requests (event_id, media_id, kind, reason) values ($1, $2, 'report', 'not appropriate') returning id`, [event.id, id]);
    await h.admin.patch(`/api/admin/requests/${q.id}`).send({ status: 'approved' }).expect(200);
    await settle(h);
    await request(h.app).get(link).expect(404);
  });

  it('OneDrive cannot copy the copies: the old ones are deleted anyway and made again by the rebuild job', async () => {
    const id = await idOf('e.jpg');
    const link = await handedOut(id);
    const d = h.ctx.drive as any;
    const real = d.copy;
    d.copy = async () => {
      throw new DriveDownError();
    };
    try {
      await h.admin.patch('/api/admin/media').send({ ids: [id], action: 'hide' }).expect(200);
      await settle(h);
    } finally {
      d.copy = real;
    }
    await request(h.app).get(link).expect(404);
    expect((await one(`select copies_missing from media where id = $1`, [id])).copies_missing).toBe(true);
    const { rebuildPass } = await import('../src/media/rebuild.js');
    await rebuildPass(h.ctx);
    await settle(h);
    const m = await one(`select copies_missing, thumb_key, web_key from media where id = $1`, [id]);
    expect(m.copies_missing).toBe(false);
    await h.admin.patch('/api/admin/media').send({ ids: [id], action: 'unhide' }).expect(200);
    const p = (await phone(h, 'v').get(`/api/e/${event.slug}/album`).expect(200)).body.photos.find((x: any) => x.id === id);
    expect((await fetchImage(h, p.web)).status).toBe(200);
  });
});

