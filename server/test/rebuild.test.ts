/**
 * The rebuild job: every copy that is not in OneDrive is made there. This is the live Mac's case (server/data/media
 * was emptied, so every album image is missing), an older install whose copies are still on the Mac (moved up as
 * they are, then data/media goes), an original that is gone in a closed event (the photo leaves the album, "Try
 * again" brings it back), and OneDrive going down halfway (the next pass carries on).
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DriveDownError } from '../src/drive/types.js';
import { emptyCopyTrash, isDriveKey } from '../src/media/copies.js';
import { hasFlag } from '../src/media/copyurls.js';
import { needsCopiesSql, rebuildPass, resetRebuildPacing, setRebuildPacer } from '../src/media/rebuild.js';
import { ORIGINAL_GONE } from '../src/media/upgrade.js';
import { copyFiles, copyPath, expectNoLocalMedia, fetchImage, makeEvent, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { FFMPEG, FFPROBE, flatDark, makeVideo, placeTags, probe } from './helpers/media.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;

const rows = async (eventId: string) =>
  (await h.ctx.db.query<any>(`select * from media where event_id = $1 order by name`, [eventId])).rows;
/** As the live Mac is now: every key points at a file in server/data/media that is not there. */
async function emptyTheMac(eventId: string) {
  await h.ctx.db.query(
    `update media set thumb_key = 'media/' || event_id || '/' || id || '_t.webp',
                      web_key = case when web_key is null then null else 'media/' || event_id || '/' || id || '_w.webp' end,
                      video_key = case when video_key is null then null else 'media/' || event_id || '/' || id || '_v.mp4' end,
                      scene_key = null, clean_key = null, copies_missing = false, copies_tries = 0, copies_error = null
      where event_id = $1 and status = 'ready'`,
    [eventId],
  );
  await emptyCopyTrash(h.ctx); // the copies the rows held before leave OneDrive (queued by the database)
  await settle(h);
}
function spyReads() {
  const seen: string[] = [];
  const d = h.ctx.drive as any;
  const real = { readAll: d.readAll.bind(d), download: d.download.bind(d) };
  d.readAll = (id: string, ...a: any[]) => (seen.push(id), real.readAll(id, ...a));
  d.download = (id: string, ...a: any[]) => (seen.push(id), real.download(id, ...a));
  return { seen, restore: () => Object.assign(d, real) };
}

beforeAll(async () => {
  h = await makeHarness({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE });
});
afterEach(() => {
  setRebuildPacer(null);
  resetRebuildPacing();
  h.ctx.cfg.rebuildPerMin = 60;
});
afterAll(async () => {
  await expectNoLocalMedia(h);
  await h.close();
});

describe('the live Mac: every copy missing', () => {
  let event: any;
  const FOLDER = 'Live Rebuild';

  beforeAll(async () => {
    event = await makeEvent(h, FOLDER, FOLDER);
    h.put(FOLDER, '1 red.jpg', await makePhoto(800, [{ person: PERSON.red }]));
    h.put(FOLDER, '2 red blue.jpg', await makePhoto(801, [{ person: PERSON.red }, { person: PERSON.blue }]));
    h.put(FOLDER, '3 hall.jpg', await flatDark(802, [{ person: PERSON.red }]));
    h.put(FOLDER, '4 green.jpg', await makePhoto(803, [{ person: PERSON.green }]));
    fs.copyFileSync(path.join(h.driveDir, FOLDER, '4 green.jpg'), path.join(h.driveDir, FOLDER, '5 green copy.jpg'));
    await syncNow(h, event.id);
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
    await settle(h);
  });

  it('students see "being prepared", the photo they wait for is made first, and everything comes back exactly as it was', async () => {
    const red = phone(h, 'red-student');
    await red.selfie(event.slug, await makeSelfie(PERSON.red)).expect(200);
    const green = (await rows(event.id)).find((m) => m.name === '4 green.jpg');
    await h.admin.patch('/api/admin/media').send({ ids: [green.id], action: 'hide' }).expect(200);
    await settle(h);
    const before = await rows(event.id);
    const facts = async () =>
      Promise.all(
        (await rows(event.id)).map(async (m) => ({
          id: m.id,
          hidden: m.hidden,
          duplicate_of: m.duplicate_of,
          face_count: m.face_count,
          faces: (await h.ctx.db.query(`select count(*)::int as n from faces where media_id = $1`, [m.id])).rows[0].n,
          matches: (await h.ctx.db.query(`select count(*)::int as n from matches where media_id = $1`, [m.id])).rows[0].n,
          look: m.look,
          copies_fixed: m.copies_fixed,
        })),
      );
    const was = await facts();
    expect(was.find((f) => f.id === before.find((m) => m.name === '3 hall.jpg').id)).toMatchObject({ copies_fixed: true });

    await emptyTheMac(event.id);
    expect(['t', 'w', 's'].flatMap((k) => copyFiles(h, event.id, k))).toEqual([]);
    const album = (await red.get(`/api/e/${event.slug}/album`).expect(200)).body.photos;
    const waitFor = album.find((p: any) => p.id === before.find((m) => m.name === '2 red blue.jpg').id);
    const res = await request(h.app).get(waitFor.thumb).redirects(0).expect(503);
    expect(res.body.error).toBe('copy_preparing');
    // The newest photo: without "a student waits for it" it would be made last (oldest first).
    await h.ctx.db.query(`update media set taken_at = case when id = $2 then now() else now() - interval '1 day' end where event_id = $1`, [
      event.id,
      waitFor.id,
    ]);

    const spy = spyReads();
    let out;
    try {
      out = await rebuildPass(h.ctx);
    } finally {
      spy.restore();
    }
    expect(out).toMatchObject({ done: 5, lost: 0, failed: 0, stopped: null });
    // The one a student waits for starts first. Copies are made REBUILD_AT_ONCE at a time (2), so it reads its original
    // in the first pair: the other one, started with it, may read a moment sooner.
    const firstReads = [...new Set(spy.seen)].slice(0, h.ctx.cfg.rebuildAtOnce);
    expect(firstReads).toContain(before.find((m) => m.id === waitFor.id).onedrive_item_id);
    await settle(h);

    for (const m of await rows(event.id)) {
      expect(isDriveKey(m.thumb_key)).toBe(true);
      expect(fs.existsSync(copyPath(h, m.thumb_key))).toBe(true);
      if (m.duplicate_of) {
        expect(m.web_key).toBeNull(); // a copy keeps its thumbnail only
        continue;
      }
      expect(isDriveKey(m.web_key)).toBe(true);
      expect(isDriveKey(m.scene_key)).toBe(true);
      expect(m.copies_missing).toBe(false);
    }
    expect(await facts()).toEqual(was); // faces, what is hidden, copies, matches and the fix: all as they were
    expect((await fetchImage(h, waitFor.thumb)).status).toBe(200);
    expect(await h.ctx.redis.zrange('rebuild:hot', '0', '-1')).not.toContain(waitFor.id);
  });

  it('follows the event\'s Improve photos: off, the copies are made without the fix', async () => {
    await h.ctx.db.query(`update events set improve_photos = false where id = $1`, [event.id]);
    await emptyTheMac(event.id);
    await rebuildPass(h.ctx);
    const hall = (await rows(event.id)).find((m) => m.name === '3 hall.jpg');
    expect(hall.copies_fixed).toBe(false);
    expect(hall.look).not.toBeNull(); // measured, not applied
    await h.ctx.db.query(`update events set improve_photos = true where id = $1`, [event.id]);
    await emptyTheMac(event.id);
    await rebuildPass(h.ctx);
    expect((await rows(event.id)).find((m) => m.name === '3 hall.jpg').copies_fixed).toBe(true);
  });

  it('OneDrive going down halfway stops the pass without counting a try; the next pass finishes', async () => {
    await emptyTheMac(event.id);
    const d = h.ctx.drive as any;
    const real = d.readAll.bind(d);
    let n = 0;
    d.readAll = async (...a: any[]) => {
      if (++n > 3) throw new DriveDownError();
      return real(...a);
    };
    let first;
    try {
      first = await rebuildPass(h.ctx);
    } finally {
      d.readAll = real;
    }
    expect(first.stopped).toMatch(/OneDrive cannot be reached/);
    expect(first.done).toBeGreaterThanOrEqual(2);
    expect(first.done).toBeLessThan(5);
    const left = (await rows(event.id)).filter((m) => !isDriveKey(m.thumb_key));
    expect(left.length).toBeGreaterThan(0);
    for (const m of left) expect(m).toMatchObject({ copies_tries: 0, copies_lost: false });
    // student requests do not start passes against a OneDrive that is down; the 10-minute pass still looks
    expect(await hasFlag(h.ctx, 'rebuild:paused')).toBe(true);
    expect((await rebuildPass(h.ctx)).stopped).toBeNull();
    expect(await hasFlag(h.ctx, 'rebuild:paused')).toBe(false);
    expect((await rows(event.id)).every((m) => isDriveKey(m.thumb_key))).toBe(true);
  });

  it('keeps to REBUILD_PER_MIN', async () => {
    await emptyTheMac(event.id);
    h.ctx.cfg.rebuildPerMin = 2;
    let now = 1_000_000;
    const sleeps: number[] = [];
    setRebuildPacer({ now: () => now, sleep: async (ms) => void (sleeps.push(ms), (now += ms)) });
    resetRebuildPacing();
    expect((await rebuildPass(h.ctx)).done).toBe(5);
    expect(sleeps.length).toBeGreaterThanOrEqual(2); // 5 items at 2 a minute: two waits at least
    expect(sleeps.every((ms) => ms > 0 && ms <= 60_000)).toBe(true);
  });
});

describe('an older install: the copies are still on the Mac', () => {
  it('moves them up as they are (no original fetched), removes them here, and data/media goes at the end', async () => {
    const FOLDER = 'Moved Up';
    const event = await makeEvent(h, FOLDER, FOLDER);
    h.put(FOLDER, 'one.jpg', await makePhoto(820, [{ person: PERSON.cyan }]));
    h.put(FOLDER, 'two.jpg', await makePhoto(821, [{ person: PERSON.magenta }]));
    await syncNow(h, event.id);
    await settle(h);
    // as an older version left them: files in data/media, keys pointing at them, no scene column
    const legacy = new Map<string, Buffer>();
    for (const m of await rows(event.id)) {
      const t = `media/${event.id}/${m.id}_t.webp`;
      const w = `media/${event.id}/${m.id}_w.webp`;
      const sc = `media/${event.id}/${m.id}_s.bin`;
      for (const [k, from] of [[t, m.thumb_key], [w, m.web_key], [sc, m.scene_key]]) {
        const abs = path.join(h.ctx.cfg.dataDir, k);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(copyPath(h, from), abs);
        legacy.set(`${m.id}:${k.slice(-6)}`, fs.readFileSync(abs));
      }
      await h.ctx.db.query(`update media set thumb_key = $2, web_key = $3, scene_key = null where id = $1`, [m.id, t, w]);
    }
    await settle(h);
    await emptyCopyTrash(h.ctx);
    // the album keeps working from the Mac until they are moved
    const { imageUrl } = await import('../src/lib/links.js');
    const m0 = (await rows(event.id))[0];
    const served = await request(h.app).get(imageUrl(h.ctx.cfg, m0.id, 't', true)).expect(200);
    expect(served.headers['content-type']).toMatch(/webp/);

    const spy = spyReads();
    try {
      await rebuildPass(h.ctx);
    } finally {
      spy.restore();
    }
    const originals = (await rows(event.id)).map((m) => m.onedrive_item_id);
    expect(spy.seen.filter((id) => originals.includes(id))).toEqual([]);
    for (const m of await rows(event.id)) {
      expect(fs.readFileSync(copyPath(h, m.thumb_key)).equals(legacy.get(`${m.id}:t.webp`)!)).toBe(true);
      expect(fs.readFileSync(copyPath(h, m.web_key)).equals(legacy.get(`${m.id}:w.webp`)!)).toBe(true);
      expect(fs.readFileSync(copyPath(h, m.scene_key)).equals(legacy.get(`${m.id}:_s.bin`)!)).toBe(true);
    }
    expect(fs.existsSync(path.join(h.ctx.cfg.dataDir, 'media'))).toBe(false);
    expect((await h.ctx.db.query(`select 1 from app_state where key = 'copies_local_done'`)).rows).toHaveLength(1);
  });
});

describe('a closed event whose original is gone', () => {
  it('the photo leaves the album (it has nothing to show), the organiser sees why, and Try again brings it back', async () => {
    const FOLDER = 'Closed Night';
    const event = await makeEvent(h, FOLDER, FOLDER);
    h.put(FOLDER, 'stays.jpg', await makePhoto(830, [{ person: PERSON.yellow }]));
    h.put(FOLDER, 'moved away.jpg', await makePhoto(831, [{ person: PERSON.yellow }]));
    await syncNow(h, event.id);
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'closed' }).expect(200);
    await emptyTheMac(event.id);
    const away = path.join(h.driveDir, '..', 'moved-away.jpg');
    fs.renameSync(path.join(h.driveDir, FOLDER, 'moved away.jpg'), away);
    const out = await rebuildPass(h.ctx);
    expect(out.lost).toBe(1);
    const lost = (await rows(event.id)).find((m) => m.name === 'moved away.jpg');
    expect(lost).toMatchObject({ copies_lost: true, copies_error: ORIGINAL_GONE });

    const p = phone(h, 'yellow');
    expect((await p.get(`/api/e/${event.slug}/album`).expect(200)).body.photos.map((x: any) => x.id)).not.toContain(lost.id);
    expect((await p.selfie(event.slug, await makeSelfie(PERSON.yellow)).expect(200)).body.sure.map((x: any) => x.id)).not.toContain(lost.id);
    const admin = (await h.admin.get(`/api/admin/events/${event.id}/media?filter=lost`).expect(200)).body.media;
    expect(admin).toHaveLength(1);
    expect(admin[0]).toMatchObject({ id: lost.id, copies_lost: true, copies_error: ORIGINAL_GONE });
    expect((await h.admin.get(`/api/admin/storage`).expect(200)).body.copies.lost).toBe(1);

    fs.renameSync(away, path.join(h.driveDir, FOLDER, 'moved away.jpg'));
    expect((await h.admin.patch('/api/admin/media').send({ ids: [lost.id], action: 'rebuild' }).expect(200)).body.changed).toBe(1);
    await rebuildPass(h.ctx);
    const back = (await rows(event.id)).find((m) => m.name === 'moved away.jpg');
    expect(back).toMatchObject({ copies_lost: false, copies_error: null });
    expect(isDriveKey(back.thumb_key)).toBe(true);
    expect((await p.get(`/api/e/${event.slug}/album`).expect(200)).body.photos.map((x: any) => x.id)).toContain(lost.id);
  });
});

describe('videos', () => {
  it('get their poster, playable preview and location-free copy again', async () => {
    const event = await makeEvent(h, 'Video Rebuild');
    const dir = path.join(h.driveDir, event.folder.name);
    fs.writeFileSync(path.join(dir, 'clip.mp4'), await makeVideo(840, [[{ person: PERSON.red }], [{ person: PERSON.red }], [{ person: PERSON.blue }]]));
    await syncNow(h, event.id);
    await settle(h);
    expect(isDriveKey((await rows(event.id))[0].clean_key)).toBe(true);
    await emptyTheMac(event.id);
    expect((await rebuildPass(h.ctx)).done).toBe(1);
    await settle(h);
    const v = (await rows(event.id))[0];
    for (const k of [v.thumb_key, v.web_key, v.video_key, v.clean_key]) expect(isDriveKey(k)).toBe(true);
    const preview = probe(copyPath(h, v.video_key));
    expect(preview.streams.find((s: any) => s.codec_type === 'video').codec_name).toBe('h264');
    expect(placeTags(probe(copyPath(h, v.clean_key)))).toEqual([]);
    expect(copyFiles(h, event.id, 'clean')).toEqual([v.clean_key.split('/').pop()]);
  });
});

describe('a video whose download copy cannot be made', () => {
  it('is tried three times, not on every pass (each try downloads the whole original); Try again starts over', async () => {
    const event = await makeEvent(h, 'Video Full Drive');
    const dir = path.join(h.driveDir, event.folder.name);
    fs.writeFileSync(path.join(dir, 'clip.mp4'), await makeVideo(845, [[{ person: PERSON.red }], [{ person: PERSON.red }]]));
    await syncNow(h, event.id);
    await settle(h);
    const v = (await rows(event.id))[0];
    await h.ctx.db.query(`update media set clean_key = null where id = $1`, [v.id]);
    await settle(h);
    const d = h.ctx.drive as any;
    const realStatus = d.status.bind(d);
    d.status = async () => ({ ...(await realStatus()), quota: { total: 100 * 1024 ** 3, used: 99.9 * 1024 ** 3, remaining: 0.1 * 1024 ** 3 } });
    const spy = spyReads();
    try {
      for (let i = 0; i < 5; i++) await rebuildPass(h.ctx);
    } finally {
      spy.restore();
      d.status = realStatus;
    }
    expect(spy.seen.filter((id) => id === v.onedrive_item_id)).toHaveLength(3);
    const after = (await rows(event.id))[0];
    expect(after).toMatchObject({ clean_key: null, clean_tries: 3, copies_lost: false, copies_tries: 0 });
    expect(isDriveKey(after.thumb_key) && isDriveKey(after.video_key)).toBe(true); // still shown
    await h.admin.patch('/api/admin/media').send({ ids: [v.id], action: 'rebuild' }).expect(200);
    await rebuildPass(h.ctx);
    await settle(h);
    expect(isDriveKey((await rows(event.id))[0].clean_key)).toBe(true);
  });
});

describe('a pass where every item fails', () => {
  it('stops after five in a row (an error nobody planned for does not use up every item\'s tries in one go)', async () => {
    const event = await makeEvent(h, 'Failing Pass');
    const dir = path.join(h.driveDir, event.folder.name);
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, `p${i}.jpg`), await makePhoto(870 + i, [{ person: PERSON.red }]));
    await syncNow(h, event.id);
    await settle(h);
    await emptyTheMac(event.id);
    const d = h.ctx.drive as any;
    const real = d.readAll.bind(d);
    d.readAll = async () => {
      throw new Error('OneDrive answered 418: something new');
    };
    let out;
    try {
      out = await rebuildPass(h.ctx);
    } finally {
      d.readAll = real;
    }
    expect(out.stopped).toMatch(/5 items in a row/);
    expect(out.failed).toBeLessThanOrEqual(6); // two at a time: one more may already have started
    const tried = (await rows(event.id)).filter((m) => m.copies_tries > 0);
    expect(tried.length).toBe(out.failed);
    expect((await rows(event.id)).some((m) => m.copies_tries === 0)).toBe(true);
    expect((await rows(event.id)).every((m) => !m.copies_lost)).toBe(true);
    expect((await rebuildPass(h.ctx)).stopped).toBeNull();
    expect((await rows(event.id)).every((m) => isDriveKey(m.thumb_key))).toBe(true);
  });
});

describe('People face photos from before', () => {
  it('go up to OneDrive when still on the Mac; one whose file is gone is forgotten and the console asks for it again', async () => {
    const person = (await h.admin.post('/api/admin/people').send({ name: 'Dr. Legacy', role: 'Dean' }).expect(201)).body.person;
    await h.admin.post(`/api/admin/people/${person.id}/photos`).set('content-type', 'image/jpeg').send(await makeSelfie(PERSON.cyan)).expect(201);
    await h.admin.post(`/api/admin/people/${person.id}/photos`).set('content-type', 'image/jpeg').send(await makeSelfie(PERSON.magenta)).expect(201);
    const refs = (await h.ctx.db.query<any>(`select id, thumb_key from person_refs where person_id = $1 order by created_at`, [person.id])).rows;
    const kept = `people/${person.id}/${refs[0].id}.jpg`;
    const abs = path.join(h.ctx.cfg.dataDir, kept);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(copyPath(h, refs[0].thumb_key), abs);
    const bytes = fs.readFileSync(abs);
    await h.ctx.db.query(`update person_refs set thumb_key = $2 where id = $1`, [refs[0].id, kept]);
    await h.ctx.db.query(`update person_refs set thumb_key = $2 where id = $1`, [refs[1].id, `people/${person.id}/${refs[1].id}.jpg`]); // not on the Mac
    await settle(h);
    await rebuildPass(h.ctx);
    const after = (await h.ctx.db.query<any>(`select id, thumb_key from person_refs where person_id = $1 order by created_at`, [person.id])).rows;
    expect(after[0].thumb_key).toMatch(/^od\//);
    expect(fs.readFileSync(copyPath(h, after[0].thumb_key)).equals(bytes)).toBe(true);
    expect(after[1].thumb_key).toBeNull();
    expect(fs.existsSync(path.join(h.ctx.cfg.dataDir, 'people'))).toBe(false);
    const listed = (await h.admin.get(`/api/admin/people/${person.id}`).expect(200)).body.refs;
    expect(listed.map((r: any) => !!r.thumb)).toEqual([true, false]);
  });
});

describe('copies made by the stand-in drive', () => {
  it('count as missing once OneDrive is connected', async () => {
    const m = (await h.ctx.db.query<any>(`select m.id from media m where m.thumb_key like 'od/%' and m.status = 'ready' and not m.copies_lost limit 1`)).rows[0];
    const pick = async (graph: boolean) =>
      (await h.ctx.db.query(`select m.id from media m join events e on e.id = m.event_id where m.id = $1 and ${needsCopiesSql({ graph })}`, [m.id])).rows.length;
    expect(await pick(false)).toBe(0);
    expect(await pick(true)).toBe(1); // their ids look like <inode>-<ms>: not OneDrive items
  });
});
