/**
 * Phase 1 "Done when": an organiser creates an event, the one QR opens the events list with that
 * event marked coming soon, and the app lists the files in a folder you pick, downloads one photo
 * and saves one test file back.
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, makeEvent, makeHarness, type Harness } from './helpers/harness.js';
import { makePhoto } from './helpers/photos.js';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(() => h.close());

describe('admin sign-in', () => {
  it('refuses a wrong password and an unknown email', async () => {
    await request(h.app).post('/api/admin/login').send({ email: ADMIN.email, password: 'wrong' }).expect(401);
    await request(h.app).post('/api/admin/login').send({ email: 'nobody@college.test', password: ADMIN.password }).expect(401);
  });

  it('keeps the admin console closed without a sign-in', async () => {
    const res = await request(h.app).get('/api/admin/events').expect(401);
    expect(res.body.error).toBe('sign_in');
  });

  it('signs in with an HttpOnly cookie and knows who you are', async () => {
    const res = await request(h.app).post('/api/admin/login').send(ADMIN).expect(200);
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    expect(res.headers['set-cookie'][0]).toMatch(/SameSite=Lax/);
    expect(res.headers['set-cookie'][0]).not.toMatch(/Secure/); // plain http, as on localhost
    const overHttps = await request(h.app).post('/api/admin/login').set('x-forwarded-proto', 'https').send(ADMIN).expect(200);
    expect(overHttps.headers['set-cookie'][0]).toMatch(/; Secure/); // behind the HTTPS proxy the cookie is HTTPS-only
    const me = await h.admin.get('/api/admin/me').expect(200);
    expect(me.body.user.email).toBe(ADMIN.email);
    expect(me.body.drive).toBe('local');
  });

  it('slows down after five wrong passwords', async () => {
    for (let i = 0; i < 5; i++) await request(h.app).post('/api/admin/login').send({ email: 'slow@college.test', password: 'x' }).expect(401);
    await request(h.app).post('/api/admin/login').send({ email: 'slow@college.test', password: 'x' }).expect(429);
  });
});

describe('events and the one link', () => {
  let event: any;

  it('creates an event that is listed as coming soon', async () => {
    event = await makeEvent(h, 'Annual Day 2026');
    expect(event.slug).toBe('annual-day-2026');
    expect(event.status).toBe('draft');
    expect(event.link).toBe('https://photos.college.test/e/annual-day-2026');

    const list = await request(h.app).get('/api/events').expect(200);
    expect(list.body.org).toBe('Test College');
    const e = list.body.events.find((x: any) => x.slug === event.slug);
    expect(e.state).toBe('draft');
    expect(e.starts_on).toBe('2026-11-20');
    // Its OneDrive folder is made and linked at once, so students can already add photos to a Draft event.
    expect(event.folder.name).toBe('2026-11-20 Annual Day 2026');
    expect(fs.existsSync(path.join(h.driveDir, '2026-11-20 Annual Day 2026'))).toBe(true);
    expect(e.options).toEqual({ find: false, album: false, album_locked: false, upload: true, download: true });
  });

  it('gives a second event with the same name its own address', async () => {
    const twin = await makeEvent(h, 'Annual Day 2026');
    expect(twin.slug).toBe('annual-day-2026-2');
    expect(twin.folder.name).toBe('2026-11-20 Annual Day 2026 (2)'); // the first one's folder is not shared
    await h.admin.delete(`/api/admin/events/${twin.id}`).expect(200);
  });

  it('rejects bad input with a readable message', async () => {
    const res = await h.admin.post('/api/admin/events').send({ title: 'x', starts_on: '20-11-2026' }).expect(400);
    expect(res.body.error).toBe('invalid_input');
  });

  it('serves the one QR as SVG and PNG', async () => {
    const svg = await h.admin.get('/api/admin/qr').expect(200);
    expect(svg.headers['content-type']).toMatch(/svg/);
    expect(String(svg.body)).toMatch(/<svg/);
    const png = await h.admin.get('/api/admin/qr?format=png').expect(200);
    expect(png.headers['content-type']).toMatch(/png/);
    expect(png.body.subarray(1, 4).toString()).toBe('PNG');
    await request(h.app).get('/api/admin/qr').expect(401);
  });

  it('lists the folders of the drive for the picker, and can make one', async () => {
    h.put('2026-11-20 Annual Day', 'IMG_0001.jpg', await makePhoto(1));
    h.put('2026-11-20 Annual Day', 'IMG_0002.jpg', await makePhoto(2));
    h.put('Sports Meet', 'a.jpg', await makePhoto(3));
    const made = await h.admin.post('/api/admin/onedrive/folders').send({ name: 'Freshers Party' }).expect(201);
    expect(made.body.folder.name).toBe('Freshers Party');
    const res = await h.admin.get('/api/admin/onedrive/folders').expect(200);
    // The two made with the events are there too; a deleted event's folder stays in OneDrive.
    expect(res.body.folders.map((f: any) => f.name).sort()).toEqual(['2026-11-20 Annual Day', '2026-11-20 Annual Day 2026', '2026-11-20 Annual Day 2026 (2)', 'Freshers Party', 'Sports Meet']);
  });

  it('links the picked folder to the event, and only one event per folder', async () => {
    const folders = (await h.admin.get('/api/admin/onedrive/folders')).body.folders;
    const pick = folders.find((f: any) => f.name === '2026-11-20 Annual Day');
    const res = await h.admin.patch(`/api/admin/events/${event.id}`).send({ onedrive_folder_id: pick.id }).expect(200);
    expect(res.body.event.folder).toEqual({ id: pick.id, name: '2026-11-20 Annual Day' });

    const other = await makeEvent(h, 'Sports Meet');
    const clash = await h.admin.patch(`/api/admin/events/${other.id}`).send({ onedrive_folder_id: pick.id }).expect(400);
    expect(clash.body.error).toBe('folder_in_use');
    await h.admin.patch(`/api/admin/events/${other.id}`).send({ onedrive_folder_id: 'not-a-folder' }).expect(400);
  });

  it('passes the connection test: list, download one photo, save a test file and remove it', async () => {
    const ev = (await h.admin.get(`/api/admin/events/${event.id}`)).body.event;
    const res = await h.admin.post('/api/admin/onedrive/test').send({ folder_id: ev.folder.id }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.steps.map((s: any) => s.ok)).toEqual([true, true, true, true]);
    expect(res.body.steps[1].detail).toBe('2 files');
    expect(res.body.steps[2].detail).toMatch(/IMG_0001\.jpg, \d+ bytes/);
    // nothing is left behind in the organiser's folder
    expect(fs.readdirSync(path.join(h.driveDir, '2026-11-20 Annual Day')).sort()).toEqual(['IMG_0001.jpg', 'IMG_0002.jpg']);
  });

  it('opens Add your photos in Draft once the folder is linked', async () => {
    const e = (await request(h.app).get(`/api/e/${event.slug}`).expect(200)).body.event;
    expect(e.state).toBe('draft');
    expect(e.options.upload).toBe(true);
    expect(e.options.find).toBe(false);
  });

  it('needs a folder before an event can go Live', async () => {
    const bare = await makeEvent(h, 'No Folder Yet');
    await h.admin.patch(`/api/admin/events/${bare.id}`).send({ onedrive_folder_id: null }).expect(200);
    const res = await h.admin.patch(`/api/admin/events/${bare.id}`).send({ status: 'live' }).expect(400);
    expect(res.body.error).toBe('no_folder');
  });

  it('shows the right options in each state', async () => {
    const state = async () => (await request(h.app).get(`/api/e/${event.slug}`)).body.event;
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
    expect((await state()).options).toMatchObject({ find: true, album: true, album_locked: false, upload: true });

    await h.admin.patch(`/api/admin/events/${event.id}`).send({ passcode: '4821', face_enabled: false }).expect(200);
    expect((await state()).options).toMatchObject({ find: false, album: true, album_locked: true });
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ passcode: null, face_enabled: true }).expect(200);

    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'closed' }).expect(200);
    expect((await state()).options).toMatchObject({ find: true, album: true, upload: false });

    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'archived' }).expect(200);
    const gone = await state();
    expect(gone.state).toBe('archived');
    expect(gone.options.album).toBe(false);
    const list = (await request(h.app).get('/api/events')).body.events;
    expect(list.find((x: any) => x.slug === event.slug)).toBeUndefined();
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'draft' }).expect(200);
  });

  it('keeps an unlisted event off the list but reachable by its direct link', async () => {
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ listed: false }).expect(200);
    const list = (await request(h.app).get('/api/events')).body.events;
    expect(list.find((x: any) => x.slug === event.slug)).toBeUndefined();
    await request(h.app).get(`/api/e/${event.slug}`).expect(200);
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ listed: true }).expect(200);
  });

  it('lists the newest event first', async () => {
    await h.admin.post('/api/admin/events').send({ title: 'Old Fest', starts_on: '2025-01-10' }).expect(201);
    await h.admin.post('/api/admin/events').send({ title: 'Next Fest', starts_on: '2027-02-01' }).expect(201);
    const dates = (await request(h.app).get('/api/events')).body.events.map((e: any) => e.starts_on).filter(Boolean);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(dates[0]).toBe('2027-02-01');
  });

  it('answers unknown events and routes with a clear 404', async () => {
    await request(h.app).get('/api/e/no-such-event').expect(404);
    await request(h.app).get('/api/nothing-here').expect(404);
  });

  it('writes who did what to the audit log', async () => {
    const rows = (await h.ctx.db.query(`select action from audit_log where actor = $1`, [ADMIN.email])).rows.map((r: any) => r.action);
    expect(rows).toEqual(expect.arrayContaining(['login', 'event.create', 'event.update', 'onedrive.test']));
  });
});

describe('the team and passwords (plan: Roles)', () => {
  const ORGANISER = { email: 'priya@college.test', password: 'a-second-long-password' };

  it('a super admin adds an organiser, who runs events but cannot manage the team or connect OneDrive', async () => {
    expect((await h.admin.get('/api/admin/team').expect(200)).body.team).toHaveLength(1);
    expect((await h.admin.post('/api/admin/team').send({ email: 'not-an-email', password: ORGANISER.password }).expect(400)).body.error).toBe('invalid_input');
    expect((await h.admin.post('/api/admin/team').send({ email: ORGANISER.email, password: 'short' }).expect(400)).body.message).toMatch(/10 characters/);
    const made = await h.admin.post('/api/admin/team').send({ email: 'Priya@College.Test', password: ORGANISER.password }).expect(201);
    expect(made.body.member).toMatchObject({ email: ORGANISER.email, role: 'organiser' });
    expect((await h.admin.post('/api/admin/team').send(ORGANISER).expect(409)).body.error).toBe('exists');

    const priya = request.agent(h.app);
    expect((await priya.post('/api/admin/login').send(ORGANISER).expect(200)).body.user.role).toBe('organiser');
    await priya.post('/api/admin/events').send({ title: 'Organiser Event' }).expect(201); // events are hers to run
    expect((await priya.get('/api/admin/team').expect(403)).body.error).toBe('super_admin_only');
    await priya.post('/api/admin/team').send({ email: 'x@college.test', password: 'another-long-password' }).expect(403);
    expect((await priya.get('/api/admin/onedrive/status').expect(200)).body.setup.may_connect).toBe(false);
    expect((await priya.get('/admin/onedrive/connect').expect(302)).headers.location).toMatch(/onedrive=error.*super%20admin/);
  });

  it('signs an organiser out at once when the password is reset or the account is removed', async () => {
    const id = (await h.admin.get('/api/admin/team')).body.team.find((u: any) => u.email === ORGANISER.email).id;
    const priya = request.agent(h.app);
    await priya.post('/api/admin/login').send(ORGANISER).expect(200);
    await priya.get('/api/admin/events').expect(200);

    await h.admin.patch(`/api/admin/team/${id}`).send({ password: 'a-brand-new-password' }).expect(200);
    await priya.get('/api/admin/events').expect(401); // the old session ended with the old password
    await request(h.app).post('/api/admin/login').send(ORGANISER).expect(401);
    await priya.post('/api/admin/login').send({ email: ORGANISER.email, password: 'a-brand-new-password' }).expect(200);
    await priya.get('/api/admin/events').expect(200);

    await h.admin.delete(`/api/admin/team/${id}`).expect(200);
    await priya.get('/api/admin/events').expect(401);
    await request(h.app).post('/api/admin/login').send({ email: ORGANISER.email, password: 'a-brand-new-password' }).expect(401);
  });

  it('changes my own password: the old one stops working and this browser stays signed in', async () => {
    expect((await h.admin.post('/api/admin/password').send({ current: 'wrong', password: 'a-new-long-password' }).expect(403)).body.error).toBe('wrong_password');
    const other = request.agent(h.app);
    await other.post('/api/admin/login').send(ADMIN).expect(200);
    await h.admin.post('/api/admin/password').send({ current: ADMIN.password, password: 'a-new-long-password' }).expect(200);
    await h.admin.get('/api/admin/me').expect(200); // still signed in here
    await other.get('/api/admin/me').expect(401); // every other session of the account ended
    await request(h.app).post('/api/admin/login').send(ADMIN).expect(401);
    await h.admin.post('/api/admin/password').send({ current: 'a-new-long-password', password: ADMIN.password }).expect(200); // back, for the tests that follow
    await request(h.app).post('/api/admin/login').send(ADMIN).expect(200);
  });

  it('always keeps one super admin, and nobody removes their own account', async () => {
    const me = (await h.admin.get('/api/admin/me')).body.user;
    expect((await h.admin.delete(`/api/admin/team/${me.id}`).expect(400)).body.error).toBe('yourself');
    expect((await h.admin.patch(`/api/admin/team/${me.id}`).send({ role: 'organiser' }).expect(400)).body.error).toBe('last_super_admin');
    const second = (await h.admin.post('/api/admin/team').send({ email: 'head@college.test', password: 'a-third-long-password', role: 'super_admin' }).expect(201)).body.member;
    await h.admin.patch(`/api/admin/team/${second.id}`).send({ role: 'organiser' }).expect(200);
    await h.admin.delete(`/api/admin/team/${second.id}`).expect(200);
    await h.admin.delete('/api/admin/team/not-an-id').expect(404);
  });
});

describe('getting ready for the real OneDrive', () => {
  it('tells the settings screen what to register with Microsoft', async () => {
    const res = await h.admin.get('/api/admin/onedrive/status').expect(200);
    expect(res.body.setup).toEqual({ redirect_uri: h.ctx.cfg.ms.redirectUri, https: true, may_connect: true });
    expect(res.body.setup.redirect_uri).toMatch(/\/admin\/onedrive\/callback$/);
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig({ PUBLIC_URL: 'https://photos.college.test/' }).ms.redirectUri).toBe('https://photos.college.test/admin/onedrive/callback');
    expect(res.body.status).toMatchObject({ kind: 'local', connected: true });
  });

  it('passes "Check everything" on the stand-in folder and leaves nothing behind', async () => {
    const before = fs.readdirSync(h.driveDir).sort();
    const res = await h.admin.post('/api/admin/onedrive/check').send({}).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.steps).toHaveLength(13);
    expect(res.body.report).toContain('PASS  A link from a listing opens');
    expect(res.body.report).toContain('PASS  A renamed file keeps its identity');
    expect(fs.readdirSync(h.driveDir).sort()).toEqual(before);
  });

  it('uses OneDrive by itself once the three Microsoft values are filled in', async () => {
    const { loadConfig } = await import('../src/config.js');
    const ms = { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's' };
    expect(loadConfig({}).drive).toBe('local');
    expect(loadConfig(ms).drive).toBe('graph');
    expect(loadConfig({ ...ms, DRIVE: 'local' }).drive).toBe('local');
    expect(loadConfig({ ...ms, MS_ROOT: 'folder' }).ms.scope).toBe('offline_access User.Read Files.ReadWrite');
    expect(() => loadConfig({ DRIVE: 'graph' })).toThrow(/MS_TENANT_ID/);
  });
});
