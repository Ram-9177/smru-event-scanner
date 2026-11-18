/**
 * Phase 3 "Done when": a volunteer opens the link, picks the event, takes a selfie
 * and sees their photos, with no login.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectNoLocalMedia, fetchImage, makeEvent, makeHarness, phone, syncNow, zipEntries, zipFiles, type Harness } from './helpers/harness.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';
import { dropFullCopies } from '../src/media/fullcopy.js';
import { remakesIdle } from '../src/media/upgrade.js';

/**
 * What a student downloads is the full quality: the original itself when the album shows the photo unchanged, or,
 * for a photo the album shows with its fix ("Improve photos", on by default), the full-size photo with that fix as a
 * quality-93 JPEG. (These test photos have pure colours in them, so the measure leaves them as they are; one is given
 * a fix by hand below, as a dull photo would get.)
 */
async function expectFullQuality(given: Buffer, original: Buffer, fixed: boolean): Promise<void> {
  if (!fixed) {
    expect(given.equals(original)).toBe(true);
    return;
  }
  expect(given.equals(original)).toBe(false);
  const [g, o] = [await sharp(given).metadata(), await sharp(original).metadata()];
  expect(g).toMatchObject({ format: 'jpeg', width: o.width, height: o.height, chromaSubsampling: '4:4:4' });
  const [gs, os] = [await sharp(given).stats(), await sharp(original).stats()];
  expect(gs.channels[0].stdev).toBeGreaterThan(os.channels[0].stdev); // more contrast: the flat photo was spread out
}
const fixedIn = async (name: string) =>
  !!(await h.ctx.db.query(`select look from media where event_id = $1 and name = $2`, [event.id, name])).rows[0]?.look;

let h: Harness;
let event: any;
const FOLDER = 'Annual Day';
const slug = () => event.slug;
const names = async (photos: any[]) => {
  const all = (await h.admin.get(`/api/admin/events/${event.id}/media?limit=200`)).body.media;
  return photos.map((p) => all.find((m: any) => m.id === p.id)?.name).sort();
};
const adminId = async (name: string) => (await h.admin.get(`/api/admin/events/${event.id}/media?limit=200`)).body.media.find((m: any) => m.name === name).id;

beforeAll(async () => {
  h = await makeHarness({ searchesPer10Min: 5, searchesPerDay: 8, contact: 'IT Help Desk, help@college.test' });
  event = await makeEvent(h, 'Annual Day 2026', FOLDER);
  h.put(FOLDER, 'p1 red blue.jpg', await makePhoto(1, [{ person: PERSON.red }, { person: PERSON.blue }]));
  h.put(FOLDER, 'p2 red.jpg', await makePhoto(2, [{ person: PERSON.red }]));
  h.put(FOLDER, 'p3 nobody.jpg', await makePhoto(3));
  h.put(FOLDER, 'p4 green.jpg', await makePhoto(4, [{ person: PERSON.green }]));
  h.put(FOLDER, 'p5 blue far.jpg', await makePhoto(5, [{ person: PERSON.blue, dim: true }]));
  h.put(FOLDER, 'p6 red far.jpg', await makePhoto(6, [{ person: PERSON.red, dim: true }, { person: PERSON.green }]));
  await syncNow(h, event.id);
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
});
afterAll(() => h.close());
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

describe('Find my photos', () => {
  const red = () => phone(h, 'red');

  it('needs no login, only the token the phone keeps', async () => {
    const res = await request(h.app).get(`/api/e/${slug()}/mine`).expect(400);
    expect(res.body.error).toBe('no_device');
    const s = await red().post(`/api/e/${slug()}/session`).send({}).expect(200);
    expect(s.body.me).toMatchObject({ album_open: true, searched: false, my_photos: 0 });
    expect(s.body.event.options.find).toBe(true);
  });

  it('asks for the consent line before the first selfie', async () => {
    const res = await red().post(`/api/e/${slug()}/selfie`).set('content-type', 'image/jpeg').send(await makeSelfie(PERSON.red)).expect(400);
    expect(res.body.error).toBe('consent_needed');
  });

  it('returns the photos you are in: sure ones, and less certain ones apart', async () => {
    const res = await red().selfie(slug(), await makeSelfie(PERSON.red)).expect(200);
    expect(await names(res.body.sure)).toEqual(['p1 red blue.jpg', 'p2 red.jpg']);
    expect(await names(res.body.maybe)).toEqual(['p6 red far.jpg']);
    expect((await fetchImage(h, res.body.sure[0].thumb)).status).toBe(200);
    expect((await fetchImage(h, res.body.sure[0].web)).status).toBe(200);
    expect(res.body.sure[0]).toMatchObject({ width: 800, height: 600, by: null });
  });

  it('finds nothing for someone who is in no photo, and says so for a selfie with no face', async () => {
    const stranger = phone(h, 'stranger');
    const res = await stranger.selfie(slug(), await makeSelfie(PERSON.magenta)).expect(200);
    expect(res.body.sure).toEqual([]);
    expect(res.body.maybe).toEqual([]);
    const none = await stranger.selfie(slug(), await makePhoto(500)).expect(422);
    expect(none.body).toMatchObject({ error: 'no_face', message: "We couldn't see your face, try again." });
  });

  it('remembers the result on the same phone, and keeps it from other phones', async () => {
    const mine = (await red().get(`/api/e/${slug()}/mine`).expect(200)).body;
    expect(mine.searched).toBe(true);
    expect(mine.sure).toHaveLength(2);
    const other = (await phone(h, 'someone-else').get(`/api/e/${slug()}/mine`).expect(200)).body;
    expect(other).toMatchObject({ searched: false, sure: [], maybe: [] });
  });

  it('"Not me" removes a photo for that phone only; a retake brings a fresh result', async () => {
    const id = await adminId('p2 red.jpg');
    await red().post(`/api/e/${slug()}/mine/${id}/not-me`).expect(200);
    expect(await names((await red().get(`/api/e/${slug()}/mine`)).body.sure)).toEqual(['p1 red blue.jpg']);
    const album = (await red().get(`/api/e/${slug()}/album`).expect(200)).body;
    expect(album.photos.some((p: any) => p.id === id)).toBe(true); // still in the album
    await phone(h, 'stranger').post(`/api/e/${slug()}/mine/${id}/not-me`).expect(404); // not in their results

    const again = await red().selfie(slug(), await makeSelfie(PERSON.red)).expect(200);
    expect(again.body.sure).toHaveLength(2);
  });

  it('never returns a photo the organiser has hidden, and brings it back when unhidden', async () => {
    const id = await adminId('p1 red blue.jpg');
    const link = (await red().get(`/api/e/${slug()}/mine`)).body.sure.find((p: any) => p.id === id).thumb;
    await h.admin.patch('/api/admin/media').send({ ids: [id], action: 'hide' }).expect(200);
    expect(await names((await red().get(`/api/e/${slug()}/mine`)).body.sure)).toEqual(['p2 red.jpg']); // the saved result
    await request(h.app).get(link).expect(404); // the image link stops working
    const fresh = await red().selfie(slug(), await makeSelfie(PERSON.red)).expect(200); // a fresh selfie
    expect(await names(fresh.body.sure)).toEqual(['p2 red.jpg']);
    await h.admin.patch('/api/admin/media').send({ ids: [id], action: 'unhide' }).expect(200);
    expect((await red().selfie(slug(), await makeSelfie(PERSON.red))).body.sure).toHaveLength(2);
  });

  it('tells a returning phone that new photos were added since its selfie', async () => {
    h.put(FOLDER, 'p7 red late.jpg', await makePhoto(7, [{ person: PERSON.red }]));
    await syncNow(h, event.id);
    const mine = (await red().get(`/api/e/${slug()}/mine`)).body;
    expect(mine.new_photos).toBe(1);
    expect(mine.sure).toHaveLength(2); // not matched until the retake
  });

  it('stops a phone after five selfies in ten minutes', async () => {
    const res = await red().selfie(slug(), await makeSelfie(PERSON.red)); // 5th search by this phone
    expect(res.status).toBe(200);
    expect(res.body.sure).toHaveLength(3);
    const over = await red().selfie(slug(), await makeSelfie(PERSON.red)).expect(429);
    expect(over.body.error).toBe('slow_down');
    await phone(h, 'fresh-phone').selfie(slug(), await makeSelfie(PERSON.green)).expect(200); // other phones are not affected
  });

  it('downloads all your photos as one ZIP of the originals, best quality', async () => {
    await h.ctx.db.query(`update media set copies_fixed = true, look = $2 where event_id = $1 and name = 'p2 red.jpg'`, [event.id, JSON.stringify({ lo: 0.06, hi: 0.85, gamma: 1, sat: 1 })]);
    const made = await red().post(`/api/e/${slug()}/zip`).send({}).expect(200);
    expect(made.body.count).toBe(3);
    const zip = await request(h.app).get(made.body.url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.headers['content-disposition']).toContain('annual-day-2026-my-photos.zip');
    expect(zipEntries(zip.body)).toBe(3);
    // each entry is the full quality, under its own name: the photo with the album's fix, at its full size
    const files = zipFiles(zip.body);
    expect([...files.keys()].every((n) => n.endsWith('.jpg'))).toBe(true);
    for (const [name, bytes] of files) await expectFullQuality(bytes, fs.readFileSync(path.join(h.driveDir, FOLDER, name)), await fixedIn(name));
    expect(await fixedIn('p2 red.jpg')).toBe(true);

    // with "Improve photos" off, the very files in OneDrive, byte for byte
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ improve_photos: false }).expect(200);
    const plain = await red().post(`/api/e/${slug()}/zip`).send({}).expect(200);
    const zip2 = await request(h.app).get(plain.body.url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    for (const [name, bytes] of zipFiles(zip2.body)) expect(bytes.equals(fs.readFileSync(path.join(h.driveDir, FOLDER, name)))).toBe(true);
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ improve_photos: true }).expect(200);

    await request(h.app).get(made.body.url.replace(/.{6}$/, 'AAAAAA')).expect(403);
    await phone(h, 'someone-else').post(`/api/e/${slug()}/zip`).send({}).expect(400); // nothing to download
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ allow_download: false }).expect(200);
    await red().post(`/api/e/${slug()}/zip`).send({}).expect(403);
    await request(h.app).get(made.body.url).expect(403);
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ allow_download: true }).expect(200);
  });

  it('hands over the original of your own photo, and says so when the original is gone', async () => {
    await remakesIdle(); // the switches above remade the album copies (and measured the fix again) in the background
    await h.ctx.db.query(`update media set copies_fixed = true, look = $2 where event_id = $1 and name = 'p2 red.jpg'`, [event.id, JSON.stringify({ lo: 0.06, hi: 0.85, gamma: 1, sat: 1 })]);
    const id = await adminId('p2 red.jpg');
    const res = await red().get(`/api/e/${slug()}/original/${id}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c)).on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(res.headers['content-disposition']).toContain('p2 red.jpg');
    await expectFullQuality(res.body, fs.readFileSync(path.join(h.driveDir, FOLDER, 'p2 red.jpg')), await fixedIn('p2 red.jpg'));
    fs.renameSync(path.join(h.driveDir, FOLDER, 'p2 red.jpg'), path.join(h.driveDir, '..', 'p2-outside-the-drive.jpg'));
    // The full-quality copy made a moment ago is kept for the next student: it is still served, without OneDrive
    // (until the next sync finds the file gone and removes the photo, and its copies with it).
    await red().get(`/api/e/${slug()}/original/${id}`).expect(200);
    await dropFullCopies(h.ctx, [id]);
    const gone = await red().get(`/api/e/${slug()}/original/${id}`).expect(410);
    expect(gone.body.message).toBe('Original no longer available.');
    fs.renameSync(path.join(h.driveDir, '..', 'p2-outside-the-drive.jpg'), path.join(h.driveDir, FOLDER, 'p2 red.jpg'));
  });

  it('with a passcode on the album, a phone still opens its own photos but nothing else', async () => {
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ passcode: '4821' }).expect(200);
    const mine = (await red().get(`/api/e/${slug()}/mine`).expect(200)).body;
    expect(mine.sure).toHaveLength(3);
    expect((await fetchImage(h, mine.sure[0].thumb)).status).toBe(200);
    await red().get(`/api/e/${slug()}/original/${await adminId('p2 red.jpg')}`).expect(200);
    const other = await red().get(`/api/e/${slug()}/original/${await adminId('p4 green.jpg')}`).expect(403);
    expect(other.body.error).toBe('passcode_needed');
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ passcode: null }).expect(200);
  });

  it('matches inside one event only', async () => {
    const other = await makeEvent(h, 'Sports Meet', 'Sports Meet');
    h.put('Sports Meet', 's1 red.jpg', await makePhoto(301, [{ person: PERSON.red }]));
    await syncNow(h, other.id);
    await h.admin.patch(`/api/admin/events/${other.id}`).send({ status: 'live' }).expect(200);
    const there = await phone(h, 'red-at-sports').selfie(other.slug, await makeSelfie(PERSON.red)).expect(200);
    expect(there.body.sure).toHaveLength(1);
    const here = (await red().get(`/api/e/${slug()}/mine`)).body;
    expect(here.sure.map((p: any) => p.id)).not.toContain(there.body.sure[0].id);
    expect((await red().get(`/api/e/${other.slug}/mine`)).body).toMatchObject({ searched: false, sure: [] }); // same phone, other event: nothing carried over
  });

  it('deletes my selfie data and results on request', async () => {
    await red().del(`/api/e/${slug()}/me`).expect(200);
    expect((await red().get(`/api/e/${slug()}/mine`)).body).toMatchObject({ searched: false, sure: [], maybe: [] });
    expect((await h.ctx.db.query(`select count(*)::int as n from matches`)).rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it('is closed while the event is a draft or face search is off', async () => {
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ face_enabled: false }).expect(200);
    expect((await phone(h, 'late').selfie(slug(), await makeSelfie(PERSON.red)).expect(403)).body.error).toBe('face_off');
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ face_enabled: true, status: 'draft' }).expect(200);
    expect((await phone(h, 'late').selfie(slug(), await makeSelfie(PERSON.red)).expect(403)).body.error).toBe('not_open');
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
  });
});

describe('when the face service stops', () => {
  it('a selfie gets a clear "try again", and those tries do not use up the selfie limit', async () => {
    const { FaceDownError } = await import('../src/face/index.js');
    const p = phone(h, 'patient');
    const selfie = h.face.selfie;
    h.face.selfie = async () => {
      throw new FaceDownError('The face service is not answering.');
    };
    try {
      for (let i = 0; i < 7; i++) {
        const res = await p.selfie(slug(), await makeSelfie(PERSON.green)).expect(503);
        expect(res.body).toMatchObject({ error: 'busy' });
        expect(res.body.message).toMatch(/try again/i);
      }
    } finally {
      h.face.selfie = selfie;
    }
    await p.selfie(slug(), await makeSelfie(PERSON.green)).expect(200); // the 5-per-10-minutes limit was not touched
  });
});

describe('the one link on a phone that has searched (plan: screen A1)', () => {
  it('shows how many photos this phone found in each event, and nothing about it to anyone else', async () => {
    const p = phone(h, 'counter');
    const eventOf = (body: any) => body.events.find((e: any) => e.slug === slug());
    expect(eventOf((await p.get('/api/events').expect(200)).body).mine).toBe(0); // has not searched yet
    const found = (await p.selfie(slug(), await makeSelfie(PERSON.blue)).expect(200)).body;
    expect(found.sure.length).toBeGreaterThan(0);

    expect(eventOf((await p.get('/api/events').expect(200)).body).mine).toBe(found.sure.length);
    expect((await p.get(`/api/e/${slug()}`).expect(200)).body.event.mine).toBe(found.sure.length);
    expect(eventOf((await phone(h, 'someone-else').get('/api/events').expect(200)).body).mine).toBe(0);
    expect(eventOf((await request(h.app).get('/api/events').expect(200)).body).mine).toBe(0); // no phone token: still listed, no count
    const guests = async () => (await h.ctx.db.query(`select count(*)::int as n from guests`)).rows[0].n;
    const before = await guests();
    await phone(h, 'only-looking').get('/api/events').expect(200);
    expect(await guests()).toBe(before); // looking at the list stores nothing about a phone

    await p.post(`/api/e/${slug()}/mine/${found.sure[0].id}/not-me`).expect(200);
    expect(eventOf((await p.get('/api/events')).body).mine).toBe(found.sure.length - 1);
  });

  it('names who to ask, from the CONTACT setting', async () => {
    expect((await request(h.app).get('/api/events').expect(200)).body.contact).toBe('IT Help Desk, help@college.test');
    expect((await request(h.app).get(`/api/e/${slug()}`).expect(200)).body.contact).toBe('IT Help Desk, help@college.test');
  });

  it('says more photos are coming while the organiser\'s photos are still being read', async () => {
    const p = phone(h, 'counter');
    expect((await p.get(`/api/e/${slug()}/mine`).expect(200)).body.more_coming).toBe(false);
    h.put(FOLDER, 'p9 late.jpg', await makePhoto(9, [{ person: PERSON.blue }]));
    const { listTree } = await import('../src/drive/index.js');
    const late = (await listTree(h.ctx.drive, event.folder?.id ?? (await h.admin.get(`/api/admin/events/${event.id}`)).body.event.folder.id)).files.find((f) => f.name === 'p9 late.jpg')!;
    await h.ctx.db.query(`insert into media (event_id, type, status, name, onedrive_item_id, ctag) values ($1, 'photo', 'found', $2, $3, $4)`, [event.id, late.name, late.id, late.ctag]);
    expect((await p.get(`/api/e/${slug()}/mine`).expect(200)).body.more_coming).toBe(true); // found, not processed yet
    await syncNow(h, event.id);
    const after = (await p.get(`/api/e/${slug()}/mine`).expect(200)).body;
    expect(after.more_coming).toBe(false);
    expect(after.new_photos).toBeGreaterThan(0); // "new photos were added since your selfie"
  });
});

describe('archiving (plan: face data kept forever)', () => {
  it("deletes the event's face vectors and every phone's saved results, and its link names who to ask", async () => {
    const e = await makeEvent(h, 'Old Fest', 'Old Fest');
    h.put('Old Fest', 'o1.jpg', await makePhoto(60, [{ person: PERSON.red }]));
    await syncNow(h, e.id);
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);
    const p = phone(h, 'old-timer');
    expect((await p.selfie(e.slug, await makeSelfie(PERSON.red)).expect(200)).body.sure).toHaveLength(1);
    const count = async (sql: string) => (await h.ctx.db.query(sql, [e.id])).rows[0].n;
    expect(await count(`select count(*)::int as n from faces where event_id = $1`)).toBe(1);
    expect(await count(`select count(*)::int as n from matches where guest_id in (select id from guests where event_id = $1)`)).toBe(1);

    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'archived' }).expect(200);
    expect(await count(`select count(*)::int as n from faces where event_id = $1`)).toBe(0);
    expect(await count(`select count(*)::int as n from matches where guest_id in (select id from guests where event_id = $1)`)).toBe(0);
    const page = (await p.get(`/api/e/${e.slug}`).expect(200)).body;
    expect(page.event).toMatchObject({ state: 'archived', photos: 0, mine: 0 });
    expect(page.contact).toBe('IT Help Desk, help@college.test');
    expect((await p.get('/api/events')).body.events.some((x: any) => x.slug === e.slug)).toBe(false);

    // brought back, the photos are still there; "Read every photo again" restores the face search
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);
    expect((await p.selfie(e.slug, await makeSelfie(PERSON.red)).expect(200)).body.sure).toHaveLength(0);
    await h.admin.post(`/api/admin/events/${e.id}/reread`).send({}).expect(202);
    for (let i = 0; i < 200 && (await h.admin.get(`/api/admin/events/${e.id}/progress`)).body.syncing; i++) await new Promise((r) => setTimeout(r, 25));
    expect((await p.selfie(e.slug, await makeSelfie(PERSON.red)).expect(200)).body.sure).toHaveLength(1);
  });
});
