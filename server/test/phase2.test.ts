/**
 * Phase 2 "Done when": 500 photos sync from a folder, a second sync picks up only new files,
 * faces found are shown, and the same file dropped in twice shows once.
 * Plus every row of the plan's sync rules table.
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { upgradeOldCopies } from '../src/media/upgrade.js';
import { prepare } from '../src/media/prepare.js';
import { expectNoLocalMedia, copyFiles, copyPath, fetchImage, makeEvent, makeHarness, settle, syncNow, type Harness } from './helpers/harness.js';
import { chatCopy, makePhoto, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
const FOLDER = '2026-11-20 Annual Day';
const dir = () => path.join(h.driveDir, FOLDER);
const media = async (filter = 'all') => (await h.admin.get(`/api/admin/events/${event.id}/media?filter=${filter}&limit=200`).expect(200)).body;
const byName = async (name: string) => (await media()).media.find((m: any) => m.name === name);
const faceRows = async (mediaId: string) => (await h.ctx.db.query(`select count(*)::int as n from faces where media_id = $1`, [mediaId])).rows[0].n;

beforeAll(async () => {
  h = await makeHarness();
  event = await makeEvent(h, 'Annual Day 2026', FOLDER);
});
afterAll(() => h.close());
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

describe('first sync', () => {
  it('needs a folder', async () => {
    const bare = await makeEvent(h, 'No folder');
    await h.admin.patch(`/api/admin/events/${bare.id}`).send({ onedrive_folder_id: null }).expect(200);
    const res = await h.admin.post(`/api/admin/events/${bare.id}/sync`).expect(400);
    expect(res.body.error).toBe('no_folder');
  });

  it('syncs a folder: display copies, face vectors and counters', async () => {
    h.put(FOLDER, 'IMG_0001.jpg', await makePhoto(1, [{ person: PERSON.red }, { person: PERSON.blue }]));
    h.put(FOLDER, 'IMG_0002.jpg', await makePhoto(2, [{ person: PERSON.red }]));
    h.put(FOLDER, 'IMG_0003.png', await makePhoto(3, [], { format: 'png' }));
    h.put(FOLDER, 'IMG_0004.webp', await makePhoto(4, [{ person: PERSON.green }], { format: 'webp' }));
    const p = await syncNow(h, event.id);
    expect(p.summary).toMatchObject({ listed: 4, added: 4, processed: 4, copies: 0, failed: 0 });
    expect(p.counts).toMatchObject({ total: 4, shown: 4, waiting: 0, processing: 0, failed: 0, skipped: 0, copies: 0, faces: 4, no_faces: 1 });
    expect(p.syncing).toBe(false);
    expect(p.last_sync_at).toBeTruthy();

    const m = await byName('IMG_0001.jpg');
    expect(m).toMatchObject({ status: 'ready', review: 'approved', hidden: false, source: 'onedrive', face_count: 2, width: 800, height: 600, duplicate_of: null });
    expect(await faceRows(m.id)).toBe(2);
    const row = (await h.ctx.db.query(`select thumb_key, web_key, sha256, phash from media where id = $1`, [m.id])).rows[0];
    // The album's copies are light WebP files in OneDrive's app folder (by event and kind, a new name each time);
    // the original keeps the full quality for downloads. Nothing is kept on this server.
    expect(row.thumb_key).toMatch(new RegExp(`^od/[^/]+/${m.id}-[0-9a-z]{6}\\.webp$`));
    expect(row.web_key).toMatch(new RegExp(`^od/[^/]+/${m.id}-[0-9a-z]{6}\\.webp$`));
    expect(copyFiles(h, event.id, 't')).toContain(row.thumb_key.split('/').pop());
    expect(copyFiles(h, event.id, 'w')).toContain(row.web_key.split('/').pop());
    expect(await sharp(copyPath(h, row.thumb_key)).metadata()).toMatchObject({ format: 'webp', width: 400 });
    expect(await sharp(copyPath(h, row.web_key)).metadata()).toMatchObject({ format: 'webp', width: 800 }); // never enlarged
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.phash.length).toBe(32);
  });

  it('serves a thumbnail through a signed link, and refuses a changed or expired link', async () => {
    const m = await byName('IMG_0001.jpg');
    // The app checks the link, then sends the phone to the copy in OneDrive (a short-lived link, kept 0 seconds by an organiser's browser).
    const ok = await fetchImage(h, m.thumb);
    expect(ok.redirected).toBe(true);
    expect(ok.cache).toBe('private, no-store');
    expect(ok.status).toBe(200);
    expect(ok.type).toMatch(/^image\/webp/);
    await request(h.app).get(m.thumb.replace(/s=.{4}/, 's=AAAA')).expect(403);
    await request(h.app).get(m.thumb.replace(/e=\d+/, 'e=1000')).expect(403);
    await request(h.app).get(m.thumb.replace('/t?', '/w?')).expect(403); // a thumbnail link does not open the larger copy
  });

  it('shows the event cover and photo count on the one link once Live', async () => {
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
    const e = (await request(h.app).get('/api/events')).body.events.find((x: any) => x.slug === event.slug);
    expect(e.photos).toBe(4);
    expect((await fetchImage(h, e.cover)).status).toBe(200);
  });
});

describe('second sync', () => {
  it('picks up only the new files', async () => {
    const before = { ...h.face.calls };
    h.put(FOLDER, 'IMG_0005.jpg', await makePhoto(5, [{ person: PERSON.blue }]));
    h.put(FOLDER, 'IMG_0006.jpg', await makePhoto(6));
    const p = await syncNow(h, event.id);
    expect(p.summary).toMatchObject({ listed: 6, added: 2, changed: 0, removed: 0, processed: 2 });
    expect(h.face.calls.faces - before.faces).toBe(2);
    expect(h.face.calls.fingerprint - before.fingerprint).toBe(2);
    expect(p.counts.shown).toBe(6);
  });

  it('does nothing when nothing changed', async () => {
    const before = { ...h.face.calls };
    const p = await syncNow(h, event.id);
    expect(p.summary).toMatchObject({ added: 0, changed: 0, removed: 0, processed: 0 });
    expect(h.face.calls).toEqual(before);
  });
});

describe('duplicates among your own files', () => {
  it('shows the very same file once and marks the later one as a copy', async () => {
    fs.copyFileSync(path.join(dir(), 'IMG_0001.jpg'), path.join(dir(), 'IMG_0001 (copy).jpg'));
    const p = await syncNow(h, event.id);
    expect(p.summary).toMatchObject({ added: 1, processed: 0, copies: 1 });
    expect(p.counts).toMatchObject({ total: 7, shown: 6, copies: 1 });
    const dup = (await media('duplicates')).media;
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ name: 'IMG_0001 (copy).jpg', copy_of_name: 'IMG_0001.jpg', face_count: null });
    expect(dup[0].thumb).toBeTruthy(); // a thumbnail for the Media manager...
    expect(dup[0].web).toBeNull(); // ...and nothing else
    expect(await faceRows(dup[0].id)).toBe(0);
    expect((await fetchImage(h, dup[0].thumb)).status).toBe(200); // the organiser can look at it
  });

  it('shows the same shot once: a smaller copy of one of your photos becomes a copy of the larger one', async () => {
    h.put(FOLDER, 'IMG_0002 small.jpg', await chatCopy(fs.readFileSync(path.join(dir(), 'IMG_0002.jpg'))));
    const p = await syncNow(h, event.id);
    expect(p.summary).toMatchObject({ added: 1, processed: 1 });
    expect(p.counts).toMatchObject({ shown: 6, copies: 2 });
    const small = await byName('IMG_0002 small.jpg');
    expect(small.duplicate_of).toBe((await byName('IMG_0002.jpg')).id); // the larger original stays shown
    expect(await faceRows(small.id)).toBe(0); // a copy is not searched
  });
});

describe('the sync rules', () => {
  it('processes a changed file again', async () => {
    const before = await byName('IMG_0006.jpg');
    expect(before.face_count).toBe(0);
    h.put(FOLDER, 'IMG_0006.jpg', await makePhoto(66, [{ person: PERSON.cyan }, { person: PERSON.magenta }, { person: PERSON.yellow }]));
    const p = await syncNow(h, event.id);
    expect(p.summary).toMatchObject({ added: 0, changed: 1, processed: 1 });
    const after = await byName('IMG_0006.jpg');
    expect(after.id).toBe(before.id);
    expect(after.face_count).toBe(3);
    expect(await faceRows(after.id)).toBe(3);
  });

  it('treats a renamed file as the same file', async () => {
    const before = await byName('IMG_0005.jpg');
    const calls = { ...h.face.calls };
    fs.renameSync(path.join(dir(), 'IMG_0005.jpg'), path.join(dir(), 'Chief guest.jpg'));
    const p = await syncNow(h, event.id);
    expect(p.summary).toMatchObject({ added: 0, changed: 0, removed: 0, processed: 0 });
    expect((await byName('Chief guest.jpg')).id).toBe(before.id);
    expect(h.face.calls).toEqual(calls);
  });

  it('removes a file that is gone, with its display copies, face vectors and image link', async () => {
    const m = await byName('IMG_0004.webp');
    const keys = (await h.ctx.db.query(`select thumb_key, web_key from media where id = $1`, [m.id])).rows[0];
    fs.rmSync(path.join(dir(), 'IMG_0004.webp'));
    const p = await syncNow(h, event.id);
    expect(p.summary.removed).toBe(1);
    expect(await byName('IMG_0004.webp')).toBeUndefined();
    expect(await faceRows(m.id)).toBe(0);
    await settle(h); // the copies trash is emptied
    expect(fs.existsSync(copyPath(h, keys.thumb_key))).toBe(false);
    expect(fs.existsSync(copyPath(h, keys.web_key))).toBe(false);
    await request(h.app).get(m.thumb).expect(404);
  });

  it('lets the copy take over when the shown file is deleted', async () => {
    const shownBefore = (await media('shown')).total;
    fs.rmSync(path.join(dir(), 'IMG_0001.jpg'));
    const p = await syncNow(h, event.id);
    expect(p.summary).toMatchObject({ removed: 1, processed: 1 });
    const heir = await byName('IMG_0001 (copy).jpg');
    expect(heir).toMatchObject({ status: 'ready', duplicate_of: null, face_count: 2 });
    expect(heir.web).toBeTruthy(); // processed in full now
    expect(await faceRows(heir.id)).toBe(2);
    expect((await media('shown')).total).toBe(shownBefore);
    expect((await media('duplicates')).media.map((m: any) => m.name)).not.toContain('IMG_0001 (copy).jpg');
  });

  it('skips what it cannot show and says why', async () => {
    h.put(FOLDER, 'song.mp3', Buffer.from('not a photo or a video'));
    h.put(FOLDER, 'notes.docx', Buffer.from('a document'));
    const p = await syncNow(h, event.id);
    expect(p.counts.skipped).toBe(2);
    const skipped = (await media('skipped')).media;
    expect(Object.fromEntries(skipped.map((m: any) => [m.name, m.status_reason]))).toEqual({
      'song.mp3': 'Not a photo or video (JPG, PNG, WebP, HEIC, MP4, MOV, WebM, MKV, AVI, 3GP)',
      'notes.docx': 'Not a photo or video (JPG, PNG, WebP, HEIC, MP4, MOV, WebM, MKV, AVI, 3GP)',
    });
    // (videos are taken in now: test/videos.test.ts)
  });

  it('brings an older album up to date once: JPEG copies are made again as light WebP from the original', async () => {
    const m = (await media()).media.find((x: any) => x.status === 'ready' && x.type !== 'video' && x.face_count > 0 && !x.duplicate_of && !x.hidden);
    const before = (await h.ctx.db.query<any>(`select thumb_key, web_key from media where id = $1`, [m.id])).rows[0];
    // as an album made before the app went WebP left it: JPEG copies (kept in OneDrive's app folder)
    const t = h.ctx.drive.upload((await h.ctx.drive.children(null)).find((f) => f.name === '_app copies (do not edit)')!.id, `${m.id}-old_t.jpg`, await sharp(copyPath(h, before.thumb_key)).jpeg().toBuffer(), 'image/jpeg');
    const w = h.ctx.drive.upload((await h.ctx.drive.children(null)).find((f) => f.name === '_app copies (do not edit)')!.id, `${m.id}-old_w.jpg`, await sharp(copyPath(h, before.web_key)).jpeg().toBuffer(), 'image/jpeg');
    const oldT = `od/${(await t).id}/${(await t).name}`;
    const oldW = `od/${(await w).id}/${(await w).name}`;
    await h.ctx.db.query(`update media set thumb_key = $2, web_key = $3, look = $4 where id = $1`, [m.id, oldT, oldW, JSON.stringify({ lo: 0.2, hi: 0.5, gamma: 1.3, sat: 1 })]); // a stale fix
    await settle(h); // the WebP copies it had leave OneDrive
    expect(fs.existsSync(copyPath(h, before.thumb_key))).toBe(false);
    const faces = await faceRows(m.id);

    await upgradeOldCopies(h.ctx);
    await settle(h);
    const after = (await h.ctx.db.query<any>(`select thumb_key, web_key, look, face_count from media where id = $1`, [m.id])).rows[0];
    expect(after.thumb_key).toMatch(/^od\/.+\.webp$/);
    expect(after.web_key).toMatch(/^od\/.+\.webp$/);
    expect(after.web_key).not.toBe(oldW);
    expect(await sharp(copyPath(h, after.web_key)).metadata()).toMatchObject({ format: 'webp' });
    // the fix is measured again too (from the original, with today's measure)
    const original = (await h.ctx.db.query<any>(`select name from media where id = $1`, [m.id])).rows[0].name;
    expect(after.look).toEqual((await prepare(path.join(h.driveDir, FOLDER, original), h.ctx.cfg)).look);
    expect(fs.existsSync(copyPath(h, oldT))).toBe(false); // the old copies are gone
    expect(fs.existsSync(copyPath(h, oldW))).toBe(false);
    expect(await faceRows(m.id)).toBe(faces); // nothing else changed
    expect(after.face_count).toBe(m.face_count);
    await upgradeOldCopies(h.ctx); // once only: nothing left to do
    expect((await h.ctx.db.query<any>(`select web_key from media where id = $1`, [m.id])).rows[0].web_key).toBe(after.web_key);
  });

  it('takes in an iPhone photo (HEIC): read through ffmpeg, its face found, shown like any photo', async () => {
    h.put(FOLDER, 'from-iphone.HEIC', fs.readFileSync(new URL('./fixtures/iphone.heic', import.meta.url)));
    await syncNow(h, event.id);
    const m = await byName('from-iphone.HEIC');
    expect(m).toMatchObject({ status: 'ready', width: 800, height: 600, face_count: 1 });
    const row = (await h.ctx.db.query(`select thumb_key, web_key from media where id = $1`, [m.id])).rows[0];
    expect(await sharp(copyPath(h, row.web_key)).metadata()).toMatchObject({ format: 'webp', width: 800, height: 600 });
  });

  it('marks an unreadable photo as failed, and Retry fixes it once the file is good', async () => {
    h.put(FOLDER, 'broken.jpg', Buffer.from('this is not a jpeg'));
    const p = await syncNow(h, event.id);
    expect(p.summary.failed).toBe(1);
    expect(p.counts.failed).toBe(1);
    const failed = (await media('failed')).media[0];
    expect(failed.name).toBe('broken.jpg');
    expect(failed.status_reason).toBeTruthy();

    // syncing again leaves a failed file alone...
    expect((await syncNow(h, event.id)).summary).toMatchObject({ processed: 0, failed: 0 });
    // ...Retry tries it again; here the file itself was replaced with a good one first
    h.put(FOLDER, 'broken.jpg', await makePhoto(77, [{ person: PERSON.green }]));
    const res = await h.admin.post(`/api/admin/events/${event.id}/retry`).expect(202);
    expect(res.body.retrying).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    while (h.ctx.syncing.has(event.id)) await new Promise((r) => setTimeout(r, 20));
    expect(await byName('broken.jpg')).toMatchObject({ status: 'ready', face_count: 1 });
  });

  it('turns a sideways camera file upright and reads when it was taken', async () => {
    const upright = await makePhoto(88, [{ person: PERSON.yellow }], { w: 600, h: 800 }); // portrait
    const camera = await sharp(upright)
      .rotate(270) // store the pixels sideways...
      .withMetadata({ orientation: 6 }) // ...with the tag that says "turn me"
      .withExifMerge({ IFD2: { DateTimeOriginal: '2026:11:20 18:30:05' } })
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
      .toBuffer();
    expect((await sharp(camera).metadata()).width).toBe(800); // really stored sideways
    h.put(FOLDER, 'DSC_0900.jpg', camera);
    await syncNow(h, event.id);
    const m = await byName('DSC_0900.jpg');
    expect(m).toMatchObject({ width: 600, height: 800, face_count: 1 });
    expect(new Date(m.taken_at).toISOString()).toBe('2026-11-20T18:30:05.000Z');
    const web = (await h.ctx.db.query(`select web_key from media where id = $1`, [m.id])).rows[0].web_key;
    const meta = await sharp(copyPath(h, web)).metadata();
    expect([meta.width, meta.height]).toEqual([600, 800]);
  });

  it('reads subfolders one level down as sections', async () => {
    h.put(`${FOLDER}/Stage`, 'stage-1.jpg', await makePhoto(101, [{ person: PERSON.red }]));
    h.put(`${FOLDER}/Awards`, 'awards-1.jpg', await makePhoto(102));
    const p = await syncNow(h, event.id);
    expect(p.summary.added).toBe(2);
    const sections = (await h.ctx.db.query(`select title from sections where event_id = $1 order by title`, [event.id])).rows.map((r: any) => r.title);
    expect(sections).toEqual(['Awards', 'Stage']);
    const m = (await h.ctx.db.query(`select s.title from media m join sections s on s.id = m.section_id where m.name = 'stage-1.jpg'`)).rows[0];
    expect(m.title).toBe('Stage');
  });

  it('leaves out faces that are too small to match', async () => {
    h.put(FOLDER, 'crowd-shot.jpg', await makePhoto(120, [{ person: PERSON.red, size: 16 }, { person: PERSON.blue, size: 90 }]));
    await syncNow(h, event.id);
    expect((await byName('crowd-shot.jpg')).face_count).toBe(1);
  });

  it('reports a folder that is no longer there, and one sync at a time', async () => {
    const lost = await makeEvent(h, 'Lost Folder', 'Temp Folder');
    fs.rmSync(path.join(h.driveDir, 'Temp Folder'), { recursive: true });
    await expect(syncNow(h, lost.id)).rejects.toThrow();
    const p = (await h.admin.get(`/api/admin/events/${lost.id}/progress`)).body;
    expect(p.sync_error).toBe('The event folder is no longer in OneDrive.');

    h.ctx.syncing.add(event.id);
    const res = await h.admin.post(`/api/admin/events/${event.id}/sync`).expect(202);
    expect(res.body.started).toBe(false);
    h.ctx.syncing.delete(event.id);
  });

  it('deleting an event removes its rows and its copies in OneDrive, never the originals', async () => {
    const e2 = await makeEvent(h, 'Short Lived', 'Short Lived');
    h.put('Short Lived', 'one.jpg', await makePhoto(130, [{ person: PERSON.red }]));
    await syncNow(h, e2.id);
    await settle(h);
    const copies = path.join(h.driveDir, '_app copies (do not edit)', e2.id);
    expect(['t', 'w', 's'].map((k) => copyFiles(h, e2.id, k).length)).toEqual([1, 1, 1]); // thumbnail, web copy, scene description
    await h.admin.delete(`/api/admin/events/${e2.id}`).expect(200);
    await settle(h);
    expect(fs.existsSync(copies)).toBe(false); // the whole event folder, in one call
    expect((await h.ctx.db.query(`select count(*)::int as n from copy_trash`)).rows[0].n).toBe(0);
    expect((await h.ctx.db.query(`select count(*)::int as n from faces where event_id = $1`, [e2.id])).rows[0].n).toBe(0);
    expect(fs.existsSync(path.join(h.driveDir, 'Short Lived', 'one.jpg'))).toBe(true);
  });
});

describe('when the face service stops', () => {
  it('the sync pauses: no photo is marked failed, and the next sync carries on from there', async () => {
    const { syncEvent } = await import('../src/sync/sync.js');
    const { FaceDownError } = await import('../src/face/index.js');
    const event = await makeEvent(h, 'Face Down', 'Face Down');
    for (let i = 0; i < 6; i++) h.put('Face Down', `f${i}.jpg`, await makePhoto(150 + i, [{ person: PERSON.red }]));
    const progress = async () => (await h.admin.get(`/api/admin/events/${event.id}/progress`).expect(200)).body;

    // not running at all: the sync says so before it lists or downloads anything
    const health = h.face.health;
    h.face.health = async () => false;
    await expect(syncEvent(h.ctx, event.id)).rejects.toThrow(/face service/i);
    let p = await progress();
    expect(p.sync_error).toMatch(/face service/i);
    expect(p.counts.total).toBe(0);
    h.face.health = health;

    // it stops in the middle of a sync, after two photos
    const faces = h.face.faces;
    let seen = 0;
    h.face.faces = async (jpeg, min) => {
      if (++seen > 2) throw new FaceDownError('The face service is not answering.');
      return faces(jpeg, min);
    };
    await expect(syncEvent(h.ctx, event.id)).rejects.toThrow(/not answering/);
    await h.ctx.work.idle();
    p = await progress();
    expect(p.counts.failed).toBe(0);
    expect(p.counts.shown).toBe(2);
    expect(p.counts.total).toBe(6);
    expect(p.sync_error).toMatch(/not answering/);
    const stuck = await h.ctx.db.query(`select count(*)::int as n from media where event_id = $1 and status = 'processing'`, [event.id]);
    expect(stuck.rows[0].n).toBe(0);

    // back again: the same Sync now finishes the rest and clears the message
    h.face.faces = faces;
    const done = await syncNow(h, event.id);
    expect(done.counts.shown).toBe(6);
    expect(done.counts.failed).toBe(0);
    expect(done.sync_error).toBeNull();
    expect(done.summary.processed).toBe(4);
  });
});

describe('the timer', () => {
  it('syncs Draft and Live events that are due, and leaves Closed events alone', async () => {
    const { startScheduler } = await import('../src/sync/sync.js');
    const due = await makeEvent(h, 'Due Event', 'Due Event');
    const closed = await makeEvent(h, 'Closed Event', 'Closed Event');
    h.put('Due Event', 'd1.jpg', await makePhoto(140, [{ person: PERSON.red }]));
    h.put('Closed Event', 'c1.jpg', await makePhoto(141));
    await h.admin.patch(`/api/admin/events/${closed.id}`).send({ status: 'live' }).expect(200);
    await h.admin.patch(`/api/admin/events/${closed.id}`).send({ status: 'closed' }).expect(200);
    const timer = startScheduler(h.ctx);
    try {
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const p = (await h.admin.get(`/api/admin/events/${due.id}/progress`)).body;
        if (p.last_sync_at && !p.syncing) break;
      }
    } finally {
      clearInterval(timer);
    }
    while (h.ctx.syncing.size) await new Promise((r) => setTimeout(r, 20));
    expect((await h.admin.get(`/api/admin/events/${due.id}/progress`)).body.counts.shown).toBe(1);
    expect((await h.admin.get(`/api/admin/events/${closed.id}/progress`)).body.counts.total).toBe(0);
    expect((await h.admin.post('/api/admin/onedrive/folders').send({ name: '..' }).expect(400)).body.error).toBe('invalid_input');
  });
});

describe('a full-size event', () => {
  it('syncs 500 photos, then only the 5 new ones', async () => {
    const big = await makeEvent(h, 'Five Hundred', 'Five Hundred');
    for (let i = 0; i < 500; i++) {
      h.put('Five Hundred', `P${String(i).padStart(4, '0')}.jpg`, await makePhoto(1000 + i, i % 3 === 0 ? [{ person: (i % 6) * 2 }] : [], { w: 320, h: 240 }));
    }
    const t = Date.now();
    const first = await syncNow(h, big.id);
    expect(first.summary).toMatchObject({ listed: 500, added: 500, processed: 500, copies: 0, failed: 0 });
    expect(first.counts).toMatchObject({ total: 500, shown: 500, faces: 167 });
    const took = Date.now() - t;

    const calls = { ...h.face.calls };
    for (let i = 500; i < 505; i++) h.put('Five Hundred', `P${i}.jpg`, await makePhoto(1000 + i, [], { w: 320, h: 240 }));
    const second = await syncNow(h, big.id);
    expect(second.summary).toMatchObject({ listed: 505, added: 5, processed: 5 });
    expect(h.face.calls.faces - calls.faces).toBe(5);
    console.log(`500 photos synced in ${(took / 1000).toFixed(1)} s (stand-in face engine, small pictures)`);
  }, 240_000);
});

describe('the Crowd uploads folder', () => {
  it('a file that turns up there by itself waits for review like an upload, and a copy of a photo that is already there is never shown', async () => {
    const e = await makeEvent(h, 'Crowd Folder', 'Crowd Folder', { auto_approve: false });
    const official = await makePhoto(170, [{ person: PERSON.red }]);
    h.put('Crowd Folder', 'official.jpg', official);
    h.put('Crowd Folder/Crowd uploads', 'dropped.jpg', await makePhoto(171, [{ person: PERSON.blue }]));
    h.put('Crowd Folder/Crowd uploads', 'copy.jpg', await chatCopy(official));
    const p = await syncNow(h, e.id);
    expect(p.counts).toMatchObject({ shown: 1, review: 1, copies: 1, failed: 0 });
    const rows = (await h.admin.get(`/api/admin/events/${e.id}/media?limit=50`)).body.media;
    expect(rows.find((m: any) => m.name === 'dropped.jpg')).toMatchObject({ source: 'crowd', review: 'pending' });
    expect(rows.find((m: any) => m.name === 'copy.jpg')).toMatchObject({ source: 'crowd', copy_of_name: 'official.jpg' });

    // approving the dropped file shows it; a second sync changes nothing
    await h.admin.post(`/api/admin/events/${e.id}/approve-all`).expect(200);
    const again = await syncNow(h, e.id);
    expect(again.counts).toMatchObject({ shown: 2, review: 0, copies: 1 });
    expect(again.summary).toMatchObject({ added: 0, processed: 0, removed: 0 });

    // with auto-approve on, such a file shows at once
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ auto_approve: true }).expect(200);
    h.put('Crowd Folder/Crowd uploads', 'later.jpg', await makePhoto(172));
    expect((await syncNow(h, e.id)).counts).toMatchObject({ shown: 3, review: 0 });

    // the console's card shows a few of the photos, as organiser links, the chosen cover first
    const card = async () => (await h.admin.get('/api/admin/events')).body.events.find((x: any) => x.id === e.id);
    const listed = await card();
    expect(listed.strip).toHaveLength(3);
    for (const u of listed.strip) expect(u).toMatch(/^\/img\/[0-9a-f-]{36}\/t\?e=\d+&s=[^&]+&a=1$/);
    const third = listed.strip[2].split('/')[2];
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ cover_media_id: third }).expect(200);
    expect((await card()).strip[0]).toContain(`/img/${third}/`);
  });

  it('forgets the folder when it is deleted in OneDrive, and the photos in it leave the album', async () => {
    const e = (await h.admin.get('/api/admin/events')).body.events.find((x: any) => x.title === 'Crowd Folder');
    const crowd = async () => (await h.ctx.db.query(`select crowd_folder_id from events where id = $1`, [e.id])).rows[0].crowd_folder_id;
    expect(await crowd()).toBeTruthy();
    fs.rmSync(path.join(h.driveDir, 'Crowd Folder', 'Crowd uploads'), { recursive: true });
    const p = await syncNow(h, e.id);
    expect(p.counts).toMatchObject({ shown: 1, total: 1 });
    expect(await crowd()).toBeNull();
  });
});

describe('when OneDrive cannot be reached', () => {
  it('the sync pauses: no photo is marked failed, and the next sync carries on', async () => {
    const { syncEvent } = await import('../src/sync/sync.js');
    const { DriveDownError } = await import('../src/drive/index.js');
    const e = await makeEvent(h, 'Drive Down', 'Drive Down');
    for (let i = 0; i < 6; i++) h.put('Drive Down', `d${i}.jpg`, await makePhoto(180 + i));
    const download = h.ctx.drive.download.bind(h.ctx.drive);
    let n = 0;
    h.ctx.drive.download = async (id, dest) => {
      if (++n > 2) throw new DriveDownError();
      return download(id, dest);
    };
    await expect(syncEvent(h.ctx, e.id)).rejects.toThrow(/cannot be reached/);
    await h.ctx.work.idle();
    let p = (await h.admin.get(`/api/admin/events/${e.id}/progress`)).body;
    expect(p.counts).toMatchObject({ failed: 0, shown: 2, total: 6, processing: 0 });
    expect(p.sync_error).toMatch(/cannot be reached/);
    h.ctx.drive.download = download;
    p = await syncNow(h, e.id);
    expect(p.counts).toMatchObject({ failed: 0, shown: 6 });
    expect(p.sync_error).toBeNull();
  });
});

describe('Read every photo again', () => {
  it('makes fresh face vectors and copies without changing what is hidden or which photo is a copy', async () => {
    const e = await makeEvent(h, 'Read Again', 'Read Again');
    const twice = await makePhoto(190, [{ person: PERSON.red }]);
    h.put('Read Again', 'a.jpg', twice);
    h.put('Read Again', 'a again.jpg', twice);
    h.put('Read Again', 'b.jpg', await makePhoto(191, [{ person: PERSON.blue }, { person: PERSON.green }]));
    h.put('Read Again', 'c.jpg', await makePhoto(192, [{ person: PERSON.red }]));
    await syncNow(h, e.id);
    const rows = (await h.admin.get(`/api/admin/events/${e.id}/media?limit=50`)).body.media;
    await h.admin.patch('/api/admin/media').send({ ids: [rows.find((m: any) => m.name === 'c.jpg').id], action: 'hide' }).expect(200);
    const before = (await h.admin.get(`/api/admin/events/${e.id}/progress`)).body.counts;
    expect(before).toMatchObject({ shown: 2, copies: 1, hidden: 1, faces: 3 });
    const done = async () => {
      for (let i = 0; i < 200 && (await h.admin.get(`/api/admin/events/${e.id}/progress`)).body.syncing; i++) await new Promise((r) => setTimeout(r, 25));
      return (await h.admin.get(`/api/admin/events/${e.id}/progress`)).body;
    };

    // pretend the face code changed: it now finds nothing
    const faces = h.face.faces;
    h.face.faces = async () => [];
    expect((await h.admin.post(`/api/admin/events/${e.id}/reread`).send({}).expect(202)).body.photos).toBe(3); // a, b and the hidden c; not the copy
    let p = await done();
    expect(p.counts).toMatchObject({ shown: 2, copies: 1, hidden: 1, faces: 0, failed: 0 });
    h.face.faces = faces;
    await h.admin.post(`/api/admin/events/${e.id}/reread`).send({}).expect(202);
    p = await done();
    expect(p.counts).toMatchObject({ shown: 2, copies: 1, hidden: 1, faces: 3, failed: 0 });
    expect(p.sync_error).toBeNull();

    // an original that is no longer in OneDrive keeps what the app already has
    fs.rmSync(path.join(h.driveDir, 'Read Again', 'b.jpg'));
    await h.admin.post(`/api/admin/events/${e.id}/reread`).send({}).expect(202);
    expect((await done()).counts).toMatchObject({ shown: 2, faces: 3 });

    // not while the face service is stopped
    const health = h.face.health;
    h.face.health = async () => false;
    expect((await h.admin.post(`/api/admin/events/${e.id}/reread`).send({}).expect(503)).body.error).toBe('busy');
    h.face.health = health;
  });
});

describe('a closed event', () => {
  it('is never synced, so its album stays after the originals are moved or deleted; Live syncs it again', async () => {
    const { syncEvent } = await import('../src/sync/sync.js');
    const e = await makeEvent(h, 'Closed Album', 'Closed Album');
    for (let i = 0; i < 4; i++) h.put('Closed Album', `c${i}.jpg`, await makePhoto(200 + i));
    await syncNow(h, e.id);
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'closed' }).expect(200);

    // the organiser frees OneDrive space
    for (const f of fs.readdirSync(path.join(h.driveDir, 'Closed Album'))) fs.rmSync(path.join(h.driveDir, 'Closed Album', f));
    expect((await h.admin.post(`/api/admin/events/${e.id}/sync`).expect(400)).body).toMatchObject({ error: 'closed' });
    expect((await h.admin.post(`/api/admin/events/${e.id}/retry`).expect(400)).body.error).toBe('closed');
    await expect(syncEvent(h.ctx, e.id)).rejects.toThrow(/closed event is not synced/);
    const p = (await h.admin.get(`/api/admin/events/${e.id}/progress`)).body;
    expect(p.counts.shown).toBe(4); // the album is untouched
    expect(p.sync_error).toBeNull();

    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);
    expect((await syncNow(h, e.id)).counts.shown).toBe(0); // Live follows the folder again
  });
});
