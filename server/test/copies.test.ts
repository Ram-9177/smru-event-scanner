/**
 * The app's copies in OneDrive ("_app copies (do not edit)"): where they go and how they are named, that every write
 * is a new file, that nothing uploaded is left behind when a job fails, that the database queues every copy that
 * leaves it (copy_trash, by triggers), and that leftovers of a crash are swept after 2 hours.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DriveDownError } from '../src/drive/types.js';
import { COPIES_FOLDER, emptyCopyTrash, isDriveKey, itemOf, sweepOrphans } from '../src/media/copies.js';
import { remakeCopies } from '../src/media/process.js';
import { copyFiles, copyPath, expectNoLocalMedia, makeEvent, makeHarness, settle, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
const FOLDER = 'Copies Day';
const row = async (name: string) => (await h.ctx.db.query<any>(`select * from media where name = $1`, [name])).rows[0];
const trash = async () => (await h.ctx.db.query<{ drive_item_id: string; folder: boolean; tries: number }>(`select drive_item_id, folder, tries from copy_trash order by created_at`)).rows;

beforeAll(async () => {
  h = await makeHarness();
  event = await makeEvent(h, FOLDER, FOLDER);
  h.put(FOLDER, 'a.jpg', await makePhoto(700, [{ person: PERSON.red }]));
  h.put(FOLDER, 'b.jpg', await makePhoto(701, [{ person: PERSON.blue }]));
  await syncNow(h, event.id);
  await settle(h);
});
afterAll(async () => {
  await expectNoLocalMedia(h);
  await h.close();
});

describe('layout and names', () => {
  it('one folder in the app root, by event id and kind, with a README; every name is <media id>-<6 random>.<ext>', async () => {
    const root = path.join(h.driveDir, COPIES_FOLDER);
    expect(fs.readFileSync(path.join(root, 'README.txt'), 'utf8')).toContain('Deleting them only makes the app make them again');
    expect(fs.readdirSync(path.join(root, event.id)).sort()).toEqual(['s', 't', 'w']);
    const a = await row('a.jpg');
    for (const [kind, key, ext] of [['t', a.thumb_key, 'webp'], ['w', a.web_key, 'webp'], ['s', a.scene_key, 'bin']]) {
      expect(isDriveKey(key)).toBe(true);
      const name = key.split('/').pop();
      expect(name).toMatch(new RegExp(`^${a.id}-[0-9a-z]{6}\\.${ext}$`));
      expect(copyFiles(h, event.id, kind)).toContain(name);
    }
    const folders = (await h.ctx.db.query<any>(`select copies_folders from events where id = $1`, [event.id])).rows[0].copies_folders;
    expect(Object.keys(folders).sort()).toEqual(['event', 'root', 's', 't', 'w']);
    // the copies folder is never offered as an event folder
    const choices = (await h.admin.get('/api/admin/onedrive/folders').expect(200)).body.folders.map((f: any) => f.name);
    expect(choices).not.toContain(COPIES_FOLDER);
    expect((await h.admin.post('/api/admin/onedrive/folders').send({ name: COPIES_FOLDER }).expect(400)).body.error).toBe('reserved_name');
  });

  it('a remake writes new files under new names; the old ones are gone once it is on the row', async () => {
    const a = await row('a.jpg');
    expect(await remakeCopies(h.ctx, a.id)).toBe('ready');
    await settle(h);
    const b = await row('a.jpg');
    expect(b.thumb_key).not.toBe(a.thumb_key);
    expect(b.web_key).not.toBe(a.web_key);
    expect(fs.existsSync(copyPath(h, a.thumb_key))).toBe(false);
    expect(fs.existsSync(copyPath(h, a.web_key))).toBe(false);
    expect(fs.existsSync(copyPath(h, b.thumb_key))).toBe(true);
    expect(copyFiles(h, event.id, 't').filter((n) => n.startsWith(a.id))).toHaveLength(1);
    expect(await trash()).toEqual([]);
  });
});

describe('nothing is left behind', () => {
  it('a job that fails after its copies went up removes them again; the row is unchanged', async () => {
    h.put(FOLDER, 'c.jpg', await makePhoto(702, [{ person: PERSON.green }]));
    const real = h.ctx.face.faces;
    h.ctx.face.faces = async () => {
      throw new Error('the face step broke');
    };
    try {
      await syncNow(h, event.id);
    } finally {
      h.ctx.face.faces = real;
    }
    await settle(h);
    const c = await row('c.jpg');
    expect(c).toMatchObject({ status: 'failed', thumb_key: null, web_key: null });
    for (const k of ['t', 'w', 's']) expect(copyFiles(h, event.id, k).filter((n) => n.startsWith(c.id))).toEqual([]);
  });
});

describe('the database queues every copy that leaves it (copy_trash)', () => {
  it('a key replaced, set to null, or its row deleted: queued in the same transaction, then removed', async () => {
    const b = await row('b.jpg');
    // replaced (another row's copy is not touched)
    await h.ctx.db.query(`update media set thumb_key = $2 where id = $1`, [b.id, `od/fake-1/${b.id}-zzzzzz.webp`]);
    expect((await trash()).map((t) => t.drive_item_id)).toEqual([itemOf(b.thumb_key)]);
    // a key kept in another column of the row is not queued
    await h.ctx.db.query(`update media set scene_key = web_key where id = $1`, [b.id]);
    expect((await trash()).map((t) => t.drive_item_id)).toEqual([itemOf(b.thumb_key), itemOf(b.scene_key)]);
    await h.ctx.db.query(`update media set scene_key = null where id = $1`, [b.id]);
    expect((await trash()).map((t) => t.drive_item_id)).toEqual([itemOf(b.thumb_key), itemOf(b.scene_key)]); // web still holds it
    // the row deleted
    await h.ctx.db.query(`delete from faces where media_id = $1`, [b.id]);
    await h.ctx.db.query(`delete from media where id = $1`, [b.id]);
    expect((await trash()).map((t) => t.drive_item_id).sort()).toEqual([itemOf(b.thumb_key), itemOf(b.scene_key), itemOf(b.web_key), 'fake-1'].sort());
    await emptyCopyTrash(h.ctx);
    expect(await trash()).toEqual([]);
    for (const k of [b.thumb_key, b.web_key, b.scene_key]) expect(fs.existsSync(copyPath(h, k))).toBe(false);
  });

  it('OneDrive down: the rows stay (no try counted: an outage is not the item failing) and go at the next pass', async () => {
    const a = await row('a.jpg');
    await h.ctx.db.query(`update media set scene_key = null where id = $1`, [a.id]);
    const real = h.ctx.drive.remove;
    h.ctx.drive.remove = async () => {
      throw new DriveDownError();
    };
    try {
      await emptyCopyTrash(h.ctx);
    } finally {
      h.ctx.drive.remove = real;
    }
    expect(await trash()).toEqual([{ drive_item_id: itemOf(a.scene_key), folder: false, tries: 0 }]);
    expect(fs.existsSync(copyPath(h, a.scene_key))).toBe(true);
    await emptyCopyTrash(h.ctx);
    expect(await trash()).toEqual([]);
    expect(fs.existsSync(copyPath(h, a.scene_key))).toBe(false);
  });

  it('a row that failed 20 times is left out of the quick passes, but the 10-minute pass (all) still deletes it', async () => {
    const a = await row('a.jpg');
    await h.ctx.db.query(`update media set web_key = null where id = $1`, [a.id]);
    await h.ctx.db.query(`update copy_trash set tries = 25`);
    expect(await emptyCopyTrash(h.ctx)).toBe(0);
    expect(fs.existsSync(copyPath(h, a.web_key))).toBe(true);
    expect(await emptyCopyTrash(h.ctx, { all: true })).toBe(1);
    expect(await trash()).toEqual([]);
    expect(fs.existsSync(copyPath(h, a.web_key))).toBe(false);
  });

  it('an event deleted: its whole copies folder goes in one call, and the rows of its single copies with it', async () => {
    const e2 = await makeEvent(h, 'Gone Soon', 'Gone Soon');
    h.put('Gone Soon', 'x.jpg', await makePhoto(710, [{ person: PERSON.red }]));
    await syncNow(h, e2.id);
    await settle(h);
    const folder = (await h.ctx.db.query<any>(`select copies_folders from events where id = $1`, [e2.id])).rows[0].copies_folders.event;
    const removed: string[] = [];
    const real = h.ctx.drive.remove.bind(h.ctx.drive);
    h.ctx.drive.remove = async (id: string, o?: any) => (removed.push(id), real(id, o));
    try {
      await h.admin.delete(`/api/admin/events/${e2.id}`).expect(200);
      expect((await trash()).find((t) => t.folder)?.drive_item_id).toBe(folder);
      await settle(h);
    } finally {
      h.ctx.drive.remove = real;
    }
    expect(removed).toEqual([folder]);
    expect(fs.existsSync(path.join(h.driveDir, COPIES_FOLDER, e2.id))).toBe(false);
    expect(await trash()).toEqual([]);
  });
});

describe('leftovers of a crash', () => {
  it('a file no row points at goes after 2 hours; a fresh one stays', async () => {
    const dir = path.join(h.driveDir, COPIES_FOLDER, event.id, 't');
    const old = path.join(dir, 'crash-old.webp');
    const fresh = path.join(dir, 'crash-fresh.webp');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'y');
    const past = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(old, past, past);
    expect(await sweepOrphans(h.ctx, event.id)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    // every copy the rows point at is still there
    for (const r of (await h.ctx.db.query<any>(`select thumb_key, web_key from media where event_id = $1 and thumb_key is not null`, [event.id])).rows) {
      expect(fs.existsSync(copyPath(h, r.thumb_key))).toBe(true);
    }
    fs.rmSync(fresh);
  });
});
