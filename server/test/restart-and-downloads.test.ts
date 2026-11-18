/**
 * What a restart leaves behind, what students download, and the limits on what anyone can send or fetch:
 *   - uploads cut off by a restart: a row with a file in OneDrive goes back in the line; one without goes, an
 *     organiser's too, and a student's phone gets its upload back; data/tmp is emptied of the server's leftovers
 *   - a photo that became a copy (its content changed, or an organiser's original arrived) leaves the People folders
 *   - Download all and Save original: the original file, without the GPS position (nothing else changes); a link
 *     works once, one ZIP at a time per phone and a few per server; nothing is left in data/tmp
 *   - Add your photos: the server's free disk is checked before a video is received
 */
import fs from 'node:fs';
import path from 'node:path';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { setDiskProbe } from '../src/ops/disk.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DriveDownError } from '../src/drive/index.js';
import { cleanTempDir, tempPath } from '../src/media/files.js';
import { stripLocation } from '../src/media/location.js';
import { recoverInterruptedUploads } from '../src/media/upload.js';
import { sha256Hex } from '../src/lib/security.js';
import { expectNoLocalMedia, copyPath, makeEvent, makeHarness, phone, settle, syncNow, zipFiles, type Harness } from './helpers/harness.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness({ uploadsPerPhone: 20 });
});
afterAll(() => h.close());
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

const tmpDir = () => path.join(h.ctx.cfg.dataDir, 'tmp');
const tmpFiles = () => (fs.existsSync(tmpDir()) ? fs.readdirSync(tmpDir()) : []);
const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => cb(null, Buffer.concat(chunks)));
};
/**
 * A phone photo with the camera's details and where it was taken. Well exposed (it has real blacks and whites), so
 * the album shows it unchanged and its download is the original itself.
 */
const withGps = async (seed: number, faces = [{ person: PERSON.red }]) =>
  sharp(await makePhoto(seed, faces))
    .composite([
      { input: { create: { width: 800, height: 24, channels: 3, background: '#000000' } }, top: 0, left: 0 },
      { input: { create: { width: 800, height: 24, channels: 3, background: '#ffffff' } }, top: 576, left: 0 },
    ])
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'Phone 9' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '17/1 23/1 1234/100', GPSLongitudeRef: 'E', GPSLongitude: '78/1 29/1 5678/100' },
    })
    .jpeg({ quality: 92 })
    .toBuffer();
const exifOf = async (jpeg: Buffer): Promise<any> => {
  const m = await sharp(jpeg).metadata();
  return m.exif ? exifReader(m.exif) : {};
};
/** The same picture, the same bytes, apart from the location: only bytes inside the EXIF block differ. */
async function onlyLocationGone(original: Buffer, given: Buffer): Promise<void> {
  expect(given.length).toBe(original.length);
  expect((await exifOf(original)).GPSInfo).toBeTruthy();
  const after = await exifOf(given);
  expect(after.GPSInfo).toBeUndefined();
  expect(after.Image).toMatchObject({ Make: 'TestCam', Model: 'Phone 9' });
  const app1End = 4 + original.readUInt16BE(4) + 2; // the first segment after SOI is sharp's EXIF APP1
  expect(original.toString('latin1', 6, 10)).toBe('Exif');
  expect(given.subarray(app1End).equals(original.subarray(app1End))).toBe(true); // not one pixel re-encoded
}

describe('after a restart', () => {
  it('requeues uploads whose file reached OneDrive, removes the ones that never did (an organiser\'s too), and gives the phone its uploads back', async () => {
    const e = await makeEvent(h, 'Restart Day');
    const g = (await h.ctx.db.query<{ id: string }>(`insert into guests (event_id, device_token_hash, upload_count) values ($1, $2, 3) returning id`, [e.id, sha256Hex('restart-phone')])).rows[0].id;
    const add = async (fields: Record<string, unknown>) => {
      const cols = Object.keys(fields);
      const sql = `insert into media (event_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) returning id`;
      return (await h.ctx.db.query<{ id: string }>(sql, [e.id, ...Object.values(fields)])).rows[0].id;
    };
    const organiser = await add({ type: 'video', status: 'processing', source: 'onedrive', sha256: 'organiser-video' });
    const crowd1 = await add({ type: 'photo', status: 'processing', source: 'crowd', review: 'pending', sha256: 'crowd-1', uploader_guest_id: g });
    const crowd2 = await add({ type: 'video', status: 'processing', source: 'crowd', review: 'pending', sha256: 'crowd-2', uploader_guest_id: g });
    const saved = await add({ type: 'photo', status: 'processing', source: 'onedrive', onedrive_item_id: 'item-1', sha256: 'saved' });
    const ready = await add({ type: 'photo', status: 'ready', source: 'onedrive', onedrive_item_id: 'item-2', sha256: 'ready' });

    expect(await recoverInterruptedUploads(h.ctx.db)).toEqual({ requeued: 1, removed: 3 });
    const left = (await h.ctx.db.query<{ id: string; status: string }>(`select id, status from media where event_id = $1`, [e.id])).rows;
    expect(new Map(left.map((r) => [r.id, r.status]))).toEqual(new Map([[saved, 'found'], [ready, 'ready']]));
    for (const id of [organiser, crowd1, crowd2]) expect(left.some((r) => r.id === id)).toBe(false);
    expect((await h.ctx.db.query(`select upload_count from guests where id = $1`, [g])).rows[0].upload_count).toBe(1);
  });

  it("removes the stopped server's leftovers in data/tmp, and nothing else", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    const names = ['upload-1', 'zip-2-x', 'orig-3-y', 'abc-1.video', 'abc-1.preview.mp4', 'abc.orig', 'abc.again', 'adopt-4', 'check-5', 'notes.txt'];
    for (const n of names) {
      fs.writeFileSync(path.join(dir, n), 'x');
      fs.utimesSync(path.join(dir, n), old, old);
    }
    fs.writeFileSync(path.join(dir, 'upload-new'), 'being received right now');
    expect(cleanTempDir(h.ctx.cfg, new Date(Date.now() - 1000))).toBe(7);
    expect(tmpFiles().sort()).toEqual(['adopt-4', 'check-5', 'notes.txt', 'upload-new']);
    for (const n of tmpFiles()) fs.rmSync(path.join(dir, n));
  });
});

describe('a shown photo that becomes a copy leaves the People folders', () => {
  let e: any;
  let dir: string;
  let solo: () => string[];

  beforeAll(async () => {
    e = await makeEvent(h, 'Copies Day');
    dir = path.join(h.driveDir, e.folder.name);
    const person = (await h.admin.post('/api/admin/people').send({ name: 'Ms. Red', role: 'Dean' }).expect(201)).body.person;
    await h.admin.post(`/api/admin/people/${person.id}/photos`).set('content-type', 'image/jpeg').send(await makeSelfie(PERSON.red)).expect(201);
    await settle(h);
    solo = () => {
      const d = path.join(h.driveDir, 'People', 'Ms. Red - Dean', 'Solo');
      return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
    };
  });

  it('when its content in OneDrive is changed into the same file as another photo', async () => {
    const other = await makePhoto(802, [{ person: PERSON.red }]);
    fs.writeFileSync(path.join(dir, 'img-1.jpg'), await makePhoto(801, [{ person: PERSON.red }]));
    fs.writeFileSync(path.join(dir, 'img-2.jpg'), other);
    await syncNow(h, e.id);
    await settle(h);
    expect(solo()).toHaveLength(2);
    fs.writeFileSync(path.join(dir, 'img-1.jpg'), other);
    await syncNow(h, e.id);
    await settle(h);
    const rows = (await h.ctx.db.query<any>(`select name, id, duplicate_of from media where event_id = $1 order by name`, [e.id])).rows;
    expect(rows[0].duplicate_of).toBe(rows[1].id);
    expect(solo()).toHaveLength(1);
    expect(solo()[0]).toMatch(/img-2\.jpg$/);
  });

  it("when an organiser's original of a student's photo arrives", async () => {
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live', auto_approve: true }).expect(200);
    const pic = await makePhoto(803, [{ person: PERSON.red }]);
    const up = (await phone(h, 'copies-student').upload(e.slug, pic).expect(201)).body;
    await settle(h);
    expect(solo()).toHaveLength(2);
    fs.writeFileSync(path.join(dir, 'official.jpg'), pic);
    await syncNow(h, e.id);
    await settle(h);
    const official = (await h.ctx.db.query<any>(`select id from media where event_id = $1 and name = 'official.jpg'`, [e.id])).rows[0];
    expect((await h.ctx.db.query<any>(`select duplicate_of from media where id = $1`, [up.id])).rows[0].duplicate_of).toBe(official.id);
    expect(solo()).toHaveLength(2);
    expect(solo().some((n) => /official\.jpg$/.test(n))).toBe(true);
    expect(solo().some((n) => /img-2\.jpg$/.test(n))).toBe(true);
  });
});

describe('the location is taken out of what students download', () => {
  it('JPEG, PNG and WebP: the GPS block goes, the camera details and every pixel stay, the size is the same', async () => {
    const base = await makePhoto(810);
    const exif = { IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '17/1 23/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '78/1 29/1 0/1' } };
    for (const fmt of ['jpeg', 'png', 'webp'] as const) {
      const img = await sharp(base).withExif(exif).toFormat(fmt).toBuffer();
      const out = Buffer.from(img);
      expect(stripLocation(out)).toBe(true);
      expect(out.length).toBe(img.length);
      const after = exifReader((await sharp(out).metadata()).exif!) as any;
      expect(after.GPSInfo).toBeUndefined();
      expect(after.Image.Make).toBe('TestCam');
      expect((await sharp(out).raw().toBuffer()).equals(await sharp(img).raw().toBuffer())).toBe(true);
      expect(stripLocation(Buffer.from(out))).toBe(false); // nothing left to take out
    }
  });

  it("the GPS fields of a photo's XMP go too; the rest of it stays", async () => {
    const xmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" exif:GPSLatitude="17,23.2N" dc:format="image/jpeg">' +
      '<exif:GPSLongitude>78,29.9E</exif:GPSLongitude></rdf:Description></rdf:RDF></x:xmpmeta>';
    const img = await sharp(await makePhoto(811)).withXmp(xmp).jpeg().toBuffer();
    const out = Buffer.from(img);
    expect(stripLocation(out)).toBe(true);
    const text = out.toString('latin1');
    expect(text).not.toMatch(/GPS|17,23|78,29/);
    expect(text).toContain('dc:format="image/jpeg"');
    expect((await sharp(out).metadata()).xmp).toBeTruthy(); // still valid XMP
  });

  it('a file that is not a photo, or has no location, is left exactly as it is', () => {
    const junk = Buffer.from('not a photo at all, just some bytes'.repeat(10));
    const copy = Buffer.from(junk);
    expect(stripLocation(copy)).toBe(false);
    expect(copy.equals(junk)).toBe(true);
  });
});

describe('Download all and Save original', () => {
  let e: any;
  let dir: string;
  let gps: Buffer;
  let mediaId: string;

  beforeAll(async () => {
    e = await makeEvent(h, 'Trip Day', undefined, { allow_download: true });
    dir = path.join(h.driveDir, e.folder.name);
    gps = await withGps(820);
    fs.writeFileSync(path.join(dir, 'trip.jpg'), gps);
    await syncNow(h, e.id);
    await settle(h);
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);
    mediaId = (await h.ctx.db.query<any>(`select id from media where event_id = $1`, [e.id])).rows[0].id;
  });

  const student = async (name: string) => {
    const p = phone(h, name);
    expect((await p.selfie(e.slug, await makeSelfie(PERSON.red)).expect(200)).body.sure.map((x: any) => x.id)).toEqual([mediaId]);
    return p;
  };
  const link = async (p: ReturnType<typeof phone>) => (await p.post(`/api/e/${e.slug}/zip`).expect(200)).body.url as string;

  it('the ZIP has the original without its GPS position, and its link works once', async () => {
    const p = await student('zip-once');
    const url = await link(p);
    const zip = await p.get(url).expect(200).buffer(true).parse(binary);
    const [[name, bytes]] = [...zipFiles(zip.body)];
    expect(name).toBe('trip.jpg');
    await onlyLocationGone(gps, bytes);
    const again = await p.get(url).expect(403);
    expect(again.body.error).toBe('link_used');
    expect(fs.readFileSync(path.join(dir, 'trip.jpg')).equals(gps)).toBe(true); // the original in OneDrive is untouched
    expect(tmpFiles().filter((n) => n.startsWith('zip-'))).toEqual([]);
  });

  it('Save original gives the same: the original, without the location; nothing is left in data/tmp', async () => {
    const p = await student('orig-gps');
    const res = await p.get(`/api/e/${e.slug}/original/${mediaId}?d=${p.token}`).expect(200).buffer(true).parse(binary);
    await onlyLocationGone(gps, res.body);
    expect(tmpFiles().filter((n) => n.startsWith('orig-'))).toEqual([]);
  });

  it('a dark, flat photo: the album shows it fixed, and Save original and Download all give it fixed at its full size, camera and date kept, no location', async () => {
    const flatDay = await makeEvent(h, 'Flat Day', undefined, { allow_download: true });
    // dim and grey all over: a typical photo from a dark hall (brightness between 30 and 110 of 255)
    const flat = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#3c3c3c' } })
      .composite([
        { input: { create: { width: 600, height: 450, channels: 3, background: '#6e6a66' } }, top: 120, left: 80 },
        { input: { create: { width: 133, height: 133, channels: 3, background: '#1e1e1e' } }, top: 700, left: 1000 },
        { input: await makePhoto(77, [{ person: PERSON.green }], { w: 400, h: 300 }), top: 520, left: 700 },
      ])
      .withExif({
        IFD0: { Make: 'TestCam', Model: 'Phone 9' },
        IFD2: { DateTimeOriginal: '2026:11:14 18:30:05' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '17/1 23/1 1234/100', GPSLongitudeRef: 'E', GPSLongitude: '78/1 29/1 5678/100' },
      })
      .jpeg({ quality: 92 })
      .toBuffer();
    fs.writeFileSync(path.join(h.driveDir, flatDay.folder.name, 'hall.jpg'), flat);
    await syncNow(h, flatDay.id);
    await settle(h);
    await h.admin.patch(`/api/admin/events/${flatDay.id}`).send({ status: 'live' }).expect(200);
    const row = (await h.ctx.db.query<any>(`select id, look, web_key from media where event_id = $1`, [flatDay.id])).rows[0];
    expect(row.look).toBeTruthy(); // it needs a fix
    expect(row.look.hi).toBeLessThan(1);

    const p = phone(h, 'flat-hall');
    expect((await p.selfie(flatDay.slug, await makeSelfie(PERSON.green)).expect(200)).body.sure.map((x: any) => x.id)).toEqual([row.id]);
    const res = await p.get(`/api/e/${flatDay.slug}/original/${row.id}?d=${p.token}`).expect(200).buffer(true).parse(binary);
    expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(res.headers['content-disposition']).toContain('hall.jpg');
    const meta = await sharp(res.body).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1200, height: 900, chromaSubsampling: '4:2:0' }); // as the original
    const exif = await exifOf(res.body);
    expect(exif.GPSInfo).toBeUndefined();
    expect(exif.Image).toMatchObject({ Make: 'TestCam', Model: 'Phone 9' });
    expect(exif.Photo?.DateTimeOriginal?.toISOString()).toBe('2026-11-14T18:30:05.000Z');
    // more contrast than the original (its levels spread out), never darker overall
    const [after, before] = [await sharp(res.body).stats(), await sharp(flat).stats()];
    expect(after.channels[1].mean).toBeGreaterThan(before.channels[1].mean - 2);
    expect(after.channels[1].stdev).toBeGreaterThan(before.channels[1].stdev * 1.15);
    expect(after.channels[1].min).toBeLessThan(before.channels[1].min); // deeper blacks
    // the album's copy has the same fix
    const web = await sharp(copyPath(h, row.web_key)).stats();
    expect(Math.abs(web.channels[1].mean - after.channels[1].mean)).toBeLessThan(6);
    // Download all gives the same file
    const zip = await p.get(await link2(p, flatDay.slug)).expect(200).buffer(true).parse(binary);
    const [[name, bytes]] = [...zipFiles(zip.body)];
    expect(name).toBe('hall.jpg');
    expect(bytes.equals(res.body)).toBe(true);
    expect(fs.readFileSync(path.join(h.driveDir, flatDay.folder.name, 'hall.jpg')).equals(flat)).toBe(true); // the original in OneDrive is untouched
    expect(tmpFiles().filter((n) => n.startsWith('orig-') || n.startsWith('zip-'))).toEqual([]);
  });
  const link2 = async (p: ReturnType<typeof phone>, slug: string) => (await p.post(`/api/e/${slug}/zip`).expect(200)).body.url as string;

  it('an original whose download breaks part-way leaves no part-file behind', async () => {
    const p = await student('orig-broken');
    const real = h.ctx.drive.download.bind(h.ctx.drive);
    const realAll = h.ctx.drive.readAll.bind(h.ctx.drive);
    h.ctx.drive.download = async (_id: string, dest: string) => {
      fs.writeFileSync(dest, 'the first part of the file');
      throw new DriveDownError();
    };
    h.ctx.drive.readAll = async () => {
      throw new DriveDownError(); // the photo is read into memory: nothing is written here at all
    };
    try {
      expect((await p.get(`/api/e/${e.slug}/original/${mediaId}?d=${p.token}`).expect(503)).body.error).toBe('original_unavailable');
    } finally {
      h.ctx.drive.download = real;
      h.ctx.drive.readAll = realAll;
    }
    expect(tmpFiles().filter((n) => n.startsWith('orig-'))).toEqual([]);
  });

  it('one ZIP at a time for a phone and three for the server; a link refused for "busy" can be used again', async () => {
    const phones = await Promise.all(['zip-a', 'zip-b', 'zip-c', 'zip-d'].map(student));
    const urls = await Promise.all(phones.map(link));
    const second = await link(phones[0]);
    const real = h.ctx.drive.readAll.bind(h.ctx.drive);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let started = 0;
    h.ctx.drive.readAll = async (id: string, max: number, signal?: AbortSignal) => {
      started++;
      await gate; // OneDrive is slow today
      return real(id, max, signal);
    };
    try {
      const running = [0, 1, 2].map((i) => phones[i].get(urls[i]).buffer(true).parse(binary));
      running.forEach((r) => void r.then(() => {}, () => {}));
      for (let i = 0; i < 200 && started < 3; i++) await new Promise((r) => setTimeout(r, 10));
      expect(started).toBe(3);
      expect((await phones[0].get(second).expect(429)).body.error).toBe('zip_running');
      expect((await phones[3].get(urls[3]).expect(503)).body.error).toBe('busy');
      open();
      for (const r of await Promise.all(running)) expect(r.status).toBe(200);
    } finally {
      open();
      h.ctx.drive.readAll = real;
    }
    const later = await phones[3].get(urls[3]).expect(200).buffer(true).parse(binary);
    expect([...zipFiles(later.body).keys()]).toEqual(['trip.jpg']);
    await phones[0].get(second).expect(200); // the first one finished: this phone may download again
  });

  it('a phone cannot ask for links without end', async () => {
    const p = await student('zip-many');
    for (let i = 0; i < 10; i++) await p.post(`/api/e/${e.slug}/zip`).expect(200);
    expect((await p.post(`/api/e/${e.slug}/zip`).expect(429)).body.error).toBe('slow_down');
  });
});

describe('Add your photos: what the server checks before it reads a video', () => {
  it('refuses a video when data/tmp has no room for it, and the phone keeps its upload', async () => {
    const e = await makeEvent(h, 'Full Disk Day');
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);
    const p = phone(h, 'full-disk');
    // 1 GB free: enough for a photo (handled in memory), not for a video on top (about 2.3 times its size)
    setDiskProbe(async () => ({ free: 1024 ** 3, total: 1000 * 1024 ** 3 }));
    try {
      const res = await p.upload(e.slug, Buffer.alloc(2000, 1), 'video/mp4').expect(507);
      expect(res.body.error).toBe('disk_full');
    } finally {
      setDiskProbe(async () => ({ free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 }));
    }
    expect((await p.post(`/api/e/${e.slug}/session`).send({}).expect(200)).body.me.uploads_left).toBe(h.ctx.cfg.uploadsPerPhone);
    expect(tmpFiles().filter((n) => n.startsWith('upload-'))).toEqual([]);
    tempPath(h.ctx.cfg, 'x'); // the folder is there
  });
});
