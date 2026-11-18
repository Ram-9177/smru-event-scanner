/**
 * Remove me (feature F), the student's side: a removal request lists the phone's current sure matches, one open
 * request per phone per event, and My prints shows where it stands.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectNoLocalMedia, makeEvent, makeHarness, phone, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
const FOLDER = '2026-11-21 Sports Day';

const red = () => phone(h, 'red-remover');
const ask = (p: ReturnType<typeof phone>, body: unknown = {}) => p.post(`/api/e/${event.slug}/removal`).send(body as object);
const mediaId = async (name: string) => (await h.ctx.db.query(`select id from media where event_id = $1 and name = $2`, [event.id, name])).rows[0].id as string;

beforeAll(async () => {
  h = await makeHarness();
  event = await makeEvent(h, 'Sports Day', FOLDER);
  h.put(FOLDER, 'IMG_0001.jpg', await makePhoto(1, [{ person: PERSON.red }, { person: PERSON.blue }]));
  h.put(FOLDER, 'IMG_0002.jpg', await makePhoto(2, [{ person: PERSON.red }]));
  h.put(FOLDER, 'IMG_0003.jpg', await makePhoto(3, [{ person: PERSON.red }]));
  h.put(FOLDER, 'IMG_0004.jpg', await makePhoto(4, [{ person: PERSON.red, dim: true }])); // a "maybe"
  h.put(FOLDER, 'IMG_0005.jpg', await makePhoto(5, [{ person: PERSON.green }]));
  await syncNow(h, event.id);
});
afterAll(() => h.close());
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

describe('asking to be removed', () => {
  it('not before the photos are open', async () => {
    expect((await ask(red()).expect(403)).body.error).toBe('not_open');
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
  });

  it('needs photos of the student', async () => {
    const res = await ask(phone(h, 'never-searched')).expect(400);
    expect(res.body).toMatchObject({ error: 'nothing_to_remove', message: 'We have not found you in any photos of this event yet.' });
    const stranger = phone(h, 'stranger');
    await stranger.selfie(event.slug, await makeSelfie(PERSON.magenta)).expect(200);
    expect((await ask(stranger).expect(400)).body.error).toBe('nothing_to_remove');
  });

  it('lists the current sure matches (not the maybes, not "Not me"), with the note', async () => {
    const found = (await red().selfie(event.slug, await makeSelfie(PERSON.red)).expect(200)).body;
    expect(found.sure).toHaveLength(3);
    expect(found.maybe).toHaveLength(1);
    await red().post(`/api/e/${event.slug}/mine/${await mediaId('IMG_0003.jpg')}/not-me`).expect(200);
    expect((await ask(red(), { note: 'x'.repeat(301) }).expect(400)).body.error).toBe('invalid_input');

    const res = (await ask(red(), { note: '  Please take these down.  ' }).expect(201)).body;
    expect(res.removal).toMatchObject({ status: 'open', count: 2, resolved_at: null });
    expect(res.removal.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof res.removal.created_at).toBe('string');

    const q = (await h.ctx.db.query(`select * from requests where id = $1`, [res.removal.id])).rows[0];
    expect(q).toMatchObject({ kind: 'removal', media_id: null, reason: 'Please take these down.', status: 'open', event_id: event.id });
    const listed = (await h.ctx.db.query(`select media_id from request_media where request_id = $1`, [q.id])).rows.map((r) => r.media_id).sort();
    expect(listed).toEqual([await mediaId('IMG_0001.jpg'), await mediaId('IMG_0002.jpg')].sort());

    const mine = (await red().get(`/api/e/${event.slug}/mine`).expect(200)).body;
    expect(mine.removal).toEqual(res.removal);
  });

  it('one open request per phone per event', async () => {
    const res = await ask(red()).expect(409);
    expect(res.body).toMatchObject({ error: 'removal_open', message: 'You already asked. Your removal request is waiting.' });
    expect((await h.ctx.db.query(`select count(*)::int as n from requests where kind = 'removal'`)).rows[0].n).toBe(1);
  });

  it('two sent at the same moment: one request', async () => {
    const blue = phone(h, 'blue-twice');
    await blue.selfie(event.slug, await makeSelfie(PERSON.blue)).expect(200);
    const both = await Promise.all([ask(blue), ask(blue)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const g = (await h.ctx.db.query(`select count(*)::int as n from requests where kind = 'removal' and status = 'open'`)).rows[0].n;
    expect(g).toBe(2); // red's and blue's
  });

  it('My prints follows the request: done or kept, and then the phone may ask again', async () => {
    const id = (await red().get(`/api/e/${event.slug}/mine`).expect(200)).body.removal.id;
    await h.ctx.db.query(`update requests set status = 'declined', resolved_at = now() where id = $1`, [id]);
    let mine = (await red().get(`/api/e/${event.slug}/mine`).expect(200)).body;
    expect(mine.removal).toMatchObject({ id, status: 'declined', count: 2 });
    expect(mine.removal.resolved_at).toBeTruthy();

    const again = (await ask(red()).expect(201)).body.removal;
    expect(again).toMatchObject({ status: 'open', count: 2 });
    expect(again.id).not.toBe(id);
    await h.ctx.db.query(`update requests set status = 'approved', resolved_at = now() where id = $1`, [again.id]);
    mine = (await red().get(`/api/e/${event.slug}/mine`).expect(200)).body;
    expect(mine.removal).toMatchObject({ id: again.id, status: 'approved' });
  });

  it('shares the 20 a day with reports', async () => {
    const green = phone(h, 'green-busy');
    await green.selfie(event.slug, await makeSelfie(PERSON.green)).expect(200);
    const g = (await h.ctx.db.query(`select guest_id from search_log order by id desc limit 1`)).rows[0].guest_id;
    for (let i = 0; i < 20; i++) await h.ctx.db.query(`insert into requests (event_id, media_id, guest_id, kind) values ($1, $2, $3, 'report')`, [event.id, await mediaId('IMG_0005.jpg'), g]);
    expect((await ask(green).expect(429)).body.error).toBe('slow_down');
  });

  it('Delete my results: the request stays for the organisers, without the phone', async () => {
    const before = (await h.ctx.db.query(`select count(*)::int as n from requests where kind = 'removal'`)).rows[0].n;
    await red().del(`/api/e/${event.slug}/me`).expect(200);
    expect((await h.ctx.db.query(`select count(*)::int as n from requests where kind = 'removal'`)).rows[0].n).toBe(before);
    expect((await red().get(`/api/e/${event.slug}/mine`).expect(200)).body.removal).toBeNull();
  });
});
