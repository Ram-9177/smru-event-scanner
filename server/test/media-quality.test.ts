/**
 * What the review of the photo and video quality work found (17 November 2026), each kept from coming back:
 *   - iPhone photos (HEIC, a grid of tiles, Display P3) are read from an upload (held in memory) and keep their colours
 *   - the fix (Improve photos) moves brightness only, measures blacks and whites per colour channel, and leaves a
 *     colour-lit or saturated photo alone
 *   - a downloaded original goes out as it is only when every block of its metadata was read and cleaned
 *   - full-quality copies are kept for the next student; the New event form's "Improve photos" is stored
 *   - HEIC files an earlier version skipped are taken in; HDR (HLG) video becomes the normal picture
 */
import fs from 'node:fs';
import path from 'node:path';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanForHandover } from '../src/media/location.js';
import { applyLook, fullQuality, measureLook, prepare } from '../src/media/prepare.js';
import { hdrToSdr } from '../src/media/hdr.js';
import { expectNoLocalMedia, copyFiles, copyPath, makeEvent, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

const GRID_P3 = fs.readFileSync(new URL('./fixtures/iphone-grid-p3.heic', import.meta.url));
// The fixture: four patches, made in sRGB as red (255,0,3), green (3,255,0), skin (200,120,90) and grey (128),
// saved by Apple's encoder as a tiled HEIC in Display P3 (the iPhone layout).
const at = async (img: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(img).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const i = (Math.round(y * info.height) * info.width + Math.round(x * info.width)) * 3;
  return [data[i], data[i + 1], data[i + 2]];
};
const near = (got: number[], want: number[], tol = 8) => got.every((v, i) => Math.abs(v - want[i]) <= tol);

const GPS = { GPSLatitudeRef: 'N', GPSLatitude: '17/1 23/1 1234/100', GPSLongitudeRef: 'E', GPSLongitude: '78/1 29/1 5678/100' };
const withGps = (w = 64) => sharp({ create: { width: w, height: w, channels: 3, background: '#7a8a9a' } }).withExif({ IFD0: { Make: 'Cam' }, IFD3: GPS } as any).jpeg().toBuffer();
const gpsIn = async (jpeg: Buffer) => {
  const exif = (await sharp(jpeg).metadata()).exif;
  return !!(exif && exifReader(exif).GPSInfo);
};

describe('iPhone photos (HEIC)', () => {
  it('a tiled HEIC sent as an upload (in memory) is read, upright, in its true colours', async () => {
    const prep = await prepare(GRID_P3, { workMaxPx: 4096 });
    expect([prep.width, prep.height]).toEqual([1200, 900]);
    expect(near(await at(prep.work, 0.25, 0.25), [255, 0, 3])).toBe(true); // was 234,51,35: P3 values read as sRGB
    expect(near(await at(prep.work, 0.25, 0.75), [200, 120, 90])).toBe(true);
  });

  it('its full-quality download is a JPEG in its own colours (the Display P3 profile kept), 4:2:0 as taken', async () => {
    const file = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'mq-')), 'IMG_0001.HEIC');
    fs.writeFileSync(file, GRID_P3);
    const out = await fullQuality(file, null);
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1200, height: 900, chromaSubsampling: '4:2:0' });
    expect(meta.icc?.length).toBeGreaterThan(400);
    expect(meta.xmp).toBeUndefined();
    expect(near(await at(out, 0.25, 0.25), [255, 0, 3])).toBe(true); // shown right through its profile
  });
});

describe('the fix (Improve photos)', () => {
  const photo = (fill: (x: number, y: number) => [number, number, number], w = 320, h = 240) => {
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(fill(x / w, y / h), (y * w + x) * 3);
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  };

  it('leaves a stage under blue light alone: one channel is at white even though the brightness is low', async () => {
    const stage = await photo((x, y) => [Math.round(20 + 30 * x), Math.round(10 + 20 * y), Math.round(60 + 195 * x)]);
    expect(await measureLook(stage)).toBeNull();
  });

  it('fixes a hazy photo, and a dark photo with no bright parts gets its mid-tones lifted', async () => {
    const hazy = await photo((x, y) => {
      const v = Math.round(70 + 120 * x);
      return [v, v - Math.round(10 * y), v - 5];
    });
    expect((await measureLook(hazy))?.lo).toBeGreaterThan(0);
    const dark = await photo((x) => {
      const v = Math.round(5 + 95 * x * x);
      return [v, v, v];
    });
    expect((await measureLook(dark))?.gamma).toBeGreaterThan(1);
  });

  it('moves brightness only: a pixel keeps its colour (channel ratios) and never goes past white', async () => {
    const raw = Buffer.from([60, 45, 30, 200, 150, 120, 250, 40, 20, 0, 0, 0]);
    await applyLook(raw, 3, { lo: 0.1, hi: 0.8, gamma: 1.2, sat: 1 });
    const ratio = (a: number, b: number) => a / Math.max(b, 1);
    expect(ratio(raw[0], raw[1])).toBeCloseTo(60 / 45, 1);
    expect(ratio(raw[1], raw[2])).toBeCloseTo(45 / 30, 1);
    expect(ratio(raw[3], raw[5])).toBeCloseTo(200 / 120, 1);
    expect(Math.max(...raw)).toBeLessThanOrEqual(255);
    expect(raw[6]).toBe(255); // the saturated red reaches white in its own channel only
    expect(ratio(raw[6], raw[7])).toBeCloseTo(250 / 40, 0);
    expect([...raw.subarray(9)]).toEqual([0, 0, 0]);
  });
});

describe('an original goes out as it is only when its metadata could be cleaned', () => {
  it('a plain phone JPEG: its GPS goes, and it may go as it is', async () => {
    const jpeg = await withGps();
    expect(cleanForHandover(jpeg)).toBe(true);
    expect(await gpsIn(jpeg)).toBe(false);
  });

  it('IPTC place names are blanked; the rest of the block stays readable', async () => {
    const jpeg = await withGps();
    const city = Buffer.from('Hyderabad');
    const iptc = Buffer.concat([Buffer.from([0x1c, 2, 90, 0, city.length]), city, Buffer.from([0x1c, 2, 120, 0, 4]), Buffer.from('Fest')]);
    const res = Buffer.concat([Buffer.from('8BIM'), Buffer.from([0x04, 0x04, 0, 0]), Buffer.from([0, 0, 0, iptc.length]), iptc, iptc.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    const body = Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), res]);
    const app13 = Buffer.concat([Buffer.from([0xff, 0xed, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
    const file = Buffer.concat([jpeg.subarray(0, 2), app13, jpeg.subarray(2)]);
    expect(cleanForHandover(file)).toBe(true);
    expect(file.includes('Hyderabad')).toBe(false);
    expect(file.includes('Fest')).toBe(true);
  });

  it('refuses what it cannot clean: a drone GPS in XMP, a video appended to the photo, a HEIF/AVIF original', async () => {
    const drone = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#888' } })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" drone-dji:GpsLatitude="17.39" drone-dji:GpsLongitude="78.48"/></rdf:RDF></x:xmpmeta>')
      .jpeg()
      .toBuffer();
    expect(cleanForHandover(drone)).toBe(false);
    const motion = Buffer.concat([await withGps(), Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0mp42isom', 'latin1')]);
    expect(cleanForHandover(motion)).toBe(false);
    const avif = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#888' } }).withExif({ IFD3: GPS } as any).avif().toBuffer();
    expect(cleanForHandover(avif)).toBe(false);
  });

  it('a second picture appended by the phone (an HDR gain map) is cleaned too', async () => {
    const file = Buffer.concat([await withGps(), await withGps(16)]);
    expect(cleanForHandover(file)).toBe(true);
    const second = file.subarray(file.indexOf(Buffer.from([0xff, 0xd9])) + 2);
    expect(await gpsIn(second)).toBe(false);
  });
});

describe('HDR video', () => {
  it('HLG reference white becomes nearly SDR white, black stays black, a colour keeps its hue', () => {
    const white = hdrToSdr('hlg', 0.75, 0.75, 0.75);
    expect(white[0]).toBeGreaterThan(0.9);
    expect(white[0]).toBeLessThanOrEqual(1);
    expect(hdrToSdr('hlg', 0, 0, 0)).toEqual([0, 0, 0]);
    const skin = hdrToSdr('hlg', 0.62, 0.5, 0.44); // a skin tone: stays warm, in the same order of channels
    expect(skin[0]).toBeGreaterThan(skin[1]);
    expect(skin[1]).toBeGreaterThan(skin[2]);
    const peak = hdrToSdr('pq', 0.9, 0.9, 0.9); // about 4000 nits: rolled off into white, not past it
    expect(Math.max(...peak)).toBeLessThanOrEqual(1);
  });
});

describe('through the app', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
  });
  afterAll(() => h.close());
  // The owner's rule: no photo or video bytes stay on this server.
  afterEach(() => expectNoLocalMedia(h));

  it('the New event form keeps "Improve photos" off when it is unticked', async () => {
    const e = (await h.admin.post('/api/admin/events').send({ title: 'No Fix Day', improve_photos: false }).expect(201)).body.event;
    expect((await h.ctx.db.query<any>(`select improve_photos from events where id = $1`, [e.id])).rows[0].improve_photos).toBe(false);
  });

  it('an iPhone photo an earlier version listed as skipped is taken in at the next sync', async () => {
    const e = await makeEvent(h, 'Old HEIC', 'Old HEIC');
    h.put(e.folder.name, 'IMG_0001.HEIC', GRID_P3);
    await syncNow(h, e.id);
    await settle(h);
    await h.ctx.db.query(`update media set status = 'skipped', status_reason = 'HEIC photo: convert it to JPG first', thumb_key = null, web_key = null where event_id = $1`, [e.id]);
    await syncNow(h, e.id);
    await settle(h);
    const row = (await h.ctx.db.query<any>(`select status, status_reason, web_key from media where event_id = $1`, [e.id])).rows[0];
    expect(row).toMatchObject({ status: 'ready', status_reason: null });
    expect(near(await at(fs.readFileSync(copyPath(h, row.web_key)), 0.25, 0.25), [255, 0, 3], 10)).toBe(true);
  });

  it("a student's iPhone photo (tiled HEIC) is accepted, and a full-quality copy once made is served again without OneDrive", async () => {
    const e = await makeEvent(h, 'Phone Day', 'Phone Day', { crowd_uploads: true, auto_approve: true, allow_download: true });
    h.put(e.folder.name, 'group.jpg', await makePhoto(41, [{ person: PERSON.red }]));
    await syncNow(h, e.id);
    await settle(h);
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);
    expect((await phone(h, 'iphone-grid').upload(e.slug, GRID_P3, 'image/heic').expect(201)).body.result).toBe('added');

    const id = (await h.ctx.db.query<any>(`select id from media where event_id = $1 and name = 'group.jpg'`, [e.id])).rows[0].id;
    await h.ctx.db.query(`update media set copies_fixed = true, look = $2 where id = $1`, [id, JSON.stringify({ lo: 0.06, hi: 0.85, gamma: 1, sat: 1 })]);
    const p = phone(h, 'red-student');
    await p.selfie(e.slug, await makeSelfie(PERSON.red)).expect(200);
    const binary = (res: any, cb: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const first = await p.get(`/api/e/${e.slug}/original/${id}?d=${p.token}`).expect(200).buffer(true).parse(binary);
    const original = (await h.ctx.db.query<any>(`select onedrive_item_id from media where id = $1`, [id])).rows[0].onedrive_item_id;
    const fetches: string[] = [];
    const real = h.ctx.drive.download.bind(h.ctx.drive);
    const realAll = h.ctx.drive.readAll.bind(h.ctx.drive);
    h.ctx.drive.download = async (...args: Parameters<typeof real>) => (fetches.push(String(args[0])), real(...args));
    h.ctx.drive.readAll = async (...args: Parameters<typeof realAll>) => (fetches.push(String(args[0])), realAll(...args));
    try {
      const again = await p.get(`/api/e/${e.slug}/original/${id}?d=${p.token}`).expect(200).buffer(true).parse(binary);
      expect(again.body.equals(first.body)).toBe(true);
      expect(fetches).not.toContain(original); // streamed from the full-quality copy kept in OneDrive
    } finally {
      h.ctx.drive.download = real;
      h.ctx.drive.readAll = realAll;
    }
    // kept in OneDrive's app folder (<event>/full), with its row; nothing on this server
    expect(copyFiles(h, e.id, 'full').filter((n) => n.startsWith(id))).toHaveLength(1);
    expect((await h.ctx.db.query(`select 1 from full_copies where media_id = $1`, [id])).rows).toHaveLength(1);
    expect(fs.existsSync(path.join(h.ctx.cfg.dataDir, 'full'))).toBe(false);
  });
});
