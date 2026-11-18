/**
 * Phase 4 "Done when": with the passcode switched on, nobody opens the album without it;
 * a reported photo is hidden in one tap and its image link stops working.
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectNoLocalMedia, fetchImage, ADMIN, makeEvent, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { chatCopy, makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
const FOLDER = 'Freshers';
const slug = () => event.slug;
const adminMedia = async (filter = 'all') => (await h.admin.get(`/api/admin/events/${event.id}/media?filter=${filter}&limit=200`)).body;

beforeAll(async () => {
  h = await makeHarness();
  event = await makeEvent(h, 'Freshers Party', FOLDER);
  for (let i = 1; i <= 7; i++) h.put(FOLDER, `f${i}.jpg`, await makePhoto(i, i <= 3 ? [{ person: PERSON.red }] : [{ person: PERSON.green }]));
  h.put(FOLDER, 'f1 again.jpg', await makePhoto(1, [{ person: PERSON.red }])); // the same file twice
  await syncNow(h, event.id);
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
});
afterAll(() => h.close());
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

describe('Full event album', () => {
  const amy = () => phone(h, 'amy');

  it('shows every visible photo once, a page at a time, in time order', async () => {
    const page1 = (await amy().get(`/api/e/${slug()}/album?limit=5`).expect(200)).body;
    expect(page1.total).toBe(7); // 8 files, one is a copy
    expect(page1.photos).toHaveLength(5);
    const page2 = (await amy().get(`/api/e/${slug()}/album?limit=5&offset=5`).expect(200)).body;
    expect(page2.photos).toHaveLength(2);
    const ids = [...page1.photos, ...page2.photos].map((p: any) => p.id);
    expect(new Set(ids).size).toBe(7);
    expect((await fetchImage(h, page1.photos[0].web)).status).toBe(200);
  });

  it('needs the phone token but no login', async () => {
    await request(h.app).get(`/api/e/${slug()}/album`).expect(400);
  });

  it('with the passcode switched on, nobody opens the album without it', async () => {
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ passcode: 'fest2026' }).expect(200);
    expect((await request(h.app).get(`/api/e/${slug()}`)).body.event.options.album_locked).toBe(true);
    expect((await amy().get(`/api/e/${slug()}/album`).expect(403)).body.error).toBe('passcode_needed');
    expect((await amy().post(`/api/e/${slug()}/session`).send({}).expect(200)).body.me.album_open).toBe(false);

    const wrong = await amy().post(`/api/e/${slug()}/session`).send({ passcode: 'guess' }).expect(403);
    expect(wrong.body.error).toBe('wrong_passcode');
    expect((await amy().get(`/api/e/${slug()}/album`).expect(403)).body.error).toBe('passcode_needed');

    const right = await amy().post(`/api/e/${slug()}/session`).send({ passcode: 'fest2026' }).expect(200);
    expect(right.body.me.album_open).toBe(true);
    expect((await amy().get(`/api/e/${slug()}/album`).expect(200)).body.total).toBe(7);
    // another phone is still outside
    await phone(h, 'ben').get(`/api/e/${slug()}/album`).expect(403);
    // ...but Find my photos stays open to it, and shows only its own photos
    const ben = await phone(h, 'ben').selfie(slug(), await makeSelfie(PERSON.red)).expect(200);
    expect(ben.body.sure).toHaveLength(3);
  });

  it('locks a phone out for a while after many wrong passcodes', async () => {
    const eve = phone(h, 'eve');
    for (let i = 0; i < 8; i++) await eve.post(`/api/e/${slug()}/session`).send({ passcode: `no-${i}` }).expect(403);
    expect((await eve.post(`/api/e/${slug()}/session`).send({ passcode: 'fest2026' }).expect(429)).body.error).toBe('slow_down');
  });

  it('cannot report a photo it is not allowed to see', async () => {
    const green = (await adminMedia()).media.find((m: any) => m.name === 'f5.jpg');
    const res = await phone(h, 'ben').post(`/api/e/${slug()}/report`).send({ media_id: green.id }).expect(403);
    expect(res.body.error).toBe('passcode_needed');
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ passcode: null }).expect(200);
  });
});

describe('take-down', () => {
  const amy = () => phone(h, 'amy');
  let target: any;

  it('a student reports a photo, and it lands in the organiser\'s requests with a preview', async () => {
    const album = (await amy().get(`/api/e/${slug()}/album`).expect(200)).body;
    target = album.photos[0];
    await amy().post(`/api/e/${slug()}/report`).send({ media_id: target.id, reason: 'I do not want this one up' }).expect(201);
    await amy().post(`/api/e/${slug()}/report`).send({ media_id: target.id }).expect(201); // tapping twice makes one request
    const list = (await h.admin.get('/api/admin/requests').expect(200)).body.requests;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'report', status: 'open', reason: 'I do not want this one up', event_title: 'Freshers Party', media_id: target.id });
    expect((await fetchImage(h, list[0].thumb)).status).toBe(200);
  });

  it('one tap hides the photo: gone from the album and from results, and its image link stops working', async () => {
    const ben = phone(h, 'ben');
    const before = (await ben.get(`/api/e/${slug()}/mine`)).body.sure.length;
    expect((await fetchImage(h, target.thumb)).status).toBe(200);
    const req = (await h.admin.get('/api/admin/requests')).body.requests[0];
    await h.admin.patch(`/api/admin/requests/${req.id}`).send({ status: 'approved' }).expect(200);

    await request(h.app).get(target.thumb).expect(404);
    await request(h.app).get(target.web).expect(404);
    const album = (await amy().get(`/api/e/${slug()}/album`)).body;
    expect(album.total).toBe(6);
    expect(album.photos.some((p: any) => p.id === target.id)).toBe(false);
    const after = (await ben.get(`/api/e/${slug()}/mine`)).body.sure;
    expect(after.some((p: any) => p.id === target.id)).toBe(false);
    expect(after.length).toBeLessThanOrEqual(before);
    expect((await h.admin.get('/api/admin/requests')).body.requests).toHaveLength(0);
    expect((await h.admin.get('/api/admin/requests?status=all')).body.requests[0].status).toBe('approved');
    expect((await adminMedia('hidden')).total).toBe(1);
    expect((await fetchImage(h, (await adminMedia('hidden')).media[0].thumb)).status).toBe(200); // the organiser can still see it
  });

  it('declining a report leaves the photo up', async () => {
    const album = (await amy().get(`/api/e/${slug()}/album`)).body;
    const keep = album.photos[0];
    await amy().post(`/api/e/${slug()}/report`).send({ media_id: keep.id }).expect(201);
    const req = (await h.admin.get('/api/admin/requests')).body.requests[0];
    await h.admin.patch(`/api/admin/requests/${req.id}`).send({ status: 'declined' }).expect(200);
    expect((await amy().get(`/api/e/${slug()}/album`)).body.total).toBe(6);
    expect((await fetchImage(h, keep.thumb)).status).toBe(200);
  });

  it('the organiser hides and unhides photos in bulk; a hidden photo\'s copy stays out too', async () => {
    const all = (await adminMedia()).media;
    const f1 = all.find((m: any) => m.name === 'f1.jpg');
    const f2 = all.find((m: any) => m.name === 'f2.jpg');
    const res = await h.admin.patch('/api/admin/media').send({ ids: [f1.id, f2.id], action: 'hide' }).expect(200);
    expect(res.body.changed).toBe(f1.hidden || f2.hidden ? 1 : 2);
    const names = (await adminMedia('shown')).media.map((m: any) => m.name);
    expect(names).not.toContain('f1.jpg');
    expect(names).not.toContain('f1 again.jpg'); // the copy does not take its place
    expect(names).not.toContain('f2.jpg');
    await h.admin.patch('/api/admin/media').send({ ids: [f1.id, f2.id], action: 'unhide' }).expect(200);
    expect((await adminMedia('shown')).total).toBe(7);
  });

  it('keeps the admin routes closed to students', async () => {
    await request(h.app).patch('/api/admin/media').send({ ids: [target.id], action: 'unhide' }).expect(401);
    await request(h.app).get('/api/admin/requests').expect(401);
    await request(h.app).get('/api/admin/audit').expect(401);
  });

  it('logs every take-down', async () => {
    const actions = (await h.admin.get('/api/admin/audit').expect(200)).body.entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['request.approved', 'request.declined', 'media.hide', 'media.unhide']));
    expect((await h.admin.get('/api/admin/audit')).body.entries[0].actor).toBe(ADMIN.email);
  });
});

describe('event states', () => {
  it('Closed keeps the album and face search; Archived closes everything and deletes the face vectors', async () => {
    const cy = phone(h, 'cy');
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'closed' }).expect(200);
    expect((await cy.get(`/api/e/${slug()}/album`).expect(200)).body.total).toBe(7);
    expect((await cy.selfie(slug(), await makeSelfie(PERSON.green)).expect(200)).body.sure).toHaveLength(4);

    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'archived' }).expect(200);
    expect((await cy.get(`/api/e/${slug()}/album`).expect(403)).body.error).toBe('not_open');
    expect((await cy.get(`/api/e/${slug()}/mine`).expect(200)).body.sure).toEqual([]);
    expect((await h.ctx.db.query(`select count(*)::int as n from faces where event_id = $1`, [event.id])).rows[0].n).toBe(0);
    expect((await request(h.app).get(`/api/e/${slug()}`)).body.event.state).toBe('archived');
  });
});

describe('a take-down holds, whichever copy of the picture is shown', () => {
  const total = async (slug: string) => (await phone(h, 'onlooker').get(`/api/e/${slug}/album`).expect(200)).body.total;

  it('a report still takes the picture down after the reported photo became a copy of your original', async () => {
    const e = await makeEvent(h, 'Take Down', 'Take Down', { auto_approve: true });
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);
    const pic = await makePhoto(300, [{ person: PERSON.red }]);
    const up = (await phone(h, 'uploader').upload(e.slug, await chatCopy(pic)).expect(201)).body; // a student's chat copy of your photo
    await settle(h);
    expect(await total(e.slug)).toBe(1);
    await phone(h, 'onlooker').post(`/api/e/${e.slug}/report`).send({ media_id: up.id, reason: 'please remove' }).expect(201);

    h.put('Take Down', 'original.jpg', pic); // then your original arrives: it is shown, the student's becomes its copy
    expect((await syncNow(h, e.id)).counts).toMatchObject({ shown: 1, copies: 1 });
    expect(await total(e.slug)).toBe(1);

    const open = (await h.admin.get('/api/admin/requests').expect(200)).body.requests.filter((r: any) => r.event_id === e.id);
    expect(open).toHaveLength(1);
    await h.admin.patch(`/api/admin/requests/${open[0].id}`).send({ status: 'approved' }).expect(200);
    expect(await total(e.slug)).toBe(0); // the picture is down, not only the student's copy of it
  });

  it('a picture that was taken down stays down when your original of it arrives; Unhide brings it back', async () => {
    const e = await makeEvent(h, 'Stay Down', 'Stay Down', { auto_approve: true });
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);
    const pic = await makePhoto(301, [{ person: PERSON.green }]);
    const up = (await phone(h, 'uploader').upload(e.slug, await chatCopy(pic)).expect(201)).body;
    await settle(h);
    await h.admin.patch('/api/admin/media').send({ ids: [up.id], action: 'hide' }).expect(200);
    expect(await total(e.slug)).toBe(0);

    h.put('Stay Down', 'original.jpg', pic);
    const p = await syncNow(h, e.id);
    expect(p.counts).toMatchObject({ shown: 0, hidden: 1, copies: 1 });
    expect(await total(e.slug)).toBe(0);
    const hidden = (await h.admin.get(`/api/admin/events/${e.id}/media?filter=hidden`)).body.media;
    const original = hidden.find((m: any) => m.name === 'original.jpg');
    expect(original).toBeTruthy();
    await h.admin.patch('/api/admin/media').send({ ids: [original.id], action: 'unhide' }).expect(200);
    expect(await total(e.slug)).toBe(1);
  });
});
