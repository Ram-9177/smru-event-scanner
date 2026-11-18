/**
 * Campuses and the People folders.
 *   - the campuses are there on the first start; an event of a campus gets its folder inside the campus's folder,
 *     and the home page can show one campus
 *   - People: the university's main people, recognised from reference photos; every shown photo they are in is
 *     copied into Event Photos > People > <Name - Role> > Solo | Duo | Group, and leaves again when it is hidden
 *   - students' photos wait for approval, and are filed only once approved
 */
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectNoLocalMedia, fetchImage, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness({ uploadsPerPhone: 50 });
});
afterAll(() => h.close());
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

const files = (...parts: string[]) => {
  const dir = path.join(h.driveDir, ...parts);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort() : [];
};

describe('campuses', () => {
  it('Hyderabad, Chebrolu and Budampadu are there from the first start, for everyone', async () => {
    const res = await request(h.app).get('/api/campuses').expect(200);
    expect(res.body.campuses.map((c: any) => [c.name, c.slug])).toEqual([
      ['Hyderabad', 'hyderabad'],
      ['Chebrolu', 'chebrolu'],
      ['Budampadu', 'budampadu'],
    ]);
  });

  it("an event of a campus gets its folder inside the campus's folder; the home page can show one campus", async () => {
    const campuses = (await h.admin.get('/api/admin/campuses').expect(200)).body.campuses;
    const hyd = campuses.find((c: any) => c.slug === 'hyderabad');
    const che = campuses.find((c: any) => c.slug === 'chebrolu');
    const a = (await h.admin.post('/api/admin/events').send({ title: 'Annual Day', starts_on: '2026-11-20', campus_id: hyd.id }).expect(201)).body;
    expect(a.folder_error).toBeNull();
    expect(a.event.campus).toEqual({ id: hyd.id, name: 'Hyderabad', slug: 'hyderabad' });
    expect(fs.statSync(path.join(h.driveDir, 'Hyderabad', '2026-11-20 Annual Day')).isDirectory()).toBe(true);
    const b = (await h.admin.post('/api/admin/events').send({ title: 'Sports Day', starts_on: '2026-11-21', campus_id: che.id }).expect(201)).body.event;
    await h.admin.patch(`/api/admin/events/${a.event.id}`).send({ status: 'live' }).expect(200);
    await h.admin.patch(`/api/admin/events/${b.id}`).send({ status: 'live' }).expect(200);
    const only = (await request(h.app).get('/api/events?campus=chebrolu').expect(200)).body.events;
    expect(only.map((e: any) => e.title)).toEqual(['Sports Day']);
    expect(only[0].campus.name).toBe('Chebrolu');
    expect((await request(h.app).get('/api/events').expect(200)).body.events.length).toBeGreaterThanOrEqual(2);
  });

  it('a super admin adds, renames and removes a campus; its events stay', async () => {
    const add = await h.admin.post('/api/admin/campuses').send({ name: 'Vijayawada' }).expect(201);
    await h.admin.post('/api/admin/campuses').send({ name: 'vijayawada' }).expect(409);
    await h.admin.patch(`/api/admin/campuses/${add.body.campus.id}`).send({ name: 'Vijayawada City' }).expect(200);
    const e = (await h.admin.post('/api/admin/events').send({ title: 'Expo', campus_id: add.body.campus.id }).expect(201)).body.event;
    await h.admin.delete(`/api/admin/campuses/${add.body.campus.id}`).expect(200);
    expect((await h.admin.get(`/api/admin/events/${e.id}`).expect(200)).body.event.campus).toBeNull();
    await h.admin.post('/api/admin/events').send({ title: 'Nowhere', campus_id: add.body.campus.id }).expect(400);
  });
});

describe('campus QR codes', () => {
  const svgOf = (link: string) => QRCode.toString(link, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });

  it("each campus has its own QR of its own link (/c/<slug>), as SVG and PNG", async () => {
    const svg = await h.admin.get('/api/admin/qr?campus=hyderabad').expect(200);
    expect(svg.headers['content-type']).toMatch(/svg/);
    expect(svg.headers['content-disposition']).toContain('event-photos-hyderabad-qr.svg');
    expect(String(svg.body)).toBe(await svgOf('https://photos.college.test/c/hyderabad'));
    const png = await h.admin.get('/api/admin/qr?campus=chebrolu&format=png').expect(200);
    expect(png.headers['content-type']).toMatch(/png/);
    expect(png.headers['content-disposition']).toContain('event-photos-chebrolu-qr.png');
    expect(png.body.subarray(1, 4).toString()).toBe('PNG');
    const pngOf = await QRCode.toBuffer('https://photos.college.test/c/chebrolu', { type: 'png', width: 1200, margin: 2, errorCorrectionLevel: 'M' });
    expect(Buffer.compare(png.body, pngOf)).toBe(0);
  });

  it('without a campus it is still the one main link', async () => {
    const svg = await h.admin.get('/api/admin/qr').expect(200);
    expect(String(svg.body)).toBe(await svgOf('https://photos.college.test'));
    expect(svg.headers['content-disposition']).toContain('event-photos-qr.svg');
  });

  it('an unknown or malformed campus is a 404; signed out is a 401', async () => {
    expect((await h.admin.get('/api/admin/qr?campus=atlantis').expect(404)).body.error).toBe('not_found');
    await h.admin.get('/api/admin/qr?campus=').expect(404);
    await h.admin.get('/api/admin/qr?campus=Hyderabad%20x').expect(404);
    await h.admin.get('/api/admin/qr?campus=a&campus=b').expect(404);
    await request(h.app).get('/api/admin/qr?campus=hyderabad').expect(401);
  });
});

describe('People folders', () => {
  let event: any;
  let chairman: any;
  const FOLDER = 'Convocation';

  beforeAll(async () => {
    event = (await h.admin.post('/api/admin/events').send({ title: FOLDER }).expect(201)).body.event;
    h.put(FOLDER, 'solo.jpg', await makePhoto(401, [{ person: PERSON.red }]));
    h.put(FOLDER, 'duo.jpg', await makePhoto(402, [{ person: PERSON.red }, { person: PERSON.blue }]));
    h.put(FOLDER, 'group.jpg', await makePhoto(403, [{ person: PERSON.red }, { person: PERSON.blue }, { person: PERSON.green }]));
    h.put(FOLDER, 'others.jpg', await makePhoto(404, [{ person: PERSON.blue }, { person: PERSON.green }]));
    // A big portrait with someone small far behind: still a solo photo.
    h.put(FOLDER, 'portrait.jpg', await makePhoto(405, [{ person: PERSON.red, size: 200 }, { person: PERSON.cyan, size: 40 }]));
    await syncNow(h, event.id);
    await settle(h);
  });

  it('adds a person with a role; a photo without a face, or with several people, is refused as a reference', async () => {
    chairman = (await h.admin.post('/api/admin/people').send({ name: 'Dr. K. Red', role: 'Chairman' }).expect(201)).body.person;
    expect(chairman).toMatchObject({ name: 'Dr. K. Red', role: 'Chairman', refs: 0, photo: null, counts: { solo: 0, duo: 0, group: 0 }, folder: null });
    const empty = await h.admin.post(`/api/admin/people/${chairman.id}/photos`).set('content-type', 'image/jpeg').send(await makePhoto(410)).expect(422);
    expect(empty.body.error).toBe('no_face');
    const two = await h.admin
      .post(`/api/admin/people/${chairman.id}/photos`)
      .set('content-type', 'image/jpeg')
      .send(await makePhoto(411, [{ person: PERSON.red, size: 200 }, { person: PERSON.blue, size: 200 }]))
      .expect(422);
    expect(two.body.error).toBe('many_faces');
  });

  it('with a reference photo, every photo they are in is copied into Solo, Duo or Group', async () => {
    const res = await h.admin.post(`/api/admin/people/${chairman.id}/photos`).set('content-type', 'image/jpeg').send(await makeSelfie(PERSON.red)).expect(201);
    expect(res.body.person.refs).toBe(1);
    expect(res.body.person.photo).toMatch(/^\/api\/admin\/people\/refs\/[0-9a-f-]+\.jpg$/);
    await settle(h); // the events are looked through in the background
    const base = ['People', 'Dr. K. Red - Chairman'];
    expect(files(...base, 'Solo')).toEqual(['Convocation - portrait.jpg', 'Convocation - solo.jpg']);
    expect(files(...base, 'Duo')).toEqual(['Convocation - duo.jpg']);
    expect(files(...base, 'Group')).toEqual(['Convocation - group.jpg']);
    // the copies are the originals, byte for byte
    expect(fs.readFileSync(path.join(h.driveDir, ...base, 'Duo', 'Convocation - duo.jpg'))).toEqual(fs.readFileSync(path.join(h.driveDir, FOLDER, 'duo.jpg')));
    const p = (await h.admin.get('/api/admin/people').expect(200)).body.people[0];
    expect(p).toMatchObject({ counts: { solo: 2, duo: 1, group: 1 }, folder: 'People › Dr. K. Red - Chairman' });
    const duo = (await h.admin.get(`/api/admin/people/${chairman.id}/media?kind=duo`).expect(200)).body.media;
    expect(duo).toHaveLength(1);
    expect(duo[0]).toMatchObject({ kind: 'duo', type: 'photo', in_onedrive: true, event: { title: FOLDER } });
    await request(h.app).get(p.photo).expect(401); // the reference photos are for organisers only
    // the face photo lives in OneDrive's app folder (people-refs): a redirect the browser does not keep
    const got = await fetchImage(h, p.photo, { agent: h.admin });
    expect(got).toMatchObject({ status: 200, redirected: true, cache: 'private, no-store' });
    expect(got.type).toMatch(/jpeg/);
  });

  it('a hidden photo leaves the folder; shown again, it comes back', async () => {
    const duo = (await h.admin.get(`/api/admin/people/${chairman.id}/media?kind=duo`).expect(200)).body.media[0];
    await h.admin.patch('/api/admin/media').send({ ids: [duo.id], action: 'hide' }).expect(200);
    expect(files('People', 'Dr. K. Red - Chairman', 'Duo')).toEqual([]);
    await h.admin.patch('/api/admin/media').send({ ids: [duo.id], action: 'unhide' }).expect(200);
    expect(files('People', 'Dr. K. Red - Chairman', 'Duo')).toEqual(['Convocation - duo.jpg']);
  });

  it("a student's photo waits for approval and is filed only once approved", async () => {
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
    const fresh = (await h.admin.get(`/api/admin/events/${event.id}`).expect(200)).body.event;
    expect(fresh.auto_approve).toBe(false);
    const up = await phone(h, 'guest').upload(fresh.slug, await makePhoto(420, [{ person: PERSON.red }, { person: PERSON.yellow }]), 'image/jpeg', 'A visitor').expect(201);
    await settle(h);
    expect(files('People', 'Dr. K. Red - Chairman', 'Duo')).toEqual(['Convocation - duo.jpg']);
    const waiting = (await h.admin.get(`/api/admin/events/${event.id}/media?filter=review`).expect(200)).body.media;
    expect(waiting).toHaveLength(1);
    await h.admin.patch('/api/admin/media').send({ ids: [waiting[0].id], action: 'approve' }).expect(200);
    expect(files('People', 'Dr. K. Red - Chairman', 'Duo')).toHaveLength(2);
    expect(up.body).toBeTruthy();
  });

  it('renaming the person renames their folder; File again finds nothing new; removing them keeps the folder', async () => {
    await h.admin.patch(`/api/admin/people/${chairman.id}`).send({ role: 'Chancellor' }).expect(200);
    expect(fs.existsSync(path.join(h.driveDir, 'People', 'Dr. K. Red - Chancellor', 'Solo'))).toBe(true);
    const again = await h.admin.post(`/api/admin/people/${chairman.id}/refile`).expect(200);
    expect(again.body).toMatchObject({ filed: 0, removed: 0 });
    await h.admin.delete(`/api/admin/people/${chairman.id}`).expect(200);
    expect((await h.admin.get('/api/admin/people').expect(200)).body.people).toEqual([]);
    expect(files('People', 'Dr. K. Red - Chancellor', 'Solo')).toHaveLength(2);
  });
});
