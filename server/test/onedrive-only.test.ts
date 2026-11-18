/**
 * The owner's rule, end to end: "Storage should use OneDrive only. The UI and code use the server, but images and
 * videos use only OneDrive storage." After uploads are processed (an organiser's photo and video, a student's photo,
 * a People reference photo) and every kind of image, video and download has been served (thumbnails, web copies,
 * video previews with Range, Save original, Download all), nothing of a photo or video is kept under the server's
 * data folder: no media/, full/ or people/, and data/tmp is empty. Every copy is in the stand-in OneDrive.
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COPIES_FOLDER, isDriveKey } from '../src/media/copies.js';
import { rebuildPass } from '../src/media/rebuild.js';
import { videosIdle } from '../src/media/video.js';
import { expectNoLocalMedia, fetchImage, makeEvent, makeHarness, phone, settle, type Harness } from './helpers/harness.js';
import { binary, FFMPEG, FFPROBE, makeVideo, withGps } from './helpers/media.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;

/** Every file under a folder, relative. */
const filesUnder = (dir: string): string[] =>
  fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).filter((n) => fs.statSync(path.join(dir, n)).isFile()) : [];

beforeAll(async () => {
  h = await makeHarness({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE });
  event = await makeEvent(h, 'OneDrive Only', undefined, { crowd_uploads: true, auto_approve: true, allow_download: true });
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
});
afterAll(() => h.close());

describe('nothing of a photo or video stays on the server', () => {
  it('after uploads, processing and serving everything', async () => {
    // an organiser's photo and video, a student's photo
    await h.admin.post(`/api/admin/events/${event.id}/photos`).set('content-type', 'image/jpeg').set('x-file-name', 'stage.jpg').send(await withGps(980, [{ person: PERSON.red }])).expect(201);
    await h.admin
      .post(`/api/admin/events/${event.id}/photos`)
      .set('content-type', 'video/mp4')
      .set('x-file-name', 'dance.mp4')
      .send(await makeVideo(981, [[{ person: PERSON.red }], [{ person: PERSON.red }]]))
      .expect(201);
    const student = phone(h, 'only-student');
    await student.upload(event.slug, await makePhoto(982, [{ person: PERSON.red }, { person: PERSON.blue }])).expect(201);
    await settle(h);
    await videosIdle();
    await settle(h);

    // a People reference photo
    const person = (await h.admin.post('/api/admin/people').send({ name: 'Dr. Red', role: 'Chairman' }).expect(201)).body.person;
    await h.admin.post(`/api/admin/people/${person.id}/photos`).set('content-type', 'image/jpeg').send(await makeSelfie(PERSON.red)).expect(201);
    const ref = (await h.ctx.db.query<any>(`select thumb_key from person_refs where person_id = $1`, [person.id])).rows[0];
    expect(isDriveKey(ref.thumb_key)).toBe(true);
    const listed = (await h.admin.get(`/api/admin/people/${person.id}`).expect(200)).body;
    expect((await fetchImage(h, listed.refs[0].thumb, { agent: h.admin })).status).toBe(200);

    // every row's copies are in OneDrive
    const rows = (await h.ctx.db.query<any>(`select * from media where event_id = $1`, [event.id])).rows;
    expect(rows).toHaveLength(3);
    for (const m of rows) {
      expect(m.status).toBe('ready');
      for (const k of [m.thumb_key, m.web_key]) expect(isDriveKey(k)).toBe(true);
      if (m.type === 'video') for (const k of [m.video_key, m.clean_key]) expect(isDriveKey(k)).toBe(true);
      else expect(isDriveKey(m.scene_key)).toBe(true);
    }

    // a student sees and saves everything
    const p = phone(h, 'only-viewer');
    const found = (await p.selfie(event.slug, await makeSelfie(PERSON.red)).expect(200)).body.sure;
    expect(found).toHaveLength(3);
    for (const x of found) {
      expect((await fetchImage(h, x.thumb)).status).toBe(200);
      const web = await fetchImage(h, x.web);
      expect(web.status).toBe(200);
      expect((await sharp(web.body).metadata()).format).toBe('webp');
      expect((await request(h.app).get(`${x.web}&pipe=1`).buffer(true).parse(binary).expect(200)).body.length).toBe(web.body.length);
      if (x.video) {
        expect((await fetchImage(h, x.video, { range: 'bytes=0-99' })).status).toBe(206);
        expect((await request(h.app).get(`${x.video}&pipe=1`).set('Range', 'bytes=0-99').expect(206)).headers['content-type']).toBe('video/mp4');
      }
      expect((await p.get(`/api/e/${event.slug}/original/${x.id}?d=${p.token}`).buffer(true).parse(binary)).status).toBe(200);
    }
    const link = (await p.post(`/api/e/${event.slug}/zip`).expect(200)).body.url;
    expect((await p.get(link).buffer(true).parse(binary)).status).toBe(200);
    // the organiser's look at a photo and its original
    const admin = (await h.admin.get(`/api/admin/events/${event.id}/media?limit=10`).expect(200)).body.media;
    for (const m of admin) expect((await fetchImage(h, m.thumb)).status).toBe(200);
    expect((await h.admin.get(`/api/admin/media/${admin[0].id}/original`).redirects(0).expect(302)).headers.location).toMatch(/^\/_drive\//);
    // the copies job finds nothing to do, and touches nothing on this server
    expect(await rebuildPass(h.ctx)).toMatchObject({ done: 0, lost: 0, failed: 0, stopped: null });

    await expectNoLocalMedia(h);
    for (const d of ['media', 'full', 'people']) expect(fs.existsSync(path.join(h.ctx.cfg.dataDir, d))).toBe(false);
    // every photo and video byte the app keeps is in OneDrive
    const inDrive = filesUnder(path.join(h.driveDir, COPIES_FOLDER, event.id));
    expect(inDrive.filter((n) => n.startsWith('t/'))).toHaveLength(3);
    expect(inDrive.filter((n) => n.startsWith('w/'))).toHaveLength(3);
    expect(inDrive.filter((n) => n.startsWith('v/'))).toHaveLength(1);
    expect(inDrive.filter((n) => n.startsWith('clean/'))).toHaveLength(1);
    expect(filesUnder(path.join(h.driveDir, COPIES_FOLDER, 'people-refs'))).toHaveLength(1);
  });

  it('removing a photo and deleting the event leave nothing in the copies folder either', async () => {
    const before = filesUnder(path.join(h.driveDir, COPIES_FOLDER, event.id)).length;
    expect(before).toBeGreaterThan(0);
    await h.admin.delete(`/api/admin/events/${event.id}`).expect(200);
    await settle(h);
    expect(fs.existsSync(path.join(h.driveDir, COPIES_FOLDER, event.id))).toBe(false);
    await expectNoLocalMedia(h);
  });
});
