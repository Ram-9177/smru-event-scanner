/**
 * The People folders stay in step with what is shown, in the cases that used to leave stale or lost copies:
 *   - Hide on a copy, an approved report, your original taking over from a student's photo
 *   - an event deleted, an item removed while OneDrive cannot remove its copies, an item removed during a copy
 *   - someone far in the background, an archived event, a missing original, a changed original, a person added again
 * And event folders: an event never takes over a campus's folder or People, and a campus's event can be linked again.
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DriveDownError } from '../src/drive/index.js';
import { emptyPeopleTrash, KIND_FOLDER, reconcile, removePeopleCopies, whoIsIn } from '../src/people/filing.js';
import { expectNoLocalMedia, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness({ uploadsPerPhone: 50 });
});
afterAll(() => h.close());
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

const RED = ['People', 'Dr. K. Red - Chairman'];
const files = (...parts: string[]) => {
  const dir = path.join(h.driveDir, ...parts);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort() : [];
};
const all = (...person: string[]) => (['solo', 'duo', 'group'] as const).flatMap((k) => files(...person, KIND_FOLDER[k]).map((f) => `${KIND_FOLDER[k]}/${f}`));
const mediaId = async (eventId: string, name: string) => (await h.ctx.db.query<{ id: string }>(`select id from media where event_id = $1 and name = $2`, [eventId, name])).rows[0].id;
const trash = async () => (await h.ctx.db.query(`select drive_item_id from people_trash`)).rows.length;

describe('who is in a photo', () => {
  const v = (i: number) => {
    const a = new Float32Array(4);
    a[i] = 1;
    return a;
  };
  it('someone far in the background of a portrait is in it as a Group photo, not as its Solo subject', () => {
    const refs = [
      { person_id: 'front', vector: v(0) },
      { person_id: 'back', vector: v(1) },
    ];
    const got = whoIsIn(
      [
        { vector: v(0), w: 400 },
        { vector: v(1), w: 60 },
      ],
      refs,
    );
    expect(got.get('front')?.kind).toBe('solo');
    expect(got.get('back')?.kind).toBe('group');
  });
});

describe('People folders follow what is shown', () => {
  let gala: any;
  let red: any;

  beforeAll(async () => {
    gala = (await h.admin.post('/api/admin/events').send({ title: 'Gala' }).expect(201)).body.event;
    h.put('Gala', 'solo.jpg', await makePhoto(601, [{ person: PERSON.red }]));
    h.put('Gala', 'duo.jpg', await makePhoto(602, [{ person: PERSON.red }, { person: PERSON.blue }]));
    h.put('Gala', 'portrait.jpg', await makePhoto(603, [{ person: PERSON.blue, size: 200 }, { person: PERSON.red, size: 40 }]));
    h.put('Gala', 'reported.jpg', await makePhoto(604, [{ person: PERSON.red }]));
    await syncNow(h, gala.id);
    await settle(h);
    red = (await h.admin.post('/api/admin/people').send({ name: 'Dr. K. Red', role: 'Chairman' }).expect(201)).body.person;
    await h.admin.post(`/api/admin/people/${red.id}/photos`).set('content-type', 'image/jpeg').send(await makeSelfie(PERSON.red)).expect(201);
    await settle(h);
  });

  it("a person small in the background of someone else's portrait is filed under Group", () => {
    expect(files(...RED, 'Solo')).toEqual(['Gala - reported.jpg', 'Gala - solo.jpg']);
    expect(files(...RED, 'Group')).toEqual(['Gala - portrait.jpg']);
  });

  it('Hide on a photo marked as a copy takes the photo shown in its place out of the folder, and Unhide brings it back', async () => {
    const keeper = await mediaId(gala.id, 'duo.jpg');
    const copy = (
      await h.ctx.db.query<{ id: string }>(
        `insert into media (event_id, type, status, name, source, review, duplicate_of) values ($1, 'photo', 'ready', 'duo-copy.jpg', 'onedrive', 'approved', $2) returning id`,
        [gala.id, keeper],
      )
    ).rows[0].id;
    await h.admin.patch('/api/admin/media').send({ ids: [copy], action: 'hide' }).expect(200);
    expect(files(...RED, 'Duo')).toEqual([]);
    await h.admin.patch('/api/admin/media').send({ ids: [copy], action: 'unhide' }).expect(200);
    expect(files(...RED, 'Duo')).toEqual(['Gala - duo.jpg']);
  });

  it('an approved report takes the photo out of the folder', async () => {
    const id = await mediaId(gala.id, 'reported.jpg');
    const q = (await h.ctx.db.query<{ id: string }>(`insert into requests (event_id, media_id, kind) values ($1, $2, 'report') returning id`, [gala.id, id])).rows[0];
    await h.admin.patch(`/api/admin/requests/${q.id}`).send({ status: 'approved' }).expect(200);
    expect(files(...RED, 'Solo')).toEqual(['Gala - solo.jpg']);
  });

  it("your original arriving after a student's copy of it: the student's photo leaves the folder, nothing is there twice", async () => {
    await h.admin.patch(`/api/admin/events/${gala.id}`).send({ status: 'live' }).expect(200);
    const picture = await makePhoto(610, [{ person: PERSON.red }]);
    await phone(h, 'guest').upload(gala.slug, picture, 'image/jpeg', 'A visitor').expect(201);
    await settle(h);
    const waiting = (await h.admin.get(`/api/admin/events/${gala.id}/media?filter=review`).expect(200)).body.media;
    await h.admin.patch('/api/admin/media').send({ ids: [waiting[0].id], action: 'approve' }).expect(200);
    expect(files(...RED, 'Solo')).toHaveLength(2);
    h.put('Gala', 'original.jpg', picture);
    await syncNow(h, gala.id);
    await settle(h);
    expect(files(...RED, 'Solo')).toEqual(['Gala - original.jpg', 'Gala - solo.jpg']);
  });

  it('a changed original is copied again: the folder holds the new version, once', async () => {
    const edited = await makePhoto(620, [{ person: PERSON.red }], { w: 900 });
    h.put('Gala', 'solo.jpg', edited);
    await syncNow(h, gala.id);
    await settle(h);
    expect(files(...RED, 'Solo')).toEqual(['Gala - original.jpg', 'Gala - solo.jpg']);
    expect(fs.readFileSync(path.join(h.driveDir, ...RED, 'Solo', 'Gala - solo.jpg'))).toEqual(edited);
    expect((await h.admin.post(`/api/admin/people/${red.id}/refile`).expect(200)).body).toMatchObject({ filed: 0, removed: 0 });
  });

  it('an item removed while OneDrive cannot remove its copies: the copies are remembered and removed later', async () => {
    const id = await mediaId(gala.id, 'duo.jpg');
    const remove = h.ctx.drive.remove.bind(h.ctx.drive);
    h.ctx.drive.remove = async () => {
      throw new DriveDownError();
    };
    try {
      await removePeopleCopies(h.ctx, id);
    } finally {
      h.ctx.drive.remove = remove;
    }
    expect((await h.ctx.db.query(`select 1 from person_media where media_id = $1`, [id])).rows).toHaveLength(0);
    expect(await trash()).toBe(1);
    expect(files(...RED, 'Duo')).toEqual(['Gala - duo.jpg']);
    expect(await emptyPeopleTrash(h.ctx)).toBe(1);
    expect(await trash()).toBe(0);
    expect(files(...RED, 'Duo')).toEqual([]);
    await reconcile(h.ctx, [id]); // still shown: filed again
    expect(files(...RED, 'Duo')).toEqual(['Gala - duo.jpg']);
  });

  it('an item removed while it is being copied leaves no copy behind', async () => {
    h.put('Gala', 'late.jpg', await makePhoto(630, [{ person: PERSON.red }]));
    const copy = h.ctx.drive.copy.bind(h.ctx.drive);
    let hit = 0;
    h.ctx.drive.copy = async (itemId, parentId, name) => {
      if (name === 'Gala - late.jpg') {
        hit++;
        await h.ctx.db.query(`delete from media where name = 'late.jpg'`); // the sync removes it meanwhile
      }
      return copy(itemId, parentId, name);
    };
    try {
      await syncNow(h, gala.id);
      await settle(h);
    } finally {
      h.ctx.drive.copy = copy;
    }
    expect(hit).toBe(1);
    expect(files(...RED, 'Solo')).not.toContain('Gala - late.jpg');
    expect(await trash()).toBe(0);
  });

  it('deleting an event takes its copies out of the People folders', async () => {
    const ev = (await h.admin.post('/api/admin/events').send({ title: 'Farewell' }).expect(201)).body.event;
    h.put('Farewell', 'bye.jpg', await makePhoto(640, [{ person: PERSON.red }]));
    await syncNow(h, ev.id);
    await settle(h);
    expect(files(...RED, 'Solo')).toContain('Farewell - bye.jpg');
    await h.admin.delete(`/api/admin/events/${ev.id}`).expect(200);
    await settle(h);
    expect(files(...RED, 'Solo')).not.toContain('Farewell - bye.jpg');
    expect(await trash()).toBe(0);
    expect(fs.existsSync(path.join(h.driveDir, 'Farewell', 'bye.jpg'))).toBe(true); // the original stays
  });

  it("an archived event's copies stay when the person is filed again; a hidden one still leaves", async () => {
    const ev = (await h.admin.post('/api/admin/events').send({ title: 'Old Fest' }).expect(201)).body.event;
    h.put('Old Fest', 'a.jpg', await makePhoto(650, [{ person: PERSON.red }]));
    h.put('Old Fest', 'b.jpg', await makePhoto(651, [{ person: PERSON.red }]));
    await syncNow(h, ev.id);
    await settle(h);
    await h.admin.patch(`/api/admin/events/${ev.id}`).send({ status: 'archived' }).expect(200);
    await h.admin.post(`/api/admin/people/${red.id}/refile`).expect(200);
    expect(files(...RED, 'Solo').filter((f) => f.startsWith('Old Fest'))).toEqual(['Old Fest - a.jpg', 'Old Fest - b.jpg']);
    await h.admin.patch('/api/admin/media').send({ ids: [await mediaId(ev.id, 'a.jpg')], action: 'hide' }).expect(200);
    expect(files(...RED, 'Solo').filter((f) => f.startsWith('Old Fest'))).toEqual(['Old Fest - b.jpg']);
  });

  it('a photo whose original is gone from OneDrive does not stop the others from being filed', async () => {
    const ev = (await h.admin.post('/api/admin/events').send({ title: 'Lost' }).expect(201)).body.event;
    h.put('Lost', 'a.jpg', await makePhoto(660, [{ person: PERSON.green }]));
    h.put('Lost', 'b.jpg', await makePhoto(661, [{ person: PERSON.green }]));
    await syncNow(h, ev.id);
    await settle(h);
    fs.rmSync(path.join(h.driveDir, 'Lost', 'a.jpg')); // moved away in OneDrive; no sync since
    const green = (await h.admin.post('/api/admin/people').send({ name: 'Ms. Green', role: 'COO' }).expect(201)).body.person;
    await h.admin.post(`/api/admin/people/${green.id}/photos`).set('content-type', 'image/jpeg').send(await makeSelfie(PERSON.green)).expect(201);
    await settle(h);
    expect(files('People', 'Ms. Green - COO', 'Solo')).toEqual(['Lost - b.jpg']);
    const kinds = (await h.ctx.db.knex('people').where({ id: green.id }).first()).drive_kind_folders;
    await h.admin.post(`/api/admin/people/${green.id}/refile`).expect(200);
    expect((await h.ctx.db.knex('people').where({ id: green.id }).first()).drive_kind_folders).toEqual(kinds);
  });

  it('a person removed and added again gets their folder back without a second copy of anything', async () => {
    const before = all(...RED);
    expect(before.length).toBeGreaterThan(3);
    await h.admin.delete(`/api/admin/people/${red.id}`).expect(200);
    red = (await h.admin.post('/api/admin/people').send({ name: 'Dr. K. Red', role: 'Chairman' }).expect(201)).body.person;
    await h.admin.post(`/api/admin/people/${red.id}/photos`).set('content-type', 'image/jpeg').send(await makeSelfie(PERSON.red)).expect(201);
    await settle(h);
    expect(all(...RED)).toEqual(before);
    const p = (await h.admin.get(`/api/admin/people/${red.id}`).expect(200)).body.person;
    expect(p.counts.solo + p.counts.duo + p.counts.group).toBe(before.filter((f) => !f.includes('Old Fest')).length);
  });
});

describe('event and campus folders', () => {
  let hyd: any;
  let annual: any;

  it("an event never takes over a campus's folder or the People folder", async () => {
    hyd = (await request(h.app).get('/api/campuses').expect(200)).body.campuses.find((c: any) => c.slug === 'hyderabad');
    annual = (await h.admin.post('/api/admin/events').send({ title: 'Annual Day', starts_on: '2026-11-20', campus_id: hyd.id }).expect(201)).body.event;
    expect(annual.folder.name).toBe('2026-11-20 Annual Day');
    const same = (await h.admin.post('/api/admin/events').send({ title: 'Hyderabad' }).expect(201)).body.event;
    expect(same.folder.name).toBe('Hyderabad (2)');
    const people = (await h.admin.post('/api/admin/events').send({ title: 'People' }).expect(201)).body.event;
    expect(people.folder.name).toBe('People (2)');
  });

  it("a new campus never takes over an event's folder", async () => {
    const expo = (await h.admin.post('/api/admin/events').send({ title: 'Vizag' }).expect(201)).body.event;
    expect(expo.folder.name).toBe('Vizag');
    const campus = (await h.admin.post('/api/admin/campuses').send({ name: 'Vizag' }).expect(201)).body.campus;
    const ev = (await h.admin.post('/api/admin/events').send({ title: 'Sports Day', starts_on: '2026-12-01', campus_id: campus.id }).expect(201)).body.event;
    expect(fs.existsSync(path.join(h.driveDir, 'Vizag (2)', '2026-12-01 Sports Day'))).toBe(true);
    expect(ev.folder.name).toBe('2026-12-01 Sports Day');
  });

  it("renaming a campus renames its folder", async () => {
    const campus = (await request(h.app).get('/api/campuses').expect(200)).body.campuses.find((c: any) => c.name === 'Vizag');
    await h.admin.patch(`/api/admin/campuses/${campus.id}`).send({ name: 'Visakhapatnam' }).expect(200);
    expect(fs.existsSync(path.join(h.driveDir, 'Visakhapatnam', '2026-12-01 Sports Day'))).toBe(true);
    expect(fs.existsSync(path.join(h.driveDir, 'Vizag (2)'))).toBe(false);
    expect(fs.existsSync(path.join(h.driveDir, 'Vizag'))).toBe(true); // the event's folder of that name is left alone
  });

  it("an event of a campus can be linked to its folder again; a campus's own folder and People are not offered", async () => {
    await h.admin.patch(`/api/admin/events/${annual.id}`).send({ onedrive_folder_id: null }).expect(200);
    const folders = (await h.admin.get('/api/admin/onedrive/folders').expect(200)).body.folders;
    const names = folders.map((f: any) => f.name);
    expect(names).not.toContain('Hyderabad');
    expect(names).not.toContain('People');
    const mine = folders.find((f: any) => f.name === 'Hyderabad › 2026-11-20 Annual Day');
    expect(mine).toMatchObject({ campus: 'Hyderabad', used_by: null });
    const linked = (await h.admin.patch(`/api/admin/events/${annual.id}`).send({ onedrive_folder_id: mine.id }).expect(200)).body.event;
    expect(linked.folder).toEqual({ id: mine.id, name: '2026-11-20 Annual Day' });
    const campusFolder = (await h.ctx.db.knex('campuses').where({ id: hyd.id }).first()).drive_folder_id;
    expect((await h.admin.patch(`/api/admin/events/${annual.id}`).send({ onedrive_folder_id: campusFolder }).expect(400)).body.error).toBe('no_such_folder');
  });
});
