/**
 * The same shot taken twice (burst shots, "one more, please", the same group photo three times) is shown once:
 * the better photo stays, the other becomes a copy that "Show anyway" brings back. Different photos, and the same
 * place with different people, both stay. Runs on the stand-in face engine (test/helpers/stub-face.ts).
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decideBurst, findBursts, sceneCache } from '../src/media/bursts.js';
import { expectNoLocalMedia, copyFiles, copyPath, makeEvent, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
const FOLDER = 'Wedding';
/** A photo put into the event's OneDrive folder (synced below). */
const send = async (data: Buffer, name: string) => h.put(FOLDER, name, data);
const sync = async () => {
  await syncNow(h, event.id);
  await settle(h);
};
const all = async () => (await h.admin.get(`/api/admin/events/${event.id}/media?filter=all&limit=200`).expect(200)).body.media as any[];
const byName = async (prefix: string) => (await all()).find((m) => m.name.startsWith(prefix));
/** A second frame of the same shot: a touch brighter, the camera moved a little. */
const burstOf = async (photo: Buffer, width?: number) => {
  const meta = await sharp(photo).metadata();
  const img = sharp(photo).extract({ left: 4, top: 3, width: meta.width! - 8, height: meta.height! - 6 }).modulate({ brightness: 1.04 });
  return (width ? img.resize({ width }) : img).jpeg({ quality: 88 }).toBuffer();
};

beforeAll(async () => {
  h = await makeHarness({ uploadsPerPhone: 50 });
  event = await makeEvent(h, 'Wedding', FOLDER);
});
afterAll(() => h.close());
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

describe('the same shot taken twice', () => {
  it('shows the larger of two frames of the same shot; the other becomes its copy', async () => {
    const shot = await makePhoto(301, [{ person: PERSON.red }, { person: PERSON.blue }], { w: 1600, h: 1200 });
    await send(await burstOf(shot, 1000), 'burst-small.jpg');
    await send(shot, 'burst-large.jpg');
    await sync();
    const small = await byName('burst-small');
    const large = await byName('burst-large');
    expect(large.duplicate_of).toBeNull();
    expect(small.duplicate_of).toBe(large.id);
    expect(small.web).toBeFalsy(); // a copy keeps only its thumbnail
    expect((await h.admin.get(`/api/admin/events/${event.id}/media?filter=duplicates`).expect(200)).body.total).toBe(1);
  });

  it('keeps different photos', async () => {
    await send(await makePhoto(310, [{ person: PERSON.green }]), 'other-a.jpg');
    await send(await makePhoto(311, [{ person: PERSON.green }]), 'other-b.jpg');
    await sync();
    for (const name of ['other-a', 'other-b']) expect((await byName(name)).duplicate_of).toBeNull();
  });

  it('keeps the same place with different people, even when the scenes match', async () => {
    // Two groups in front of the same stage: the background agrees completely, the people do not.
    const real = h.ctx.face.compare;
    h.ctx.face.compare = async () => ({ inliers: 900, ratio: 0.6, cover: 0.99, ncc: 0.99 });
    try {
      await send(await makePhoto(320, [{ person: PERSON.cyan }]), 'stage-cyan.jpg');
      await send(await makePhoto(321, [{ person: PERSON.magenta }]), 'stage-magenta.jpg');
      await sync();
    } finally {
      h.ctx.face.compare = real;
    }
    for (const name of ['stage-cyan', 'stage-magenta']) expect((await byName(name)).duplicate_of).toBeNull();
  });

  it('three frames of one group photo: one is shown', async () => {
    const group = await makePhoto(330, [{ person: PERSON.red }, { person: PERSON.yellow }, { person: PERSON.green }]);
    await send(group, 'group-1.jpg');
    await send(await burstOf(group), 'group-2.jpg');
    await send(await burstOf(await burstOf(group)), 'group-3.jpg');
    await sync();
    const frames = (await all()).filter((m) => m.name.startsWith('group-'));
    expect(frames.filter((m) => m.duplicate_of === null)).toHaveLength(1);
    const kept = frames.find((m) => m.duplicate_of === null)!;
    expect(frames.filter((m) => m.duplicate_of === kept.id)).toHaveLength(2); // every copy points at the shown one
  });

  it('a student finds themself in the shown frame, not twice', async () => {
    await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
    const found = await phone(h, 'red').selfie(event.slug, await makeSelfie(PERSON.red)).expect(200);
    const ids = found.body.sure.map((p: any) => p.id);
    expect(ids).toContain((await byName('burst-large')).id);
    expect(ids).not.toContain((await byName('burst-small')).id);
  });

  it('"Show anyway" brings a copy back for good', async () => {
    const small = await byName('burst-small');
    await h.admin.patch('/api/admin/media').send({ ids: [small.id], action: 'show_anyway' }).expect(200);
    await h.admin.post(`/api/admin/events/${event.id}/duplicates`).expect(200);
    expect((await byName('burst-small')).duplicate_of).toBeNull();
  });

  it('"Look for duplicates again" finds same shots among photos from before the rule', async () => {
    const shot = await makePhoto(340, [{ person: PERSON.blue }]);
    h.ctx.cfg.burstDuplicates = false; // as if these came in before the rule existed
    await send(shot, 'old-1.jpg');
    await send(await burstOf(shot), 'old-2.jpg');
    await sync();
    h.ctx.cfg.burstDuplicates = true;
    expect((await byName('old-1')).duplicate_of).toBeNull();
    expect((await byName('old-2')).duplicate_of).toBeNull();
    const res = await h.admin.post(`/api/admin/events/${event.id}/duplicates`).expect(200);
    expect(res.body.copies).toBe(1);
    const pair = [await byName('old-1'), await byName('old-2')];
    expect(pair.filter((m) => m.duplicate_of === null)).toHaveLength(1);
  });

  it('one decision takes in every frame of the shot, whichever frame it starts from', async () => {
    // The flaky case: frame 2's decision runs when frames 1 and 3 are both ready. It used to stop after the first
    // match and leave the third frame shown too.
    const shot = await makePhoto(360, [{ person: PERSON.red }, { person: PERSON.blue }, { person: PERSON.yellow }]);
    h.ctx.cfg.burstDuplicates = false;
    await send(shot, 'trio-1.jpg');
    await send(await burstOf(shot), 'trio-2.jpg');
    await send(await burstOf(await burstOf(shot)), 'trio-3.jpg');
    await sync();
    h.ctx.cfg.burstDuplicates = true;
    const copies = await decideBurst(h.ctx, event.id, (await byName('trio-2')).id);
    expect(copies).toHaveLength(2);
    const frames = (await all()).filter((m) => m.name.startsWith('trio-'));
    const kept = frames.filter((m) => m.duplicate_of === null);
    expect(kept).toHaveLength(1);
    expect(frames.filter((m) => m.duplicate_of === kept[0].id)).toHaveLength(2);
  });

  it('of two frames of the same size, the sharper one is shown, also for photos from before the rule', async () => {
    const shot = await makePhoto(370, [{ person: PERSON.green }, { person: PERSON.magenta }], { w: 1200, h: 900 });
    const blurred = await sharp(shot).blur(2.5).jpeg({ quality: 90 }).toBuffer();
    const real = h.ctx.face.scene;
    // the stand-in engine rates sharpness by width; here it measures it, as the real one does
    h.ctx.face.scene = async (jpeg: Buffer) => ({ ...(await real(jpeg)), sharpness: (await sharp(jpeg).stats()).sharpness });
    try {
      h.ctx.cfg.burstDuplicates = false; // no sharpness saved for them, as for photos from before the rule
      await send(blurred, 'focus-a-blurred.jpg'); // the earlier one, which would win a tie
      await sync();
      await send(shot, 'focus-b-sharp.jpg');
      await sync();
      h.ctx.cfg.burstDuplicates = true;
      await h.admin.post(`/api/admin/events/${event.id}/duplicates`).expect(200);
    } finally {
      h.ctx.face.scene = real;
      h.ctx.cfg.burstDuplicates = true;
    }
    const sharpOne = await byName('focus-b-sharp');
    expect(sharpOne.duplicate_of).toBeNull();
    expect((await byName('focus-a-blurred')).duplicate_of).toBe(sharpOne.id);
  });

  it("a student's new frame waiting for review never takes down an approved photo students can see", async () => {
    const e = await makeEvent(h, 'Crowd Burst', 'Crowd Burst', { crowd_uploads: true });
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);
    const p = phone(h, 'burst-student');
    const shot = await makePhoto(380, [{ person: PERSON.red }, { person: PERSON.cyan }], { w: 1600, h: 1200 });
    const first = (await p.upload(e.slug, await burstOf(shot, 1000)).expect(201)).body;
    await settle(h);
    await h.admin.patch('/api/admin/media').send({ ids: [first.id], action: 'approve' }).expect(200);
    const dupBits = h.ctx.cfg.dupBits;
    h.ctx.cfg.dupBits = 0; // the larger frame is not refused at upload as a near copy
    let second: any;
    try {
      second = (await p.upload(e.slug, shot).expect(201)).body; // larger: it would win on size
      expect(second.review).toBe('pending');
      await settle(h);
    } finally {
      h.ctx.cfg.dupBits = dupBits;
    }
    const row = async (id: string) => (await h.ctx.db.query<any>(`select duplicate_of from media where id = $1`, [id])).rows[0];
    expect((await row(first.id)).duplicate_of).toBeNull();
    expect((await row(second.id)).duplicate_of).toBe(first.id);
    const album = (await phone(h, 'viewer').get(`/api/e/${e.slug}/album`).expect(200)).body.photos.map((x: any) => x.id);
    expect(album).toEqual([first.id]);
  });

  it('every shown photo has its scene description in OneDrive (s/); a copy keeps no web copy', async () => {
    await settle(h);
    const rows = (await h.ctx.db.query<any>(`select id, status, duplicate_of, scene_key, web_key from media where event_id = $1`, [event.id])).rows;
    for (const m of rows) {
      if (m.duplicate_of === null && m.status === 'ready') {
        expect(m.scene_key).toMatch(/^od\/[^/]+\/.+\.bin$/);
        expect(fs.existsSync(copyPath(h, m.scene_key))).toBe(true);
      }
    }
    // the losers' web copies left the drive with them
    const files = copyFiles(h, event.id, 'w');
    const webs = rows.filter((m) => m.web_key).map((m) => m.web_key.split('/').pop());
    expect(files.sort()).toEqual(webs.sort());
    expect(copyFiles(h, event.id, 's').length).toBe(rows.filter((m) => m.scene_key).length);
  });

  it('a scene description deleted in OneDrive is made again from the original when it is next compared', async () => {
    const shown = (await h.ctx.db.query<any>(`select id, scene_key from media where event_id = $1 and status = 'ready' and duplicate_of is null and type = 'photo' order by created_at limit 1`, [event.id])).rows[0];
    fs.rmSync(copyPath(h, shown.scene_key));
    sceneCache.clear();
    await findBursts(h.ctx, event.id);
    await settle(h);
    const after = (await h.ctx.db.query<any>(`select scene_key from media where id = $1`, [shown.id])).rows[0];
    expect(after.scene_key).not.toBe(shown.scene_key);
    expect(fs.existsSync(copyPath(h, after.scene_key))).toBe(true);
  });
});
