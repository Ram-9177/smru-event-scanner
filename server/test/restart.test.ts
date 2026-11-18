/**
 * After a restart: uploads that were cut off before their file reached the drive are cleaned up, even when another
 * photo was already marked a copy of them, and the server always starts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { recoverInterruptedUploads } from '../src/media/upload.js';
import { makeHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let eventId: string;
beforeAll(async () => {
  h = await makeHarness();
  eventId = (await h.admin.post('/api/admin/events').send({ title: 'Restart' }).expect(201)).body.event.id;
});
afterAll(() => h.close());

const add = async (fields: Record<string, unknown>) =>
  (await h.ctx.db.knex('media').insert({ event_id: eventId, type: 'photo', name: 'x.jpg', ...fields }).returning('id'))[0].id as string;

it('a cut-off upload that a synced copy points at hands over to the copy, and the server starts', async () => {
  const stuck = await add({ status: 'processing', source: 'onedrive', onedrive_item_id: null });
  const copy = await add({ status: 'ready', source: 'onedrive', onedrive_item_id: 'item-1', duplicate_of: stuck, web_key: null });
  const rejected = await add({ status: 'processing', source: 'crowd', onedrive_item_id: null, review: 'rejected' });
  const r = await recoverInterruptedUploads(h.ctx.db);
  expect(r.removed).toBe(1);
  expect(await h.ctx.db.knex('media').where({ id: stuck }).first()).toBeUndefined();
  const heir = await h.ctx.db.knex('media').where({ id: copy }).first();
  expect(heir.duplicate_of).toBeNull();
  expect(heir.status).toBe('found'); // it had no display copy as a copy: it is processed again and then shown
  // a rejected upload keeps its row (and so its fingerprints), so the same picture is still refused next time
  expect(await h.ctx.db.knex('media').where({ id: rejected }).first()).toBeTruthy();
});

it('removes what a stopped server left in data/tmp, the copies job\'s temp files too, and never anything else', async () => {
  const { cleanTempDir, sweepTempDir, tempPath } = await import('../src/media/files.js');
  const fs = await import('node:fs');
  const left = ['upload-1', 'zip-2', 'orig-3', 'rebuild-4-x.video', 'clean-5', 'full-6', 'copy-7.part', 'abc.clean.mp4', 'x.preview.mp4', 'y.again'];
  for (const n of left) fs.writeFileSync(tempPath(h.ctx.cfg, n), 'x');
  fs.writeFileSync(tempPath(h.ctx.cfg, 'adopt-9'), 'a command-line tool at work');
  expect(sweepTempDir(h.ctx.cfg)).toBe(0); // the hourly sweep: only files older than 6 hours
  // 7 hours old: the hourly sweep takes only what one request left (Download all, Save original, a render, a copy on
  // its way up). An upload waiting in the video line, a video being processed or rebuilt, its preview: still in use.
  const old = new Date(Date.now() - 7 * 60 * 60_000);
  for (const n of [...left, 'adopt-9']) fs.utimesSync(tempPath(h.ctx.cfg, n), old, old);
  expect(sweepTempDir(h.ctx.cfg)).toBe(5);
  for (const n of ['upload-1', 'rebuild-4-x.video', 'abc.clean.mp4', 'x.preview.mp4', 'y.again']) expect(fs.existsSync(tempPath(h.ctx.cfg, n))).toBe(true);
  expect(cleanTempDir(h.ctx.cfg, new Date(Date.now() + 1000))).toBe(left.length - 5); // at start: all of them
  expect(fs.readdirSync((await import('node:path')).dirname(tempPath(h.ctx.cfg, 'x')))).toEqual(['adopt-9']);
  fs.rmSync(tempPath(h.ctx.cfg, 'adopt-9'));
});
