/**
 * Phase 5 "Done when": a volunteer adds 10 photos with no login; they wait for approval, then show
 * in the album and in Find my photos; a photo sent twice is added once; a WhatsApp copy of a photo
 * already in the album is skipped; a photo from an iPhone uploads.
 * (A real iPhone cannot be tested here: the sideways-camera-file case stands in for it.)
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectNoLocalMedia, fetchImage, makeEvent, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { chatCopy, makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
const FOLDER = 'Annual Day';
const slug = () => event.slug;
const crowdDir = () => path.join(h.driveDir, FOLDER, 'Crowd uploads');
const crowdFiles = () => (fs.existsSync(crowdDir()) ? fs.readdirSync(crowdDir()) : []);
const adminMedia = async (filter = 'all') => (await h.admin.get(`/api/admin/events/${event.id}/media?filter=${filter}&limit=200`)).body;
const album = async (p = phone(h, 'viewer')) => (await p.get(`/api/e/${slug()}/album?limit=120`).expect(200)).body;
const official: Record<string, Buffer> = {};

beforeAll(async () => {
  h = await makeHarness({ uploadsPerPhone: 14, uploadMaxBytes: 400 * 1024 });
  event = await makeEvent(h, 'Annual Day 2026', FOLDER, { auto_approve: false }); // this file checks the review step
  official.o1 = await makePhoto(1, [{ person: PERSON.red }]);
  official.o2 = await makePhoto(2, [{ person: PERSON.blue }]);
  official.o3 = await makePhoto(3);
  for (const [k, v] of Object.entries(official)) h.put(FOLDER, `${k}.jpg`, v);
  await syncNow(h, event.id);
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
});
afterAll(() => h.close());
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

describe('Add your photos', () => {
  const vol = () => phone(h, 'volunteer');

  it('a volunteer adds 10 photos with no login; they are saved to the Crowd uploads folder and wait for review', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await vol().upload(slug(), await makePhoto(100 + i, i === 0 ? [{ person: PERSON.green }] : []), 'image/jpeg', 'Priya R').expect(201);
      expect(res.body).toMatchObject({ result: 'added', review: 'pending' });
    }
    await settle(h);
    expect(crowdFiles()).toHaveLength(10);
    expect((await album()).total).toBe(3); // nothing shows yet
    const waiting = await adminMedia('review');
    expect(waiting.total).toBe(10);
    expect(waiting.media[0]).toMatchObject({ source: 'crowd', review: 'pending', status: 'ready', uploader_name: 'Priya R' });
    expect((await fetchImage(h, waiting.media[0].thumb)).status).toBe(200); // the organiser can preview it
    expect((await h.admin.get(`/api/admin/events/${event.id}/progress`)).body.counts).toMatchObject({ shown: 3, review: 10 });
    const green = await phone(h, 'green').selfie(slug(), await makeSelfie(PERSON.green)).expect(200);
    expect(green.body.sure).toEqual([]); // not searched before approval
  });

  it('after Approve all they show in the album and in Find my photos, with the name under the photo', async () => {
    expect((await h.admin.post(`/api/admin/events/${event.id}/approve-all`).expect(200)).body.approved).toBe(10);
    const a = await album();
    expect(a.total).toBe(13);
    expect(a.photos.filter((p: any) => p.by === 'Priya R')).toHaveLength(10);
    const green = await phone(h, 'green2').selfie(slug(), await makeSelfie(PERSON.green)).expect(200);
    expect(green.body.sure).toHaveLength(1);
    expect(green.body.sure[0].by).toBe('Priya R');
  });

  it('a photo sent twice is added once', async () => {
    const res = await phone(h, 'other').upload(slug(), await makePhoto(100)).expect(200);
    expect(res.body.result).toBe('skipped');
    expect(crowdFiles()).toHaveLength(10); // nothing new saved to OneDrive
    expect((await adminMedia()).total).toBe(13);
  });

  it('a WhatsApp copy of a photo already in the album is skipped; so is the very same file', async () => {
    expect((await vol().upload(slug(), await chatCopy(official.o1)).expect(200)).body.result).toBe('skipped');
    expect((await vol().upload(slug(), official.o2).expect(200)).body.result).toBe('skipped');
    expect((await vol().upload(slug(), await chatCopy(await makePhoto(105), 320, 45)).expect(200)).body.result).toBe('skipped'); // copy of another student's photo
    expect(crowdFiles()).toHaveLength(10);
  });

  it('when two phones send the same picture at the same moment, one gets in', async () => {
    const pic = await makePhoto(150);
    const [a, b] = await Promise.all([phone(h, 'twin-a').upload(slug(), pic), phone(h, 'twin-b').upload(slug(), await chatCopy(pic))]);
    expect([a.body.result, b.body.result].sort()).toEqual(['added', 'skipped']);
    await settle(h);
    expect(crowdFiles()).toHaveLength(11);
  });

  it('a hidden photo cannot come back as a copy, and neither can a rejected one', async () => {
    const o3 = (await adminMedia()).media.find((m: any) => m.name === 'o3.jpg');
    await h.admin.patch('/api/admin/media').send({ ids: [o3.id], action: 'hide' }).expect(200);
    expect((await vol().upload(slug(), await chatCopy(official.o3)).expect(200)).body.result).toBe('skipped');
    await h.admin.patch('/api/admin/media').send({ ids: [o3.id], action: 'unhide' }).expect(200);

    const pending = (await adminMedia('review')).media[0]; // the twin upload
    const before = crowdFiles().length;
    expect((await h.admin.patch('/api/admin/media').send({ ids: [pending.id], action: 'reject' }).expect(200)).body.changed).toBe(1);
    expect(crowdFiles()).toHaveLength(before - 1); // deleted from the Crowd uploads folder
    const row = (await h.ctx.db.query(`select review, sha256, phash, thumb_key, onedrive_item_id from media where id = $1`, [pending.id])).rows[0];
    expect(row).toMatchObject({ review: 'rejected', thumb_key: null, onedrive_item_id: null });
    expect(row.sha256).toBeTruthy(); // fingerprints kept...
    expect((await phone(h, 'twin-a').upload(slug(), await makePhoto(150)).expect(200)).body.result).toBe('skipped'); // ...so it is refused again
    expect((await album()).total).toBe(13);
  });

  it('never rejects or deletes one of your own files', async () => {
    const o1 = (await adminMedia()).media.find((m: any) => m.name === 'o1.jpg');
    expect((await h.admin.patch('/api/admin/media').send({ ids: [o1.id], action: 'reject' }).expect(200)).body.changed).toBe(0);
    expect(fs.existsSync(path.join(h.driveDir, FOLDER, 'o1.jpg'))).toBe(true);
    expect((await adminMedia('shown')).media.some((m: any) => m.id === o1.id)).toBe(true);
  });

  it('turns a sideways camera photo upright (what an iPhone sends)', async () => {
    const upright = await makePhoto(160, [{ person: PERSON.yellow }], { w: 600, h: 800 });
    const camera = await sharp(upright).rotate(270).withMetadata({ orientation: 6 }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
    const res = await vol().upload(slug(), camera).expect(201);
    await settle(h);
    const row = (await h.ctx.db.query(`select width, height, face_count, status from media where id = $1`, [res.body.id])).rows[0];
    expect(row).toMatchObject({ width: 600, height: 800, face_count: 1, status: 'ready' });
    // and an upright chat copy of it is recognised as the same picture
    expect((await phone(h, 'other').upload(slug(), await chatCopy(upright, 300)).expect(200)).body.result).toBe('skipped');
  });

  it('accepts PNG, WebP and iPhone HEIC, refuses other types, unreadable files and files over the size limit', async () => {
    expect((await vol().upload(slug(), await makePhoto(170, [], { format: 'png', w: 320, h: 240 }), 'image/png').expect(201)).body.result).toBe('added');
    expect((await vol().upload(slug(), await makePhoto(171, [], { format: 'webp' }), 'image/webp').expect(201)).body.result).toBe('added');
    // an iPhone photo, sent as it is (another phone, so this one's count stays as the next test expects)
    const heic = fs.readFileSync(new URL('./fixtures/iphone.heic', import.meta.url));
    expect((await phone(h, 'iphone').upload(slug(), heic, 'image/heic').expect(201)).body.result).toBe('added');
    expect((await vol().upload(slug(), Buffer.alloc(2000, 1), 'image/heic').expect(400)).body.error).toBe('bad_photo'); // not really one
    expect((await vol().upload(slug(), Buffer.alloc(2000, 1), 'image/gif').expect(415)).body.error).toBe('unsupported');
    expect((await vol().upload(slug(), Buffer.alloc(2000, 1), 'application/pdf').expect(415)).body.error).toBe('unsupported');
    expect((await vol().upload(slug(), Buffer.alloc(5000, 7)).expect(400)).body.error).toBe('bad_photo');
    expect((await vol().upload(slug(), Buffer.alloc(500 * 1024, 7)).expect(413)).body.error).toBe('too_large');
    await settle(h);
  });

  it('stops a phone at its limit for the event', async () => {
    const ok = await vol().upload(slug(), await makePhoto(180)); // the 14th accepted upload from this phone
    expect(ok.status).toBe(201);
    expect(ok.body.uploads_left).toBe(0);
    const over = await vol().upload(slug(), await makePhoto(181)).expect(429);
    expect(over.body.error).toBe('limit_reached');
    expect((await phone(h, 'other').upload(slug(), await makePhoto(181)).expect(201)).body.result).toBe('added'); // other phones go on
    await settle(h);
  });
});

describe('uploads and the sync job', () => {
  it('a sync after uploads changes nothing: the photos were processed when they arrived', async () => {
    const calls = { ...h.face.calls };
    const shown = (await adminMedia('shown')).total;
    const p = await syncNow(h, event.id);
    expect(p.summary).toMatchObject({ added: 0, changed: 0, removed: 0, processed: 0 });
    expect(h.face.calls).toEqual(calls);
    expect(p.counts.shown).toBe(shown);
  });

  it('a student photo deleted from OneDrive by the organiser leaves the album at the next sync', async () => {
    const before = (await adminMedia()).total;
    fs.rmSync(path.join(crowdDir(), crowdFiles()[0]));
    expect((await syncNow(h, event.id)).summary.removed).toBe(1);
    expect((await adminMedia()).total).toBe(before - 1);
  });

  it('your original arriving after a student\'s copy takes its place, and saved results follow it', async () => {
    const original = await makePhoto(200, [{ person: PERSON.cyan }], { w: 1600, h: 1200 });
    const up = await phone(h, 'early-bird').upload(slug(), await chatCopy(original, 640), 'image/jpeg', 'Early Bird').expect(201);
    await settle(h);
    await h.admin.post(`/api/admin/events/${event.id}/approve-all`).expect(200);
    const cy = phone(h, 'cyan');
    const first = await cy.selfie(slug(), await makeSelfie(PERSON.cyan)).expect(200);
    expect(first.body.sure.map((p: any) => p.id)).toEqual([up.body.id]);
    const total = (await album()).total;

    h.put(FOLDER, 'DSC_4001.jpg', original);
    const p = await syncNow(h, event.id);
    expect(p.summary).toMatchObject({ added: 1, processed: 1, copies: 0 });
    const media = (await adminMedia()).media;
    const mine = media.find((m: any) => m.name === 'DSC_4001.jpg');
    const copy = media.find((m: any) => m.id === up.body.id);
    expect(copy.duplicate_of).toBe(mine.id); // the student's is marked as a copy of yours
    const a = await album();
    expect(a.total).toBe(total); // shown once
    expect(a.photos.some((x: any) => x.id === mine.id)).toBe(true);
    expect(a.photos.some((x: any) => x.id === up.body.id)).toBe(false);
    const saved = (await cy.get(`/api/e/${slug()}/mine`)).body.sure; // no new selfie
    expect(saved.map((x: any) => x.id)).toEqual([mine.id]);
    expect(saved[0]).toMatchObject({ width: 1600, by: null });
  });

  it('"Show anyway" puts a photo marked as a copy back in the album', async () => {
    const copy = (await adminMedia('duplicates')).media[0];
    const total = (await album()).total;
    expect((await h.admin.patch('/api/admin/media').send({ ids: [copy.id], action: 'show_anyway' }).expect(200)).body.changed).toBe(1);
    await settle(h);
    expect((await album()).total).toBe(total + 1);
    expect((await syncNow(h, event.id)).counts.copies).toBe(0); // and a later sync leaves it alone
    expect((await album()).total).toBe(total + 1);
  });
});

describe('when adding photos is open', () => {
  it('works in Draft once the folder is linked, shows at once with auto-approve, and is off when closed or switched off', async () => {
    const e2 = await makeEvent(h, 'Tech Fest', 'Tech Fest', { auto_approve: true });
    const p = phone(h, 'techie');
    expect((await p.upload(e2.slug, await makePhoto(400, [{ person: PERSON.red }])).expect(201)).body).toMatchObject({ result: 'added', review: 'approved' });
    await settle(h);
    expect(fs.readdirSync(path.join(h.driveDir, 'Tech Fest', 'Crowd uploads'))).toHaveLength(1);
    await h.admin.patch(`/api/admin/events/${e2.id}`).send({ status: 'live' }).expect(200);
    expect((await p.get(`/api/e/${e2.slug}/album`).expect(200)).body.total).toBe(1); // no review step
    expect((await p.selfie(e2.slug, await makeSelfie(PERSON.red)).expect(200)).body.sure).toHaveLength(1);

    await h.admin.patch(`/api/admin/events/${e2.id}`).send({ crowd_uploads: false }).expect(200);
    expect((await p.upload(e2.slug, await makePhoto(401)).expect(403)).body.error).toBe('uploads_off');
    await h.admin.patch(`/api/admin/events/${e2.id}`).send({ crowd_uploads: true, status: 'closed' }).expect(200);
    expect((await p.upload(e2.slug, await makePhoto(401)).expect(403)).body.error).toBe('uploads_off');

    const bare = await makeEvent(h, 'No Folder');
    await h.admin.patch(`/api/admin/events/${bare.id}`).send({ onedrive_folder_id: null }).expect(200);
    expect((await p.upload(bare.slug, await makePhoto(402)).expect(403)).body.error).toBe('uploads_off');
  });
});

describe('when the face service stops', () => {
  it('an upload is refused with "try again" and nothing is saved; one caught half-way waits and the next sync finishes it', async () => {
    const { FaceDownError } = await import('../src/face/index.js');
    const e3 = await makeEvent(h, 'Sports Day', 'Sports Day', { auto_approve: true });
    await h.admin.patch(`/api/admin/events/${e3.id}`).send({ status: 'live' }).expect(200);
    const p = phone(h, 'runner');
    const dir = path.join(h.driveDir, 'Sports Day', 'Crowd uploads');

    // down before the photo is looked at: refused, not saved, not counted
    const fingerprint = h.face.fingerprint;
    h.face.fingerprint = async () => {
      throw new FaceDownError('The face service is not answering.');
    };
    const refused = await p.upload(e3.slug, await makePhoto(500, [{ person: PERSON.cyan }])).expect(503);
    expect(refused.body.error).toBe('busy');
    h.face.fingerprint = fingerprint;
    expect(fs.existsSync(dir)).toBe(false);
    expect((await h.admin.get(`/api/admin/events/${e3.id}/progress`)).body.counts.total).toBe(0);

    // down after the photo is saved to OneDrive, before its faces are read: it waits, it is not "failed"
    const faces = h.face.faces;
    h.face.faces = async () => {
      throw new FaceDownError('The face service is not answering.');
    };
    expect((await p.upload(e3.slug, await makePhoto(500, [{ person: PERSON.cyan }])).expect(201)).body.result).toBe('added');
    await settle(h);
    h.face.faces = faces;
    expect(fs.readdirSync(dir)).toHaveLength(1);
    let counts = (await h.admin.get(`/api/admin/events/${e3.id}/progress`)).body.counts;
    expect(counts.failed).toBe(0);
    expect((await p.get(`/api/e/${e3.slug}/album`).expect(200)).body.total).toBe(0);

    counts = (await syncNow(h, e3.id)).counts;
    expect(counts.failed).toBe(0);
    expect((await p.get(`/api/e/${e3.slug}/album`).expect(200)).body.total).toBe(1);
    expect((await p.selfie(e3.slug, await makeSelfie(PERSON.cyan)).expect(200)).body.sure).toHaveLength(1);
  });
});

describe('the edges of adding photos', () => {
  const counts = async (id: string) => (await h.admin.get(`/api/admin/events/${id}/progress`)).body;

  it('holds one phone to its limit even when it sends many photos at the same moment', async () => {
    const e = await makeEvent(h, 'All At Once', 'All At Once', { auto_approve: true });
    const p = phone(h, 'burst');
    const photos = await Promise.all(Array.from({ length: 20 }, (_, i) => makePhoto(600 + i)));
    const codes = await Promise.all(photos.map(async (photo) => (await p.upload(e.slug, photo)).status));
    await settle(h);
    expect(codes.filter((c) => c === 201)).toHaveLength(14); // the limit of this test set-up
    expect(codes.filter((c) => c === 429)).toHaveLength(6);
    expect((await counts(e.id)).counts.total).toBe(14);
    expect(fs.readdirSync(path.join(h.driveDir, 'All At Once', 'Crowd uploads'))).toHaveLength(14);
  });

  it('makes the Crowd uploads folder again when someone deleted it in OneDrive; says "try later" when the event folder itself is gone', async () => {
    const e = await makeEvent(h, 'Folder Gone', 'Folder Gone', { auto_approve: true });
    const p = phone(h, 'folder-gone');
    const dir = path.join(h.driveDir, 'Folder Gone', 'Crowd uploads');
    await p.upload(e.slug, await makePhoto(700)).expect(201);
    await settle(h);
    fs.rmSync(dir, { recursive: true });
    expect((await p.upload(e.slug, await makePhoto(701)).expect(201)).body.result).toBe('added');
    await settle(h);
    expect(fs.readdirSync(dir)).toHaveLength(1);

    fs.rmSync(path.join(h.driveDir, 'Folder Gone'), { recursive: true });
    const res = await p.upload(e.slug, await makePhoto(702)).expect(503);
    expect(res.body).toMatchObject({ error: 'busy' });
    expect((await counts(e.id)).sync_error).toMatch(/no longer in OneDrive/); // the organiser sees why
    expect((await h.ctx.db.query(`select upload_count from guests where event_id = $1`, [e.id])).rows[0].upload_count).toBe(2); // the failed one was not counted
  });

  it('a rejected upload never comes back, even when OneDrive could not delete its file at that moment', async () => {
    const e = await makeEvent(h, 'Reject Hold', 'Reject Hold');
    const p = phone(h, 'reject-hold');
    const dir = path.join(h.driveDir, 'Reject Hold', 'Crowd uploads');
    const pic = await makePhoto(710, [{ person: PERSON.magenta }]);
    const up = (await p.upload(e.slug, pic).expect(201)).body;
    await settle(h);

    const remove = h.ctx.drive.remove.bind(h.ctx.drive);
    h.ctx.drive.remove = async () => {
      throw new Error('OneDrive answered 503');
    };
    expect((await h.admin.patch('/api/admin/media').send({ ids: [up.id], action: 'reject' }).expect(200)).body.changed).toBe(1);
    expect(fs.readdirSync(dir)).toHaveLength(1); // the file could not be deleted
    let c = await syncNow(h, e.id); // a sync while the delete still fails
    expect(c.counts).toMatchObject({ total: 1, shown: 0, review: 0, failed: 0 }); // the file is known: it does not come in as a new photo
    expect(c.summary.added).toBe(0);

    h.ctx.drive.remove = remove;
    c = await syncNow(h, e.id); // the next sync finishes the delete
    expect(fs.readdirSync(dir)).toHaveLength(0);
    expect(c.counts).toMatchObject({ total: 1, shown: 0, review: 0 });
    expect((await p.upload(e.slug, pic).expect(200)).body.result).toBe('skipped'); // and the same picture is still refused

    // the same holds when the organiser deletes a rejected file by hand
    const second = (await p.upload(e.slug, await makePhoto(711)).expect(201)).body;
    await settle(h);
    h.ctx.drive.remove = async () => {
      throw new Error('OneDrive answered 503');
    };
    await h.admin.patch('/api/admin/media').send({ ids: [second.id], action: 'reject' }).expect(200);
    h.ctx.drive.remove = remove;
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    c = await syncNow(h, e.id);
    expect(c.counts).toMatchObject({ total: 2, shown: 0, review: 0 });
    expect((await p.upload(e.slug, await makePhoto(711)).expect(200)).body.result).toBe('skipped');
  });

  it('does not fail a student whose upload lands at the very moment of a sync', async () => {
    const e = await makeEvent(h, 'Same Moment', 'Same Moment');
    const upload = h.ctx.drive.upload.bind(h.ctx.drive);
    h.ctx.drive.upload = async (parent, name, data, mime) => {
      const saved = await upload(parent, name, data, mime);
      // a sync lists the folder right now and takes the new file in before the upload has noted its ID
      await h.ctx.db.query(
        `insert into media (event_id, type, status, name, onedrive_item_id, ctag, source, review) values ($1, 'photo', 'found', $2, $3, $4, 'crowd', 'pending')`,
        [e.id, name, saved.id, saved.ctag],
      );
      return saved;
    };
    const res = await phone(h, 'same-moment').upload(e.slug, await makePhoto(720, [{ person: PERSON.cyan }])).expect(201);
    h.ctx.drive.upload = upload;
    expect(res.body).toMatchObject({ result: 'added', review: 'pending' });
    await settle(h);
    const c = await syncNow(h, e.id);
    expect(c.counts).toMatchObject({ total: 1, review: 1, failed: 0 }); // one row for the one file, waiting for review
  });
});
