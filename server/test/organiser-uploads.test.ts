/**
 * An event's OneDrive folder is made when the event is created, and organisers add photos from the admin console:
 * each one is saved into that folder, checked for copies and processed like a synced photo.
 * Runs on the stand-in drive; onedrive-folder-path.test.ts runs the same through the OneDrive adapter.
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectNoLocalMedia, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
const create = async (body: Record<string, unknown>) => (await h.admin.post('/api/admin/events').send(body).expect(201)).body;
const files = (folder: string) => fs.readdirSync(path.join(h.driveDir, folder)).filter((n) => !n.startsWith('.'));
const send = (eventId: string, data: Buffer, fileName = 'IMG_0001.JPG', type = 'image/jpeg') =>
  h.admin.post(`/api/admin/events/${eventId}/photos`).set('content-type', type).set('x-file-name', encodeURIComponent(fileName)).send(data);
const syncsDone = async () => {
  while (h.ctx.syncing.size) await new Promise((r) => setTimeout(r, 20));
  await settle(h);
};
const audit = async () => (await h.admin.get('/api/admin/audit').expect(200)).body.entries.map((x: any) => x.action);

beforeAll(async () => {
  h = await makeHarness({ adminUploadMaxBytes: 2 * 1024 * 1024 });
});
afterAll(() => h.close());
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

describe('a new event gets its OneDrive folder', () => {
  it('makes "<date> <title>" in the Event Photos folder and links it, with characters OneDrive refuses taken out', async () => {
    const out = await create({ title: 'Rajesh / Priya: Wedding?', starts_on: '2026-11-20' });
    expect(out.folder_error).toBeNull();
    expect(out.event.folder.name).toBe('2026-11-20 Rajesh Priya Wedding');
    expect(fs.statSync(path.join(h.driveDir, '2026-11-20 Rajesh Priya Wedding')).isDirectory()).toBe(true);
    expect(await audit()).toContain('event.folder');
  });

  it('uses the title alone when there is no date, and "(2)" when another event has that folder', async () => {
    expect((await create({ title: 'Alumni Meet' })).event.folder.name).toBe('Alumni Meet');
    expect((await create({ title: 'Alumni Meet' })).event.folder.name).toBe('Alumni Meet (2)');
  });

  it('takes over a folder of that name that is already there and reads its photos at once', async () => {
    h.put('2026-12-01 Sports Day', 'a.jpg', await makePhoto(11, [{ person: PERSON.red }]));
    h.put('2026-12-01 Sports Day', 'b.jpg', await makePhoto(12));
    const out = await create({ title: 'Sports Day', starts_on: '2026-12-01' });
    expect(out.event.folder.name).toBe('2026-12-01 Sports Day');
    await syncsDone();
    expect((await h.admin.get(`/api/admin/events/${out.event.id}/progress`).expect(200)).body.counts.shown).toBe(2);
  });

  it('"Make the folder" makes it again after it was unlinked, and a second press changes nothing', async () => {
    const { event } = await create({ title: 'Seminar', starts_on: '2026-12-05' });
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ onedrive_folder_id: null }).expect(200);
    const first = await h.admin.post(`/api/admin/events/${event.id}/folder`).expect(200);
    expect(first.body).toMatchObject({ created: true, event: { folder: { name: '2026-12-05 Seminar' } } });
    const again = await h.admin.post(`/api/admin/events/${event.id}/folder`).expect(200);
    expect(again.body.created).toBe(false);
    expect(again.body.event.folder.id).toBe(first.body.event.folder.id);
  });

  it('two presses at the same moment make one folder', async () => {
    const { event } = await create({ title: 'Race', starts_on: '2026-12-06' });
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ onedrive_folder_id: null }).expect(200);
    fs.rmSync(path.join(h.driveDir, '2026-12-06 Race'), { recursive: true });
    const [a, b] = await Promise.all([h.admin.post(`/api/admin/events/${event.id}/folder`), h.admin.post(`/api/admin/events/${event.id}/folder`)]);
    expect([a.body.created, b.body.created].sort()).toEqual([false, true]);
    expect(fs.readdirSync(h.driveDir).filter((n) => n.startsWith('2026-12-06 Race'))).toEqual(['2026-12-06 Race']);
  });
});

describe('organisers add photos from the admin console', () => {
  let event: any;
  const folder = () => event.folder.name;

  beforeAll(async () => {
    event = (await create({ title: 'Annual Day', starts_on: '2026-11-21' })).event;
  });

  it('saves each photo into the event folder in OneDrive under its own name, shown without review', async () => {
    const res = await send(event.id, await makePhoto(21, [{ person: PERSON.green }]), 'DSC_0042.JPG').expect(201);
    expect(res.body).toMatchObject({ result: 'added', review: 'approved' });
    await send(event.id, await makePhoto(22), 'stage.png', 'image/png').expect(201);
    await settle(h);
    const names = files(folder());
    expect(names).toHaveLength(2);
    expect(names.some((n) => /^DSC_0042-[A-Za-z0-9_-]+\.jpg$/.test(n))).toBe(true);
    expect(names.some((n) => /^stage-[A-Za-z0-9_-]+\.png$/.test(n))).toBe(true);
    expect(fs.existsSync(path.join(h.driveDir, folder(), 'Crowd uploads'))).toBe(false); // not mixed with students' photos

    const media = (await h.admin.get(`/api/admin/events/${event.id}/media?filter=all`).expect(200)).body.media;
    expect(media.every((m: any) => m.source === 'onedrive' && m.review === 'approved' && m.status === 'ready')).toBe(true);
    expect(await audit()).toContain('media.upload');
  });

  it('never replaces a file: two photos with the same name both stay', async () => {
    await send(event.id, await makePhoto(23), 'IMG_1000.jpg').expect(201);
    await send(event.id, await makePhoto(24), 'IMG_1000.jpg').expect(201);
    expect(files(folder()).filter((n) => n.startsWith('IMG_1000-'))).toHaveLength(2);
  });

  it('skips a photo the event already has', async () => {
    const photo = await makePhoto(25);
    await send(event.id, photo, 'one.jpg').expect(201);
    expect((await send(event.id, photo, 'one-again.jpg').expect(200)).body.result).toBe('skipped');
    expect(files(folder()).filter((n) => n.startsWith('one'))).toHaveLength(1);
  });

  it('the next sync finds nothing new, and students find themselves in the uploaded photos', async () => {
    await settle(h);
    const before = (await h.admin.get(`/api/admin/events/${event.id}/progress`).expect(200)).body.counts.total;
    const { summary } = await syncNow(h, event.id);
    expect(summary.listed).toBe(before); // it saw every uploaded file in the folder...
    expect(summary).toMatchObject({ added: 0, changed: 0, removed: 0 }); // ...and knew them all already
    expect((await h.admin.get(`/api/admin/events/${event.id}/progress`).expect(200)).body.counts.total).toBe(before);
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
    const found = await phone(h, 'green').selfie(event.slug, await makeSelfie(PERSON.green)).expect(200);
    expect(found.body.sure).toHaveLength(1);
  });

  it('makes the folder first when the event has none', async () => {
    const { event: bare } = await create({ title: 'Quiz Night', starts_on: '2026-12-10' });
    await h.admin.patch(`/api/admin/events/${bare.id}`).send({ onedrive_folder_id: null }).expect(200);
    fs.rmSync(path.join(h.driveDir, '2026-12-10 Quiz Night'), { recursive: true });
    await send(bare.id, await makePhoto(30)).expect(201);
    const now = (await h.admin.get(`/api/admin/events/${bare.id}`).expect(200)).body.event;
    expect(now.folder.name).toBe('2026-12-10 Quiz Night');
    expect(files('2026-12-10 Quiz Night')).toHaveLength(1);
  });

  it('refuses what is not a photo, what is too large, a closed event, and anyone not signed in', async () => {
    expect((await send(event.id, Buffer.from('%PDF-1.4 not a photo'.repeat(40)), 'a.pdf', 'application/pdf').expect(415)).body.error).toBe('unsupported');
    expect((await send(event.id, Buffer.alloc(4000, 7), 'broken.jpg').expect(400)).body.error).toBe('bad_photo');
    expect((await send(event.id, Buffer.alloc(3 * 1024 * 1024, 1), 'huge.jpg').expect(413)).body.error).toBe('too_large');
    await request(h.app).post(`/api/admin/events/${event.id}/photos`).set('content-type', 'image/jpeg').send(await makePhoto(31)).expect(401);

    const { event: shut } = await create({ title: 'Old Fest', starts_on: '2026-01-01' });
    await h.admin.patch(`/api/admin/events/${shut.id}`).send({ status: 'live' }).expect(200);
    await h.admin.patch(`/api/admin/events/${shut.id}`).send({ status: 'closed' }).expect(200);
    expect((await send(shut.id, await makePhoto(32)).expect(400)).body.error).toBe('closed');
    expect(files('2026-01-01 Old Fest')).toHaveLength(0);
  });

  it('says so when the event folder was deleted in OneDrive, and keeps nothing half-saved', async () => {
    const { event: gone } = await create({ title: 'Lost Folder', starts_on: '2026-12-12' });
    fs.rmSync(path.join(h.driveDir, '2026-12-12 Lost Folder'), { recursive: true });
    const res = await send(gone.id, await makePhoto(33)).expect(409);
    expect(res.body.error).toBe('folder_gone');
    expect((await h.admin.get(`/api/admin/events/${gone.id}/progress`).expect(200)).body.counts.total).toBe(0);
    expect((await h.admin.get(`/api/admin/events/${gone.id}`).expect(200)).body.event.sync_error).toMatch(/no longer in OneDrive/);
  });
});
