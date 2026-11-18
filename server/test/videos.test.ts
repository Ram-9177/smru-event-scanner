/**
 * Videos, the same as photos: an organiser's upload goes into the event's OneDrive folder and plays in the album,
 * a student's waits for approval, the sync job takes them in, and "Find my photos" finds people in them.
 * The test videos are made here with ffmpeg from the stand-in "people" pictures (coloured blocks), a few seconds long.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inVideoLine, mergePeople, probeVideo, videosIdle, type SeenFace } from '../src/media/video.js';
import { expectNoLocalMedia, copyPath, copyFiles, fetchImage, makeEvent, makeHarness, phone, settle, syncNow, zipEntries, zipFiles, type Harness } from './helpers/harness.js';
import { makePhoto, makeSelfie, PERSON, type TestFace } from './helpers/photos.js';

const tool = (name: string, env: string | undefined) => env || (fs.existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const FFMPEG = tool('ffmpeg', process.env.FFMPEG_PATH);
const FFPROBE = tool('ffprobe', process.env.FFPROBE_PATH);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-videos-'));

/** A small MP4: one picture per second (640 x 360), with a silent sound track, and where it was filmed, as phones write it. */
async function makeVideo(seed: number, seconds: TestFace[][]): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(work, 'v-'));
  for (const [i, faces] of seconds.entries()) {
    fs.writeFileSync(path.join(dir, `f-${String(i + 1).padStart(3, '0')}.jpg`), await makePhoto(seed + i, faces, { w: 640, h: 360 }));
  }
  const out = path.join(dir, 'out.mp4');
  const r = spawnSync(FFMPEG, [
    '-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(dir, 'f-%03d.jpg'),
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-map', '0:v', '-map', '1:a', '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', '10', '-c:a', 'aac',
    '-metadata', `location=${GPS}`, '-metadata', `com.apple.quicktime.location.ISO6709=${GPS}`, '-movflags', 'use_metadata_tags', out,
  ]);
  if (r.status !== 0) throw new Error(`ffmpeg could not make the test video: ${r.stderr}`);
  return fs.readFileSync(out);
}

function probe(file: string): any {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  return JSON.parse(r.stdout.toString());
}

/** Where the test videos were "filmed". */
const GPS = '+17.3850+078.4867/';
const placeTags = (j: any) => JSON.stringify([j.format?.tags, ...(j.streams ?? []).map((x: any) => x.tags)]).match(/location|iso6709|17\.3850/gi) ?? [];

let h: Harness;
let event: any;
let eventDir: string;
let dance: Buffer; // red + blue for two seconds, then red + green
let dancedId: string;

const media = async (filter = 'all') => (await h.admin.get(`/api/admin/events/${event.id}/media?filter=${filter}&limit=200`).expect(200)).body;
const row = async (id: string) => (await h.ctx.db.query<any>(`select * from media where id = $1`, [id])).rows[0];

beforeAll(async () => {
  h = await makeHarness({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE });
  event = await makeEvent(h, 'Dance Night 2026'); // its OneDrive folder is made at once
  eventDir = path.join(h.driveDir, event.folder.name);
  dance = await makeVideo(100, [
    [{ person: PERSON.red }, { person: PERSON.blue }],
    [{ person: PERSON.red }, { person: PERSON.blue }],
    [{ person: PERSON.red }, { person: PERSON.green }],
    [{ person: PERSON.red }, { person: PERSON.green }],
  ]);
});

afterAll(async () => {
  await videosIdle();
  await h.close();
  fs.rmSync(work, { recursive: true, force: true });
});
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

describe('an organiser uploads a video in the admin console', () => {
  it('is saved into the event folder in OneDrive and becomes ready: poster, playable preview, one face per person', async () => {
    const up = await h.admin
      .post(`/api/admin/events/${event.id}/photos`)
      .set('content-type', 'video/mp4')
      .set('x-file-name', encodeURIComponent('Dance on stage.mp4'))
      .send(dance)
      .expect(201);
    expect(up.body).toMatchObject({ result: 'added', review: 'approved' });
    dancedId = up.body.id;
    await videosIdle();

    const saved = fs.readdirSync(eventDir).filter((n) => n.endsWith('.mp4'));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^Dance on stage-[\w-]+\.mp4$/);
    expect(fs.readFileSync(path.join(eventDir, saved[0])).equals(dance)).toBe(true);

    const m = await row(dancedId);
    expect(m).toMatchObject({ type: 'video', status: 'ready', status_reason: null, mime: 'video/mp4', width: 640, height: 360, face_count: 3, review: 'approved' });
    expect(m.duration_ms).toBeGreaterThanOrEqual(3500);
    expect(m.duration_ms).toBeLessThanOrEqual(4500);
    expect(m.processed_at).toBeTruthy();
    for (const k of [m.thumb_key, m.web_key, m.video_key]) expect(fs.existsSync(copyPath(h, k))).toBe(true);
    // the poster copies and the preview live in OneDrive's app folder (t, w, v), with a location-free copy for downloads (clean)
    expect(m.video_key).toMatch(new RegExp(`^od/[^/]+/${dancedId}-[0-9a-z]{6}\\.mp4$`));
    for (const [kind, key] of [['t', m.thumb_key], ['w', m.web_key], ['v', m.video_key], ['clean', m.clean_key]]) expect(copyFiles(h, event.id, kind)).toContain(key.split('/').pop());
    expect(placeTags(probe(copyPath(h, m.clean_key)))).toEqual([]);

    // the preview plays in every browser: H.264 video, AAC sound, the moov atom up front; light: at most 30 frames a second
    const p = probe(copyPath(h, m.video_key));
    const vs = p.streams.find((s: any) => s.codec_type === 'video');
    expect(vs).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', width: 640, height: 360 });
    const [num, den] = String(vs.avg_frame_rate).split('/').map(Number);
    expect(num / den).toBeLessThanOrEqual(30.01);
    // the poster copies are light WebP files, like a photo's
    expect(m.thumb_key).toMatch(/\.webp$/);
    expect(m.web_key).toMatch(/\.webp$/);
    expect(p.streams.find((s: any) => s.codec_type === 'audio')?.codec_name).toBe('aac');
    const head = fs.readFileSync(copyPath(h, m.video_key)).subarray(0, 4096).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThan(-1); // +faststart

    // red is in every frame but stored once; blue was seen in the first half, green in the second
    const faces = (await h.ctx.db.query<any>(`select at_ms from faces where media_id = $1 order by at_ms`, [dancedId])).rows.map((f) => f.at_ms);
    expect(faces).toHaveLength(3);
    expect(faces.filter((t) => t < 2000)).toHaveLength(2);
    expect(faces.filter((t) => t >= 2000)).toHaveLength(1);
  });

  it('the Media manager shows it as a video, with its length and a link to play it', async () => {
    const item = (await media()).media.find((x: any) => x.id === dancedId);
    expect(item).toMatchObject({ type: 'video', status: 'ready', face_count: 3 });
    expect(item.duration_ms).toBeGreaterThan(3000);
    expect(item.thumb).toMatch(new RegExp(`^/img/${dancedId}/t\\?`));
    expect(item.video).toMatch(new RegExp(`^/img/${dancedId}/v\\?.*&a=1$`));
    expect('video_key' in item).toBe(false);
  });

  it('a student finds it with a selfie, plays it with Range requests, and gets it in Download all', async () => {
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
    const p = phone(h, 'asha');
    const found = (await p.selfie(event.slug, await makeSelfie(PERSON.green)).expect(200)).body;
    expect(found.sure.map((x: any) => x.id)).toEqual([dancedId]);
    const v = found.sure[0];
    expect(v).toMatchObject({ type: 'video', kind: 'group' }); // three people, all main faces
    expect(v.duration_ms).toBeGreaterThan(3000);
    // where in the video green is seen (the second half): the player starts there
    expect(v.at_ms).toBeGreaterThanOrEqual(2000);
    expect(v.at_ms).toBeLessThanOrEqual(v.duration_ms);
    expect(v.video).toMatch(new RegExp(`^/img/${dancedId}/v\\?`));

    // the album's <video>: a redirect to the preview in OneDrive, which answers Range requests (the player seeks)
    const whole = await fetchImage(h, v.video);
    expect(whole).toMatchObject({ status: 200, redirected: true, cache: 'private, max-age=300' });
    expect(whole.type).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    const part = await fetchImage(h, v.video, { range: 'bytes=0-99' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toMatch(/^bytes 0-99\/\d+$/);
    expect(part.body.length).toBe(100);
    // pipe=1 (the viewer's share and save): the same bytes through the app, Range passed on
    const piped = await request(h.app).get(`${v.video}&pipe=1`).set('Range', 'bytes=0-99').expect(206);
    expect(piped.headers['content-type']).toBe('video/mp4');
    expect(piped.headers['content-range']).toBe(part.headers['content-range']);
    expect(Number(piped.headers['content-length'])).toBe(100);
    // the same link rules as for pictures: a changed size or signature is refused
    await request(h.app).get(v.video.replace('/v?', '/w?')).expect(403);

    const mine = (await p.get(`/api/e/${event.slug}/mine`).expect(200)).body;
    expect(mine.sure[0]).toMatchObject({ id: dancedId, type: 'video', kind: 'group' });
    const album = (await p.get(`/api/e/${event.slug}/album`).expect(200)).body;
    expect(album.photos.find((x: any) => x.id === dancedId)).toMatchObject({ type: 'video', kind: 'group' });

    const zip = (await p.post(`/api/e/${event.slug}/zip`).expect(200)).body;
    const file = await p.get(zip.url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(zipEntries(file.body)).toBe(1);
    // the original video from OneDrive (the same video and sound, not the smaller preview), under its own name,
    // without where it was filmed; the original in OneDrive is untouched
    const [[zipName, zipBytes]] = [...zipFiles(file.body)];
    expect(zipName).toMatch(/^Dance on stage-[\w-]+\.mp4$/);
    const inZip = path.join(work, 'from-zip.mp4');
    fs.writeFileSync(inZip, zipBytes);
    const origFile = path.join(work, 'orig.mp4');
    fs.writeFileSync(origFile, dance);
    const [got, was] = [probe(inZip), probe(origFile)];
    expect(placeTags(was).length).toBeGreaterThan(0); // the test video does carry a place
    expect(placeTags(got)).toEqual([]);
    expect(got.streams.map((x: any) => [x.codec_type, x.codec_name, x.width ?? null, x.nb_frames])).toEqual(was.streams.map((x: any) => [x.codec_type, x.codec_name, x.width ?? null, x.nb_frames]));
    expect(Math.abs(Number(got.format.duration) - Number(was.format.duration))).toBeLessThan(0.1);
    expect(fs.readFileSync(path.join(eventDir, zipName)).equals(dance)).toBe(true);
    // Save original gives the same: the video without its place
    const saved = await p.get(`/api/e/${event.slug}/original/${dancedId}?d=${p.token}`).expect(200).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(saved.headers['content-disposition']).toContain('.mp4');
    fs.writeFileSync(inZip, saved.body);
    expect(placeTags(probe(inZip))).toEqual([]);

    // Downloads stream the location-free copy kept in OneDrive: the original is not needed for it
    const original = path.join(eventDir, zipName);
    const away = path.join(work, 'away.mp4'); // out of the drive (a renamed file inside it keeps its id)
    const zipAgain = async () => {
      const zip2 = (await p.post(`/api/e/${event.slug}/zip`).expect(200)).body;
      const file2 = await p.get(zip2.url).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => cb(null, Buffer.concat(chunks)));
      });
      return [...zipFiles(file2.body)][0][1];
    };
    fs.renameSync(original, away);
    const cleanFile = copyPath(h, (await row(dancedId)).clean_key);
    const cleanAway = path.join(work, 'clean-away.mp4');
    try {
      expect((await zipAgain()).equals(zipBytes)).toBe(true);
      // and when that copy is gone too, the ZIP takes the preview the album plays instead
      fs.renameSync(cleanFile, cleanAway);
      expect((await zipAgain()).equals(fs.readFileSync(copyPath(h, (await row(dancedId)).video_key)))).toBe(true);
    } finally {
      fs.renameSync(away, original);
      if (fs.existsSync(cleanAway)) fs.renameSync(cleanAway, cleanFile);
    }

    // Not me takes it out of this phone's results
    await p.post(`/api/e/${event.slug}/mine/${dancedId}/not-me`).expect(200);
    expect((await p.get(`/api/e/${event.slug}/mine`).expect(200)).body.sure).toHaveLength(0);
  });

  it('a hidden video stops playing for students; a report about it reaches the organiser', async () => {
    const p = phone(h, 'ben');
    const v = (await p.selfie(event.slug, await makeSelfie(PERSON.blue)).expect(200)).body.sure[0];
    await p.post(`/api/e/${event.slug}/report`).send({ media_id: dancedId, reason: 'I am in this' }).expect(201);
    expect((await h.admin.get('/api/admin/requests').expect(200)).body.requests.some((q: any) => q.media_id === dancedId)).toBe(true);
    await h.admin.patch('/api/admin/media').send({ ids: [dancedId], action: 'hide' }).expect(200);
    await request(h.app).get(v.video).expect(404);
    await h.admin.patch('/api/admin/media').send({ ids: [dancedId], action: 'unhide' }).expect(200);
    expect((await fetchImage(h, v.video)).status).toBe(200);
  });

  it('the same video sent again is skipped, and the same file found in the folder is shown once', async () => {
    const again = await h.admin.post(`/api/admin/events/${event.id}/photos`).set('content-type', 'video/mp4').send(dance).expect(200);
    expect(again.body.result).toBe('skipped');
    const shown = (await media('shown')).total;
    fs.writeFileSync(path.join(eventDir, 'copy of dance.mp4'), dance);
    const s = await syncNow(h, event.id);
    expect(s.summary).toMatchObject({ added: 1, copies: 1, failed: 0 });
    expect((await media('shown')).total).toBe(shown);
    const copy = (await media('duplicates')).media.find((x: any) => x.name === 'copy of dance.mp4');
    expect(copy).toMatchObject({ type: 'video', duplicate_of: dancedId, video: null });
  });

  it('"Show anyway" on a video copy makes it play: it goes through the video line, never the photo one', async () => {
    const copy = (await media('duplicates')).media.find((x: any) => x.name === 'copy of dance.mp4');
    await h.admin.patch('/api/admin/media').send({ ids: [copy.id], action: 'show_anyway' }).expect(200);
    await videosIdle();
    await h.ctx.work.idle();
    const m = await row(copy.id);
    expect(m).toMatchObject({ type: 'video', status: 'ready', status_reason: null, duplicate_of: null, keep_both: true });
    for (const k of [m.thumb_key, m.web_key, m.video_key]) expect(fs.existsSync(copyPath(h, k))).toBe(true);
  });
});

describe('the sync job takes videos in like photos', () => {
  it('a video put in the OneDrive folder is processed and found by a selfie', async () => {
    fs.writeFileSync(path.join(eventDir, 'Stage.mov'), await makeVideo(200, [[{ person: PERSON.magenta }], [{ person: PERSON.magenta }], [{ person: PERSON.cyan }]]));
    const s = await syncNow(h, event.id);
    expect(s.summary).toMatchObject({ added: 1, processed: 1, failed: 0 });
    const item = (await media('shown')).media.find((x: any) => x.name === 'Stage.mov');
    expect(item).toMatchObject({ type: 'video', status: 'ready', face_count: 2 });
    expect(item.video).toBeTruthy();
    const found = (await phone(h, 'cara').selfie(event.slug, await makeSelfie(PERSON.cyan)).expect(200)).body;
    expect(found.sure.map((x: any) => x.id)).toEqual([item.id]);
  });

  it('a broken video file is marked failed with a plain reason', async () => {
    fs.writeFileSync(path.join(eventDir, 'broken.mp4'), Buffer.from('this is not a video at all'.repeat(40)));
    const s = await syncNow(h, event.id);
    expect(s.summary).toMatchObject({ added: 1, failed: 1 });
    const failed = (await media('failed')).media.find((x: any) => x.name === 'broken.mp4');
    expect(failed).toMatchObject({ type: 'video', status: 'failed', status_reason: 'This file could not be read as a video.' });
    expect((await syncNow(h, event.id)).summary).toMatchObject({ processed: 0, failed: 0 }); // left alone until Retry
  });
});

describe('a student adds a video', () => {
  it('waits for approval, then is shown; it is saved into Crowd uploads and counts towards the phone limit', async () => {
    const p = phone(h, 'dev');
    const clip = await makeVideo(300, [[{ person: PERSON.yellow }], [{ person: PERSON.yellow }]]);
    const before = (await p.post(`/api/e/${event.slug}/session`).send({}).expect(200)).body.me.uploads_left;
    const up = (await p.upload(event.slug, clip, 'video/mp4', 'Dev').expect(201)).body;
    expect(up).toMatchObject({ result: 'added', review: 'pending', uploads_left: before - 1 });
    await videosIdle();
    expect(await row(up.id)).toMatchObject({ type: 'video', status: 'ready', source: 'crowd', review: 'pending', uploader_name: 'Dev', face_count: 1 });
    expect(fs.readdirSync(path.join(eventDir, 'Crowd uploads')).filter((n) => n.endsWith('.mp4'))).toHaveLength(1);

    const album = async () => (await p.get(`/api/e/${event.slug}/album?limit=120`).expect(200)).body.photos.map((x: any) => x.id);
    expect(await album()).not.toContain(up.id);
    expect((await media('review')).media.map((x: any) => x.id)).toContain(up.id);
    await h.admin.patch('/api/admin/media').send({ ids: [up.id], action: 'approve' }).expect(200);
    expect(await album()).toContain(up.id);
    expect((await p.selfie(event.slug, await makeSelfie(PERSON.yellow)).expect(200)).body.sure[0]).toMatchObject({ id: up.id, type: 'video', by: 'Dev', kind: 'solo' });

    // the same clip again is skipped and costs nothing
    expect((await p.upload(event.slug, clip, 'video/mp4').expect(200)).body).toMatchObject({ result: 'skipped', uploads_left: before - 1 });
  });

  it('a file that is not a video is refused at once and costs nothing', async () => {
    const p = phone(h, 'eve');
    const res = await p.upload(event.slug, Buffer.from('not a video'.repeat(100)), 'video/mp4').expect(400);
    expect(res.body.error).toBe('bad_video');
    expect((await p.post(`/api/e/${event.slug}/session`).send({}).expect(200)).body.me.uploads_left).toBe(h.ctx.cfg.uploadsPerPhone);
    expect(fs.readdirSync(path.join(h.ctx.cfg.dataDir, 'tmp')).filter((n) => n.startsWith('upload-'))).toEqual([]); // nothing left behind
  });

  it('a video larger than the limit is refused before it is read', async () => {
    const res = await phone(h, 'fay')
      .post(`/api/e/${event.slug}/uploads`)
      .set('content-type', 'video/mp4')
      .set('content-length', String(h.ctx.cfg.uploadVideoMaxBytes + 1))
      .send(Buffer.alloc(10))
      .catch((e: any) => e.response ?? { status: 0, body: {} });
    expect(res.status).toBe(413);
  });
});

describe('a video longer than VIDEO_MAX_MINUTES', () => {
  it('is refused at once with a plain reason, from a phone and from the admin console, and costs nothing', async () => {
    const before = h.ctx.cfg.videoMaxMinutes;
    h.ctx.cfg.videoMaxMinutes = 2 / 60; // 2 seconds: the test video is 4
    try {
      const p = phone(h, 'long');
      const res = await p.upload(event.slug, dance, 'video/mp4').expect(400);
      expect(res.body).toMatchObject({ error: 'video_too_long', message: 'This video is longer than 2 seconds. Send a shorter clip.' });
      expect((await p.post(`/api/e/${event.slug}/session`).send({}).expect(200)).body.me.uploads_left).toBe(h.ctx.cfg.uploadsPerPhone);
      const admin = await h.admin.post(`/api/admin/events/${event.id}/photos`).set('content-type', 'video/mp4').send(dance).expect(400);
      expect(admin.body.error).toBe('video_too_long');
      expect(fs.readdirSync(path.join(h.ctx.cfg.dataDir, 'tmp')).filter((n) => n.startsWith('upload-'))).toEqual([]);
      // one put straight into the OneDrive folder is marked failed with the same reason, not processed for hours
      fs.writeFileSync(path.join(eventDir, 'very long.mp4'), await makeVideo(500, [[], [], [], []]));
      await syncNow(h, event.id);
      const m = (await h.ctx.db.query<any>(`select status, status_reason from media where name = 'very long.mp4'`)).rows[0];
      expect(m).toEqual({ status: 'failed', status_reason: 'This video is longer than 2 seconds. Send a shorter clip.' });
    } finally {
      h.ctx.cfg.videoMaxMinutes = before;
    }
  });
});

describe('a student video rejected while it waits in the video line', () => {
  it('gets nothing written back: no poster, no preview, no face vectors, and it stops counting as processing', async () => {
    const p = phone(h, 'gil');
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    void inVideoLine(() => gate); // a long video ahead of it in the line
    try {
      const up = (await p.upload(event.slug, await makeVideo(600, [[{ person: PERSON.cyan }], [{ person: PERSON.cyan }]]), 'video/mp4').expect(201)).body;
      expect((await row(up.id)).status).toBe('processing');
      await h.admin.patch('/api/admin/media').send({ ids: [up.id], action: 'reject' }).expect(200);
      open();
      await videosIdle();
      const m = await row(up.id);
      expect(m).toMatchObject({ review: 'rejected', status: 'ready', thumb_key: null, web_key: null, video_key: null });
      expect((await h.ctx.db.query(`select 1 from faces where media_id = $1`, [up.id])).rows).toHaveLength(0);
      await settle(h);
      // the copies it made in OneDrive while it waited were never committed: they are gone again
      const left = ['t', 'w', 'v', 'clean'].flatMap((k) => copyFiles(h, event.id, k)).filter((n) => n.startsWith(up.id));
      expect(left).toEqual([]);
    } finally {
      open();
    }
  });
});

describe('ffmpeg missing on the server', () => {
  it('holds back only the videos: photos are processed, the sync finishes, and the video is not downloaded again and again', async () => {
    const e = await makeEvent(h, 'No Tools Night');
    const dir = path.join(h.driveDir, e.folder.name);
    fs.writeFileSync(path.join(dir, 'clip.mp4'), dance);
    fs.writeFileSync(path.join(dir, 'photo.jpg'), await makePhoto(700, [{ person: PERSON.red }]));
    const before = { ffprobe: h.ctx.cfg.ffprobePath, ffmpeg: h.ctx.cfg.ffmpegPath };
    const real = h.ctx.drive.download.bind(h.ctx.drive);
    const fetched: string[] = [];
    h.ctx.drive.download = async (id: string, dest: string, signal?: AbortSignal) => {
      fetched.push(dest);
      return real(id, dest, signal);
    };
    h.ctx.cfg.ffprobePath = path.join(work, 'no-such-ffprobe');
    h.ctx.cfg.ffmpegPath = path.join(work, 'no-such-ffmpeg');
    try {
      const s = await syncNow(h, e.id);
      expect(s.summary).toMatchObject({ processed: 1, failed: 0 });
      expect(s.sync_error).toBeNull();
      expect(s.last_sync_at).toBeTruthy();
      const rows = (await h.ctx.db.query<any>(`select name, status, status_reason from media where event_id = $1 order by name`, [e.id])).rows;
      expect(rows[0]).toMatchObject({ name: 'clip.mp4', status: 'found' });
      expect(rows[0].status_reason).toMatch(/ffmpeg is not installed/);
      expect(rows[1]).toMatchObject({ name: 'photo.jpg', status: 'ready' });
      await syncNow(h, e.id);
      expect(fetched.filter((f) => f.endsWith('.video'))).toEqual([]); // the video was never downloaded
    } finally {
      h.ctx.cfg.ffprobePath = before.ffprobe;
      h.ctx.cfg.ffmpegPath = before.ffmpeg;
      h.ctx.drive.download = real;
    }
    await syncNow(h, e.id);
    expect((await h.ctx.db.query<any>(`select status from media where event_id = $1 and name = 'clip.mp4'`, [e.id])).rows[0].status).toBe('ready');
  });
});

describe('a phone video filmed standing up', () => {
  it('is read upright: its size is taller than wide, and so are its poster and preview', async () => {
    const flat = path.join(work, 'flat.mp4');
    const turned = path.join(work, 'turned.mp4');
    fs.writeFileSync(flat, await makeVideo(400, [[{ person: PERSON.red }], [{ person: PERSON.red }]]));
    const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-display_rotation', '90', '-i', flat, '-c', 'copy', turned]);
    expect(r.status).toBe(0);
    const info = await probeVideo(h.ctx.cfg, turned);
    expect([info.width, info.height]).toEqual([360, 640]);
    fs.copyFileSync(turned, path.join(eventDir, 'standing.mp4'));
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
    await syncNow(h, event.id);
    const m = (await h.ctx.db.query<any>(`select * from media where name = 'standing.mp4'`)).rows[0];
    expect(m).toMatchObject({ status: 'ready', width: 360, height: 640, face_count: 1 });
    const pv = probe(copyPath(h, m.video_key)).streams.find((s: any) => s.codec_type === 'video');
    expect([pv.width, pv.height]).toEqual([360, 640]);
  });
});

describe('one person across frames', () => {
  const v = (k: number, mix = 0) => {
    const a = new Float32Array(128);
    a[k] = 1;
    a[127] = mix;
    const n = Math.hypot(...a);
    return a.map((x) => x / n);
  };
  const seen = (k: number, frame: number, size: number, mix = 0): SeenFace => ({ face: { x: 0, y: 0, w: size, h: size, score: 0.9, vector: v(k, mix) }, atMs: frame * 2000, frame });

  it('keeps one face per person, the best view of it, and never merges two faces of one frame', () => {
    const out = mergePeople([seen(0, 0, 40), seen(1, 0, 50), seen(0, 1, 90), seen(0, 1, 30), seen(1, 2, 20), seen(5, 3, 60, 0.5)]);
    // person 0 twice in frame 1: the second one cannot join the first face's person (same frame)
    expect(out.map((f) => [f.face.w, f.atMs])).toEqual([[90, 2000], [50, 0], [30, 2000], [60, 6000]]);
  });
});
