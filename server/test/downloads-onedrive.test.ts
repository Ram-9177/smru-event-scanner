/**
 * What students download, with photos and videos only in OneDrive: Save original and Download all always come
 * through this server (the place is taken out here, fail-closed), from memory or from copies kept in OneDrive. Full
 * quality everywhere; nothing written to this server's disk unless a video has no clean copy yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanForHandover } from '../src/media/location.js';
import { copyFiles, copyPath, expectNoLocalMedia, makeEvent, makeHarness, phone, settle, syncNow, zipFiles, type Harness } from './helpers/harness.js';
import { binary, FFMPEG, FFPROBE, flatDark, makeVideo, placeTags, probeBytes, withGps } from './helpers/media.js';
import { makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
const FOLDER = 'Download Day';
let plain: Buffer;
let hall: Buffer;
let clip: Buffer;
const byName = async (name: string) => (await h.ctx.db.query<any>(`select * from media where event_id = $1 and name = $2`, [event.id, name])).rows[0];
const tmpDir = () => path.join(h.ctx.cfg.dataDir, 'tmp');
const red = () => phone(h, 'red-downloads');
const save = (id: string) => red().get(`/api/e/${event.slug}/original/${id}?d=${red().token}`).buffer(true).parse(binary);
const exifOf = async (jpeg: Buffer): Promise<any> => {
  const m = await sharp(jpeg).metadata();
  return m.exif ? exifReader(m.exif) : {};
};
/** Everything written into data/tmp while fn runs. */
async function watchTmp<T>(fn: () => Promise<T>): Promise<{ out: T; names: string[] }> {
  fs.mkdirSync(tmpDir(), { recursive: true });
  const names: string[] = [];
  const w = fs.watch(tmpDir(), (_e, name) => name && names.push(String(name)));
  try {
    const out = await fn();
    await new Promise((r) => setTimeout(r, 50));
    return { out, names };
  } finally {
    w.close();
  }
}

beforeAll(async () => {
  h = await makeHarness({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE });
  event = await makeEvent(h, FOLDER, FOLDER, { allow_download: true });
  plain = await withGps(900, [{ person: PERSON.red }]);
  hall = await flatDark(901, [{ person: PERSON.red }]);
  clip = await makeVideo(902, [[{ person: PERSON.red }], [{ person: PERSON.red }]]);
  h.put(FOLDER, 'plain.jpg', plain);
  h.put(FOLDER, 'hall.jpg', hall);
  h.put(FOLDER, 'clip.mp4', clip);
  await syncNow(h, event.id);
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
  await settle(h);
  await red().selfie(event.slug, await makeSelfie(PERSON.red)).expect(200);
});
afterAll(async () => {
  await expectNoLocalMedia(h);
  await h.close();
});

describe('Save original', () => {
  it('an unchanged photo: the original minus where it was taken, made in memory (data/tmp is never written)', async () => {
    const m = await byName('plain.jpg');
    const { out: res, names } = await watchTmp(() => save(m.id));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('plain.jpg');
    expect(res.headers['cache-control']).toBe('private, no-store');
    const want = Buffer.from(plain);
    expect(cleanForHandover(want)).toBe(true);
    expect((res.body as Buffer).equals(want)).toBe(true); // byte for byte, place taken out
    expect((await exifOf(res.body)).GPSInfo).toBeUndefined();
    expect(names).toEqual([]);
  });

  it('a photo shown with its fix: made full quality once, kept in OneDrive (full/), and the next download streams it', async () => {
    const m = await byName('hall.jpg');
    expect(m.copies_fixed).toBe(true);
    const first = await save(m.id);
    expect(first.status).toBe(200);
    expect(first.headers['content-disposition']).toContain('hall.jpg');
    const meta = await sharp(first.body).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1200, height: 900 });
    expect((await exifOf(first.body)).GPSInfo).toBeUndefined();
    expect((await exifOf(first.body)).Image).toMatchObject({ Make: 'TestCam' });
    await settle(h);
    const kept = (await h.ctx.db.query<any>(`select drive_item_id, name, bytes from full_copies where media_id = $1`, [m.id])).rows;
    expect(kept).toHaveLength(1);
    expect(copyFiles(h, event.id, 'full')).toEqual([kept[0].name]);
    expect(Number(kept[0].bytes)).toBe(first.body.length);

    const seen: string[] = [];
    const d = h.ctx.drive as any;
    const real = d.readAll.bind(d);
    d.readAll = (id: string, ...a: any[]) => (seen.push(id), real(id, ...a));
    try {
      const again = await save(m.id);
      expect((again.body as Buffer).equals(first.body)).toBe(true);
    } finally {
      d.readAll = real;
    }
    expect(seen).not.toContain(m.onedrive_item_id); // the original was not fetched again
  });

  it('the student never waits for the full-quality copy to be kept in OneDrive', async () => {
    const m = await byName('hall.jpg');
    await h.ctx.db.query(`delete from full_copies where media_id = $1`, [m.id]);
    await settle(h);
    const d = h.ctx.drive as any;
    const real = { upload: d.upload, uploadFile: d.uploadFile };
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    d.upload = async (...a: any[]) => (await gate, real.upload.apply(d, a));
    d.uploadFile = async (...a: any[]) => (await gate, real.uploadFile.apply(d, a));
    try {
      const res = await save(m.id); // OneDrive has not taken the copy yet
      expect(res.status).toBe(200);
      expect((await sharp(res.body).metadata()).format).toBe('jpeg');
      expect((await h.ctx.db.query(`select 1 from full_copies where media_id = $1`, [m.id])).rows).toHaveLength(0);
    } finally {
      open();
      Object.assign(d, real);
    }
    await settle(h);
    expect((await h.ctx.db.query(`select 1 from full_copies where media_id = $1`, [m.id])).rows).toHaveLength(1); // kept for the next student
    await new Promise((r) => setTimeout(r, 300)); // the temp file's removal reaches the next test's watch otherwise (macOS)
  });

  it('a video: its location-free copy kept in OneDrive is streamed', async () => {
    const m = await byName('clip.mp4');
    expect(m.clean_key).toMatch(/^od\//);
    const { out: res, names } = await watchTmp(() => save(m.id));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('clip.mp4');
    expect((res.body as Buffer).equals(fs.readFileSync(copyPath(h, m.clean_key)))).toBe(true);
    expect(placeTags(probeBytes(res.body))).toEqual([]);
    expect(names).toEqual([]); // straight from OneDrive, nothing on this disk
    // resumable: a byte range of it
    const part = await red().get(`/api/e/${event.slug}/original/${m.id}?d=${red().token}`).set('Range', 'bytes=0-99').buffer(true).parse(binary);
    expect(part.status).toBe(206);
    expect(part.body.length).toBe(100);
  });

  it('an older video without its clean copy: made here for this download (temp files removed), and the rebuild job keeps one', async () => {
    const m = await byName('clip.mp4');
    await h.ctx.db.query(`update media set clean_key = null where id = $1`, [m.id]);
    await settle(h);
    const res = await save(m.id);
    expect(res.status).toBe(200);
    expect(placeTags(probeBytes(res.body))).toEqual([]);
    for (let i = 0; i < 100 && fs.readdirSync(tmpDir()).length; i++) await new Promise((r) => setTimeout(r, 10)); // removed once sent
    expect(fs.readdirSync(tmpDir())).toEqual([]);
    expect(await h.ctx.redis.zrange('rebuild:hot', '0', '-1')).toContain(m.id);
    const { rebuildPass } = await import('../src/media/rebuild.js');
    await rebuildPass(h.ctx);
    expect((await byName('clip.mp4')).clean_key).toMatch(/^od\//);
  });

  it('a video whose location-free copy was deleted in OneDrive: still full quality from the original, and the copy comes back', async () => {
    const m = await byName('clip.mp4');
    expect(m.clean_key).toMatch(/^od\//);
    fs.rmSync(copyPath(h, m.clean_key));
    const res = await save(m.id);
    expect(res.status).toBe(200); // not "Original no longer available": the original is still in OneDrive
    expect(placeTags(probeBytes(res.body))).toEqual([]);
    expect((await byName('clip.mp4')).clean_key).toBeNull();
    expect(await h.ctx.redis.zrange('rebuild:hot', '0', '-1')).toContain(m.id);
    await settle(h);
    const { rebuildPass } = await import('../src/media/rebuild.js');
    await rebuildPass(h.ctx);
    const again = await byName('clip.mp4');
    expect(again.clean_key).toMatch(/^od\//);
    expect((await save(m.id)).body.equals(fs.readFileSync(copyPath(h, again.clean_key)))).toBe(true);
    await settle(h);
  });
});

describe('Download all', () => {
  const zip = async () => {
    const link = (await red().post(`/api/e/${event.slug}/zip`).expect(200)).body.url;
    return zipFiles((await red().get(link).buffer(true).parse(binary).expect(200)).body);
  };

  it('every entry at full quality, without the place; a hidden photo is not in it', async () => {
    let files = await zip();
    expect([...files.keys()].sort()).toEqual(['clip.mp4', 'hall.jpg', 'plain.jpg']);
    const want = Buffer.from(plain);
    cleanForHandover(want);
    expect(files.get('plain.jpg')!.equals(want)).toBe(true);
    expect((await exifOf(files.get('hall.jpg')!)).GPSInfo).toBeUndefined();
    expect(placeTags(probeBytes(files.get('clip.mp4')!))).toEqual([]);
    const m = await byName('plain.jpg');
    await h.admin.patch('/api/admin/media').send({ ids: [m.id], action: 'hide' }).expect(200);
    files = await zip();
    expect([...files.keys()].sort()).toEqual(['clip.mp4', 'hall.jpg']);
    await h.admin.patch('/api/admin/media').send({ ids: [m.id], action: 'unhide' }).expect(200);
    await settle(h);
  });

  it('a video whose location-free copy was deleted in OneDrive: the video itself goes in, not its preview', async () => {
    const m = await byName('clip.mp4');
    fs.rmSync(copyPath(h, m.clean_key));
    const files = await zip();
    const got = files.get('clip.mp4')!;
    expect(got).toBeTruthy();
    expect(got.equals(fs.readFileSync(copyPath(h, m.video_key)))).toBe(false);
    expect(placeTags(probeBytes(got))).toEqual([]);
    expect((await byName('clip.mp4')).clean_key).toBeNull();
    await settle(h);
    const { rebuildPass } = await import('../src/media/rebuild.js');
    await rebuildPass(h.ctx);
    expect((await byName('clip.mp4')).clean_key).toMatch(/^od\//);
  });

  it('an original that cannot be fetched: the album copy from OneDrive goes in instead', async () => {
    const m = await byName('plain.jpg');
    const away = path.join(h.driveDir, '..', 'plain-away.jpg');
    fs.renameSync(path.join(h.driveDir, FOLDER, 'plain.jpg'), away);
    try {
      const files = await zip();
      const fallback = [...files.entries()].find(([n]) => n.startsWith('plain'))!;
      expect(fallback[0]).toBe('plain.webp');
      expect(fallback[1].equals(fs.readFileSync(copyPath(h, m.web_key)))).toBe(true);
    } finally {
      fs.renameSync(away, path.join(h.driveDir, FOLDER, 'plain.jpg'));
    }
  });
});

describe('archiving the event', () => {
  it('drops its download copies (full and clean) from OneDrive; the album copies stay', async () => {
    const hallRow = await byName('hall.jpg');
    const clipRow = await byName('clip.mp4');
    expect(copyFiles(h, event.id, 'full').length).toBeGreaterThan(0);
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'archived' }).expect(200);
    await settle(h);
    expect(copyFiles(h, event.id, 'full')).toEqual([]);
    expect(copyFiles(h, event.id, 'clean')).toEqual([]);
    expect((await h.ctx.db.query(`select 1 from full_copies f join media m on m.id = f.media_id where m.event_id = $1`, [event.id])).rows).toEqual([]);
    expect((await byName('clip.mp4')).clean_key).toBeNull();
    expect(fs.existsSync(copyPath(h, hallRow.thumb_key))).toBe(true);
    expect(fs.existsSync(copyPath(h, clipRow.video_key))).toBe(true);
  });
});
