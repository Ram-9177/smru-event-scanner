/**
 * The whole app on the OneDrive adapter, from "Connect OneDrive" to a student's photos,
 * against an imitation of Microsoft's endpoints (test/helpers/mock-graph.ts).
 * This is as close as a test can get without a real Microsoft 365: the real check is
 * Settings > Check everything, after you connect your college account.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEvent, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { startMockGraph, type MockGraph } from './helpers/mock-graph.js';
import { chatCopy, makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
let mock: MockGraph;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-onedrive-'));
const status = async () => (await h.admin.get('/api/admin/onedrive/status').expect(200)).body.status;
const settingsQuery = (res: request.Response) => new URL(res.headers.location, 'http://x').searchParams;

beforeAll(async () => {
  mock = await startMockGraph(path.join(root, 'onedrive'), { pageSize: 3 });
  h = await makeHarness(
    {
      drive: 'graph',
      ms: {
        tenantId: 'college-tenant',
        clientId: 'client-1',
        clientSecret: 'mock-secret',
        redirectUri: 'https://photos.college.test/admin/onedrive/callback',
        scope: 'offline_access User.Read Files.ReadWrite.AppFolder',
        root: 'approot',
        rootFolderName: 'Event Photos',
        rootLink: '',
        graphBase: mock.graphBase,
        loginBase: mock.loginBase,
      },
    },
    { driveDir: mock.dir },
  );
});
afterAll(async () => {
  await h.close();
  await mock.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The whole round trip a browser makes: the app sends it to Microsoft's sign-in page, Microsoft sends it back
 * to the registered redirect URI with a one-time code (or an error), and the app finishes the sign-in.
 */
async function signInAtMicrosoft(connectPath = '/admin/onedrive/connect') {
  const go = await h.admin.get(connectPath).expect(302);
  const ms = new URL(go.headers.location);
  const atMicrosoft = await fetch(ms, { redirect: 'manual' });
  expect(atMicrosoft.status).toBe(302);
  const cb = new URL(atMicrosoft.headers.get('location')!);
  expect(cb.origin + cb.pathname).toBe('https://photos.college.test/admin/onedrive/callback'); // exactly the registered address
  return { ms, back: await h.admin.get(`/admin/onedrive/callback${cb.search}`).expect(302) };
}

const signInAtMicrosoftAgain = () => signInAtMicrosoft('/admin/onedrive/connect?mode=approot');

describe('Connect OneDrive', () => {
  it('starts not connected, and says so instead of failing', async () => {
    expect(await status()).toMatchObject({ kind: 'graph', connected: false, needsReconnect: false });
    expect((await h.admin.get('/api/admin/onedrive/folders').expect(409)).body.error).toBe('reconnect_onedrive');
    const check = (await h.admin.post('/api/admin/onedrive/check').send({}).expect(200)).body;
    expect(check).toMatchObject({ ok: false });
    expect(check.steps[0]).toMatchObject({ step: 'Signed in', ok: false, detail: 'OneDrive is not connected yet. Press Connect OneDrive.' });
  });

  it("sends the super admin to Microsoft's sign-in page for the college's directory, asking only for the app's own folder", async () => {
    const go = await h.admin.get('/admin/onedrive/connect').expect(302);
    const ms = new URL(go.headers.location);
    expect(ms.origin + ms.pathname).toBe(`${mock.loginBase}/college-tenant/oauth2/v2.0/authorize`);
    expect(Object.fromEntries(ms.searchParams)).toMatchObject({
      client_id: 'client-1',
      response_type: 'code',
      redirect_uri: 'https://photos.college.test/admin/onedrive/callback',
      scope: 'offline_access User.Read Files.ReadWrite.AppFolder',
    });
    expect(ms.searchParams.get('state')!.length).toBeGreaterThan(20);
    expect((await request(h.app).get('/admin/onedrive/connect').expect(302)).headers.location).toBe('/admin/login'); // not signed in
  });

  it('refuses a callback that did not start here, and explains when the permission screen was cancelled', async () => {
    const forged = await h.admin.get('/admin/onedrive/callback?code=good-code&state=made-up').expect(302);
    expect(settingsQuery(forged).get('onedrive')).toBe('error');
    mock.cancelSignIn(true);
    const { back } = await signInAtMicrosoft();
    mock.cancelSignIn(false);
    expect(settingsQuery(back).get('reason')).toMatch(/pressed Cancel.*AADSTS65004/);
    expect((await status()).connected).toBe(false);
  });

  it('when the Microsoft 365 does not open the app folder, says so and offers the wider permission', async () => {
    mock.refuseAppFolder(403);
    const { back } = await signInAtMicrosoft();
    expect(settingsQuery(back).get('onedrive')).toBe('appfolder');
    expect(settingsQuery(back).get('reason')).toMatch(/did not open the app's own folder/);
    expect((await status()).connected).toBe(false);

    const wider = await signInAtMicrosoft('/admin/onedrive/connect?mode=folder');
    expect(wider.ms.searchParams.get('scope')).toBe('offline_access User.Read Files.ReadWrite');
    expect(settingsQuery(wider.back).get('onedrive')).toBe('connected');
    expect(await status()).toMatchObject({ connected: true, mode: 'folder', rootName: 'Event Photos', account: 'faculty@college.test' });
    mock.refuseAppFolder(null);
  });

  it("connects with the app's own folder when the Microsoft 365 allows it", async () => {
    const { back } = await signInAtMicrosoft('/admin/onedrive/connect?mode=approot');
    expect(settingsQuery(back).get('onedrive')).toBe('connected');
    expect(await status()).toMatchObject({ connected: true, mode: 'approot', rootName: 'Apps > Event Photos', quota: { total: 1000, used: 400, remaining: 600 } });
    const log = (await h.admin.get('/api/admin/audit')).body.entries.filter((e: any) => e.action === 'onedrive.connect');
    expect(log.map((e: any) => e.detail.mode)).toEqual(['approot', 'folder']);
  });

  it('passes "Check everything" through the admin console', async () => {
    const out = (await h.admin.post('/api/admin/onedrive/check').send({}).expect(200)).body;
    expect(out.steps.filter((s: any) => !s.ok)).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.report).toContain("the app can reach the app's own folder only");
    expect(fs.readdirSync(mock.dir).filter((n) => n.startsWith('event-photos-check'))).toEqual([]);
  });
});

describe('one event, end to end, on OneDrive', () => {
  let event: any;
  const FOLDER = '2026-11-20 Annual Day';
  const official: Buffer[] = [];

  it('makes the event folder from the admin console and links it', async () => {
    const made = (await h.admin.post('/api/admin/onedrive/folders').send({ name: FOLDER }).expect(201)).body.folder;
    expect(fs.existsSync(path.join(mock.dir, FOLDER))).toBe(true);
    event = await makeEvent(h, 'Annual Day 2026', undefined, { auto_approve: false }); // students' photos wait for review here
    event = (await h.admin.patch(`/api/admin/events/${event.id}`).send({ onedrive_folder_id: made.id }).expect(200)).body.event;
    expect(event.folder).toEqual({ id: made.id, name: FOLDER });
    const test = (await h.admin.post('/api/admin/onedrive/test').send({ folder_id: made.id }).expect(200)).body;
    expect(test.ok).toBe(true);
  });

  it('syncs the folder and a subfolder, page by page; a second sync finds nothing new', async () => {
    for (let i = 0; i < 7; i++) {
      official.push(await makePhoto(800 + i, i < 3 ? [{ person: PERSON.red }] : [{ person: PERSON.blue }]));
      h.put(i < 5 ? FOLDER : `${FOLDER}/Stage`, `IMG_${i}.jpg`, official[i]);
    }
    h.put(FOLDER, 'notes.docx', Buffer.from('not a photo or a video'));
    const first = await syncNow(h, event.id);
    expect(first.counts).toMatchObject({ shown: 7, skipped: 1, failed: 0, faces: 7 });
    expect(mock.log.filter((l) => l.includes('$skiptoken') || /children$/.test(l)).length).toBeGreaterThan(2); // more than one page was read
    const n = mock.log.filter((l) => l.endsWith('/content')).length;
    const second = await syncNow(h, event.id);
    expect(second.summary).toMatchObject({ added: 0, processed: 0, removed: 0 });
    expect(mock.log.filter((l) => l.endsWith('/content')).length).toBe(n); // nothing was downloaded again
    expect(mock.leakedToken()).toBe(false);
  });

  it('a student finds their photos, and adds one: it is saved into Crowd uploads in OneDrive', async () => {
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
    const p = phone(h, 'riya');
    expect((await p.selfie(event.slug, await makeSelfie(PERSON.red)).expect(200)).body.sure).toHaveLength(3);
    expect((await p.upload(event.slug, await chatCopy(official[0])).expect(200)).body.result).toBe('skipped'); // a chat copy of an official photo
    const up = (await p.upload(event.slug, await makePhoto(820, [{ person: PERSON.red }]), 'image/jpeg', 'Riya').expect(201)).body;
    await settle(h);
    const dir = path.join(mock.dir, FOLDER, 'Crowd uploads');
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect((await syncNow(h, event.id)).counts).toMatchObject({ shown: 7, review: 1 });

    // rejected: the file is deleted from OneDrive through Graph, and the picture is refused from then on
    await h.admin.patch('/api/admin/media').send({ ids: [up.id], action: 'reject' }).expect(200);
    expect(fs.readdirSync(dir)).toHaveLength(0);
    expect(mock.log.some((l) => l.startsWith('DELETE /v1.0/drives/drive1/items/'))).toBe(true);
  });

  it('hands a student the original (a photo: fetched through a short-lived OneDrive link, without the app\'s token, its GPS position taken out)', async () => {
    const p = phone(h, 'riya');
    const mine = (await p.get(`/api/e/${event.slug}/mine`).expect(200)).body.sure;
    const n = mock.log.length;
    const res = await p.get(`/api/e/${event.slug}/original/${mine[0].id}`).expect(200);
    expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(mock.log.slice(n).some((l) => l.startsWith('GET /dl/'))).toBe(true);
    expect(mock.leakedToken()).toBe(false);
  });

  it('keeps every album copy in OneDrive\'s app folder, and sends phones to a short-lived OneDrive link for it', async () => {
    const copies = path.join(mock.dir, '_app copies (do not edit)', event.id);
    expect(fs.readdirSync(copies).sort()).toEqual(['s', 't', 'w']);
    expect(fs.readdirSync(path.join(copies, 't'))).toHaveLength(7);
    const p = phone(h, 'riya');
    const album = (await p.get(`/api/e/${event.slug}/album`).expect(200)).body.photos;
    await settle(h); // the album page listed t/ once and cached every link
    const before = mock.log.length;
    const res = await request(h.app).get(album[0].thumb).redirects(0).expect(302);
    expect(res.headers.location).toMatch(new RegExp(`^${mock.base}/dl/G.+tempauth=`));
    expect(mock.log.slice(before).filter((l) => l.startsWith('GET /v1.0'))).toEqual([]); // from the cache: no Graph call
    const img = await fetch(res.headers.location!);
    expect(img.status).toBe(200);
    expect((await sharp(Buffer.from(await img.arrayBuffer())).metadata()).format).toBe('webp');
    // pipe=1 (share and save in the viewer): through the app from the same link
    const piped = await request(h.app).get(`${album[0].web}&pipe=1`).expect(200);
    expect(piped.headers['content-type']).toBe('image/webp');
    expect(fs.existsSync(path.join(h.ctx.cfg.dataDir, 'media'))).toBe(false);
    expect(mock.leakedToken()).toBe(false);
  });

  it('carries on through a cut connection', async () => {
    h.put(FOLDER, 'late-1.jpg', await makePhoto(830));
    h.put(FOLDER, 'late-2.jpg', await makePhoto(831));
    mock.dropNext(1);
    expect((await syncNow(h, event.id)).counts).toMatchObject({ shown: 9, failed: 0 });
  });

  it('does not drop a photo that OneDrive lists but cannot hand over for a moment; a hidden photo stays hidden', async () => {
    const total = async () => (await phone(h, 'riya').get(`/api/e/${event.slug}/album`).expect(200)).body.total;
    const rows = (await h.admin.get(`/api/admin/events/${event.id}/media?limit=50`)).body.media;
    const hidden = rows.find((m: any) => m.name === 'IMG_3.jpg');
    await h.admin.patch('/api/admin/media').send({ ids: [hidden.id], action: 'hide' }).expect(200);
    expect(await total()).toBe(8);

    // the hidden photo is edited in OneDrive; when the app asks for it, OneDrive answers "not found" every time
    h.put(FOLDER, 'IMG_3.jpg', await makePhoto(850, [{ person: PERSON.blue }]));
    mock.loseNext(50);
    let p = await syncNow(h, event.id);
    expect(p.summary).toMatchObject({ changed: 1, removed: 0, failed: 0 });
    expect(p.counts).toMatchObject({ total: 11, waiting: 1, failed: 0 }); // it waits: not removed, not failed
    mock.loseNext(0);
    p = await syncNow(h, event.id);
    expect(p.counts).toMatchObject({ total: 11, waiting: 0, shown: 8, hidden: 1 }); // read now, and still hidden
    expect(await total()).toBe(8);
    expect((await h.admin.get(`/api/admin/events/${event.id}/media?filter=hidden`)).body.media.map((m: any) => m.id)).toEqual([hidden.id]);

    // one "not found" in the middle of a sync is simply tried again in the same sync
    h.put(FOLDER, 'late-3.jpg', await makePhoto(832));
    h.put(FOLDER, 'late-4.jpg', await makePhoto(833));
    mock.loseNext(1);
    expect((await syncNow(h, event.id)).counts).toMatchObject({ shown: 10, waiting: 0, failed: 0 });
    await h.admin.patch('/api/admin/media').send({ ids: [hidden.id], action: 'unhide' }).expect(200);
  });

  it('refuses a sign-in as a different account while events have folders, unless the super admin means to switch', async () => {
    mock.signInAs('someone.else@college.test');
    const { back } = await signInAtMicrosoftAgain();
    expect(settingsQuery(back).get('onedrive')).toBe('account');
    expect(settingsQuery(back).get('reason')).toBe('You signed in as someone.else@college.test, but the event folders are in the OneDrive of faculty@college.test. Sign in as faculty@college.test.');
    expect(await status()).toMatchObject({ connected: true, account: 'faculty@college.test' }); // nothing changed
    expect((await syncNow(h, event.id)).sync_error).toBeNull();

    const switched = await signInAtMicrosoft('/admin/onedrive/connect?mode=approot&switch=1');
    expect(settingsQuery(switched.back).get('onedrive')).toBe('connected');
    expect((await status()).account).toBe('someone.else@college.test');
    mock.signInAs('faculty@college.test');
    await signInAtMicrosoft('/admin/onedrive/connect?mode=approot&switch=1');
    expect((await status()).account).toBe('faculty@college.test');
  });

  it('asks for Reconnect OneDrive when the sign-in was revoked, shows it on the sync screen, and carries on after reconnecting', async () => {
    const { syncEvent } = await import('../src/sync/sync.js');
    h.put(FOLDER, 'after.jpg', await makePhoto(840));
    mock.revokeSignIn();
    mock.expireAccessTokens();
    await expect(syncEvent(h.ctx, event.id)).rejects.toThrow(/connected again/);
    expect((await h.admin.get(`/api/admin/events/${event.id}/progress`)).body.sync_error).toBe('Reconnect OneDrive.');
    expect(await status()).toMatchObject({ connected: false, needsReconnect: true });
    expect((await phone(h, 'riya').upload(event.slug, await makePhoto(841)).expect(503)).body.error).toBe('busy'); // students are told to try later
    expect((await phone(h, 'riya').get(`/api/e/${event.slug}/album`).expect(200)).body.total).toBe(11); // the album keeps working from the display copies

    // reconnected: the same sync button carries on
    const { back } = await signInAtMicrosoftAgain();
    expect(new URL(back.headers.location, 'http://x').searchParams.get('onedrive')).toBe('connected');
    const p = await syncNow(h, event.id);
    expect(p.counts).toMatchObject({ shown: 12, failed: 0 });
    expect(p.sync_error).toBeNull();
  });
});

describe('moving from the stand-in folder to OneDrive (adopt-local-files)', () => {
  it('uploads the originals into the event folder, and the copies are then made in OneDrive', async () => {
    const { adoptLocalFiles } = await import('../src/cli/adopt-local-files.js');
    const { LocalDrive } = await import('../src/drive/local.js');
    const { rebuildPass } = await import('../src/media/rebuild.js');
    const local = new LocalDrive(path.join(root, 'stand-in'), { secret: 'stand-in-secret' });
    const folder = await local.createFolder(null, 'Old Day');
    const original = await local.upload(folder.id, 'old.jpg', await makePhoto(990, [{ person: PERSON.red }]));
    const copiesDir = await local.createFolder(null, '_app copies (do not edit)');
    const t = await local.upload(copiesDir.id, 'old-t.webp', await sharp(await makePhoto(990)).webp().toBuffer());
    const ev = (await h.admin.post('/api/admin/events').send({ title: 'Old Day', starts_on: '2026-01-05' }).expect(201)).body.event;
    const id = (
      await h.ctx.db.query<{ id: string }>(
        `insert into media (event_id, type, status, name, onedrive_item_id, thumb_key, web_key, sha256) values ($1, 'photo', 'ready', 'old.jpg', $2, $3, $3, 'x') returning id`,
        [ev.id, original.id, `od/${t.id}/${t.name}`],
      )
    ).rows[0].id;
    await adoptLocalFiles(h.ctx, local, () => {});
    const moved = (await h.ctx.db.query<any>(`select * from media where id = $1`, [id])).rows[0];
    expect(moved.onedrive_item_id).toMatch(/^G/); // a OneDrive item now
    expect(moved.copies_missing).toBe(true);
    await rebuildPass(h.ctx);
    await settle(h);
    const after = (await h.ctx.db.query<any>(`select * from media where id = $1`, [id])).rows[0];
    expect(after.copies_missing).toBe(false);
    for (const k of [after.thumb_key, after.web_key, after.scene_key]) expect(k).toMatch(/^od\/G/);
    expect(fs.readdirSync(path.join(mock.dir, '_app copies (do not edit)', ev.id, 't'))).toHaveLength(1);
  });
});
