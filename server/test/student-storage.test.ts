/**
 * The owner's rule, end to end: what students add and viewers open is kept only in Microsoft OneDrive, passing through
 * our server for a moment. A student's photo and video go into the event's Crowd uploads folder in OneDrive and the
 * app's copies into "_app copies (do not edit)"; nothing of them stays on the server; a viewer gets each picture from
 * OneDrive (a redirect), which the browser may keep for 5 minutes at most. The phone keeps no photos either: the
 * service worker's side is checked in web/src/__tests__/student-sw.test.tsx.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { videosIdle } from '../src/media/video.js';
import { copyFiles, expectNoLocalMedia, makeEvent, makeHarness, phone, settle, type Harness } from './helpers/harness.js';
import { makePhoto, PERSON } from './helpers/photos.js';

const tool = (name: string, env: string | undefined) => env || (fs.existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const FFMPEG = tool('ffmpeg', process.env.FFMPEG_PATH);
const FFPROBE = tool('ffprobe', process.env.FFPROBE_PATH);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-student-storage-'));

/** A two-second clip of one person, as a phone would send it. */
async function makeClip(): Promise<Buffer> {
  for (const i of [1, 2]) fs.writeFileSync(path.join(work, `f-00${i}.jpg`), await makePhoto(900 + i, [{ person: PERSON.green }], { w: 640, h: 360 }));
  const out = path.join(work, 'clip.mp4');
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(work, 'f-%03d.jpg'), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', '10', out]);
  if (r.status !== 0) throw new Error(`ffmpeg could not make the test clip: ${r.stderr}`);
  return fs.readFileSync(out);
}

let h: Harness;
let event: any;
beforeAll(async () => {
  h = await makeHarness({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE });
  event = await makeEvent(h, 'Student Day', undefined, { auto_approve: true }); // its OneDrive folder is made at once
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
});
afterAll(async () => {
  await h.close();
  fs.rmSync(work, { recursive: true, force: true });
});

it("a student's photo and video are kept only in OneDrive, a viewer gets them from OneDrive, and nothing stays on the server", async () => {
  const student = phone(h, 'student');
  const photo = (await student.upload(event.slug, await makePhoto(901, [{ person: PERSON.red }]), 'image/jpeg', 'Asha').expect(201)).body;
  const video = (await student.upload(event.slug, await makeClip(), 'video/mp4', 'Asha').expect(201)).body;
  expect([photo.result, video.result]).toEqual(['added', 'added']);
  await videosIdle();
  await settle(h);

  // OneDrive: the originals in the event's Crowd uploads folder, the app's copies in its own folder.
  const crowd = fs.readdirSync(path.join(h.driveDir, event.folder.name, 'Crowd uploads'));
  expect(crowd.filter((n) => n.endsWith('.jpg'))).toHaveLength(1);
  expect(crowd.filter((n) => n.endsWith('.mp4'))).toHaveLength(1);
  expect(copyFiles(h, event.id, 't')).toHaveLength(2); // a thumbnail each
  expect(copyFiles(h, event.id, 'w')).toHaveLength(2); // a web copy each (the video's is its poster)
  expect(copyFiles(h, event.id, 'v')).toHaveLength(1); // the video's preview

  // Our server: nothing of them stays (only its keys and an empty temp folder).
  await expectNoLocalMedia(h);

  // A viewer: every picture comes from OneDrive, and the browser may keep it for 5 minutes at most.
  const viewer = phone(h, 'viewer');
  const album = (await viewer.get(`/api/e/${event.slug}/album?limit=50`).expect(200)).body.photos;
  expect(album.map((p: any) => p.id).sort()).toEqual([photo.id, video.id].sort());
  for (const p of album) {
    for (const url of [p.thumb, p.web]) {
      const res = await request(h.app).get(url).redirects(0);
      expect(res.status).toBe(302);
      expect(String(res.headers.location)).toMatch(/^\/_drive\//); // the stand-in for OneDrive's own short-lived link
      expect(res.headers['cache-control']).toBe('private, max-age=300');
    }
  }
  await expectNoLocalMedia(h); // viewing keeps nothing on the server either (the photo cache is off here)
});
