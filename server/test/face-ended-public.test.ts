/**
 * The student's side of face-data expiry (feature G) and of a nearly full disk (feature D): after an event's face data
 * is deleted, face search and Keep me updated are over (the photos and results stay); student uploads are refused
 * while the server's disk is nearly full.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { freshCount } from '../src/keep/keep-updated.js';
import { setDiskProbe } from '../src/ops/disk.js';
import { deleteFaceData } from '../src/ops/expiry.js';
import { expectNoLocalMedia, makeEvent, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
const FOLDER = '2026-11-22 Graduation';
const GB = 1024 ** 3;
let free = 100 * GB;

const red = () => phone(h, 'red-graduate');
const keepOn = (p: ReturnType<typeof phone>, image: Buffer) =>
  p.post(`/api/e/${event.slug}/keep`).set('content-type', 'image/jpeg').set('x-keep-consent', 'k1').send(image);

beforeAll(async () => {
  setDiskProbe(async () => ({ free, total: 500 * GB }));
  h = await makeHarness();
  event = await makeEvent(h, 'Graduation', FOLDER);
  h.put(FOLDER, 'IMG_0001.jpg', await makePhoto(1, [{ person: PERSON.red }]));
  h.put(FOLDER, 'IMG_0002.jpg', await makePhoto(2, [{ person: PERSON.blue }]));
  await syncNow(h, event.id);
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
});
afterEach(() => {
  free = 100 * GB;
});
afterAll(async () => {
  setDiskProbe(null);
  await h.close();
});
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

describe('a nearly full disk', () => {
  it('refuses student uploads before reading them, with a plain message', async () => {
    free = 0.5 * GB; // below TEMP_MIN_FREE_GB (1 GB): photos are handled in memory, so only temp room counts
    const before = (await h.ctx.db.query(`select count(*)::int as n from media where event_id = $1`, [event.id])).rows[0].n;
    const res = await phone(h, 'uploader').upload(event.slug, await makePhoto(10, [{ person: PERSON.green }])).expect(507);
    expect(res.body).toEqual({ error: 'disk_full', message: 'The server is nearly full, so photos cannot be added right now. Try again later.' });
    expect((await h.ctx.db.query(`select count(*)::int as n from media where event_id = $1`, [event.id])).rows[0].n).toBe(before);
    expect((await h.ctx.db.query(`select upload_count from guests where device_token_hash = encode(sha256(convert_to($1, 'utf8')), 'hex')`, [phone(h, 'uploader').token])).rows[0]?.upload_count ?? 0).toBe(0);
  });

  it('takes them again once there is room', async () => {
    free = 3.5 * GB;
    await phone(h, 'uploader').upload(event.slug, await makePhoto(11, [{ person: PERSON.green }])).expect(201);
    await settle(h);
  });

  it('closed uploads still say so first', async () => {
    free = 1 * GB;
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ crowd_uploads: false }).expect(200);
    try {
      expect((await phone(h, 'uploader').upload(event.slug, await makePhoto(12)).expect(403)).body.error).toBe('uploads_off');
    } finally {
      await h.admin.patch(`/api/admin/events/${event.id}`).send({ crowd_uploads: true }).expect(200);
    }
  });
});

describe('face search ended', () => {
  it('before: face search and Keep me updated are offered', async () => {
    await red().selfie(event.slug, await makeSelfie(PERSON.red)).expect(200);
    await keepOn(red(), await makeSelfie(PERSON.red)).expect(200);
    const e = (await red().get(`/api/e/${event.slug}`).expect(200)).body.event;
    expect(e).toMatchObject({ face_ended: false, options: { find: true } });
  });

  it('after the face data is deleted: no face search, no Keep me updated, the photos and results stay', async () => {
    await deleteFaceData(h.ctx, event.id);
    const e = (await red().get(`/api/e/${event.slug}`).expect(200)).body.event;
    expect(e).toMatchObject({ face_ended: true, mine: 1, options: { find: false, album: true } });
    expect(e.photos).toBeGreaterThanOrEqual(2);
    const listed = (await red().get('/api/events').expect(200)).body.events.find((x: any) => x.slug === event.slug);
    expect(listed).toMatchObject({ face_ended: true, options: { find: false } });
    const session = (await red().post(`/api/e/${event.slug}/session`).send({}).expect(200)).body.event;
    expect(session).toMatchObject({ face_ended: true, options: { find: false } });

    const sel = await red().selfie(event.slug, await makeSelfie(PERSON.red)).expect(403);
    expect(sel.body).toEqual({ error: 'face_ended', message: 'Face search has ended for this event. Browse all photos instead.' });
    expect((await keepOn(red(), await makeSelfie(PERSON.red)).expect(403)).body.error).toBe('face_ended');

    const mine = (await red().get(`/api/e/${event.slug}/mine`).expect(200)).body;
    expect(mine.keep).toMatchObject({ available: false, on: false });
    expect(mine.sure).toHaveLength(1); // results kept
    expect((await h.ctx.db.query(`select count(*)::int as n from guests where event_id = $1 and embedding is not null`, [event.id])).rows[0].n).toBe(0);
    await red().get(`/api/e/${event.slug}/album`).expect(200);
  });

  it('new photos after that are not matched against anyone', async () => {
    // A vector that somehow is still there (it never should be) is not used either.
    const g = (await h.ctx.db.query(`select id from guests where event_id = $1 and consent_at is not null limit 1`, [event.id])).rows[0];
    const v = new Float32Array(128);
    v[PERSON.red] = 1; // the stand-in face engine's vector for the red person
    await h.ctx.db.query(`update guests set keep_updated = true, keep_model = 'stub', embedding = $2 where id = $1`, [g.id, Buffer.from(v.buffer)]);
    h.put(FOLDER, 'IMG_0003.jpg', await makePhoto(3, [{ person: PERSON.red }]));
    await syncNow(h, event.id);
    await settle(h);
    expect(await freshCount(h.ctx.db, g.id)).toBe(0);
    expect((await red().get(`/api/e/${event.slug}/mine`).expect(200)).body.sure).toHaveLength(1);
  });

  it('an archived event says face_ended too', async () => {
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'archived' }).expect(200);
    const e = (await red().get(`/api/e/${event.slug}`).expect(200)).body.event;
    expect(e).toMatchObject({ state: 'archived', face_ended: true, mine_new: 0, options: { find: false } });
  });
});
