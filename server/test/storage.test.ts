/**
 * Settings > Storage (feature D): the disk holding server/data and what the app itself uses, for super admins; and
 * organisers' uploads refused (507 disk_full) while the disk has less than UPLOAD_MIN_FREE_GB free.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRoomForUploads, setDiskProbe } from '../src/ops/disk.js';
import { makeHarness, settle, type Harness } from './helpers/harness.js';
import { makePhoto, PERSON } from './helpers/photos.js';

const GB = 1024 ** 3;
let h: Harness;
let backupDir: string;
let organiser: ReturnType<typeof request.agent>;
let free = 120 * GB;

const put = (rel: string, bytes: number) => {
  const abs = path.join(h.ctx.cfg.dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(bytes));
};

beforeAll(async () => {
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-storage-backups-'));
  h = await makeHarness({ backupDir });
  setDiskProbe(async () => ({ free, total: 500 * GB }));
  await h.admin.post('/api/admin/team').send({ email: 'helper@college.test', password: 'another-long-password', role: 'organiser' }).expect(201);
  organiser = request.agent(h.app);
  await organiser.post('/api/admin/login').send({ email: 'helper@college.test', password: 'another-long-password' }).expect(200);
});
afterAll(async () => {
  setDiskProbe(null);
  await h.close();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

describe('GET /api/admin/storage', () => {
  it('shows this Mac (database, backups, temp files, old copies still here) and OneDrive (its space and the app\'s copies)', async () => {
    put('media/ev1/a.t.jpg', 1000); // copies an older version kept on this Mac (until the copies job moves them)
    put('media/ev1/deeper/a.w.jpg', 2000);
    put('full/abc.jpg', 5000);
    put('tmp/upload-1', 300);
    fs.writeFileSync(path.join(backupDir, 'event_photos-2026-11-17-0930.dump'), Buffer.alloc(7000));

    const r = (await h.admin.get('/api/admin/storage').expect(200)).body;
    expect(r.disk).toEqual({ path: h.ctx.cfg.dataDir, free: 120 * GB, total: 500 * GB });
    expect(r.server).toMatchObject({ temp: 300, legacy_copies: 8000, backups: 7000 });
    expect(r.server.database).toBeGreaterThan(0);
    expect(r.onedrive).toMatchObject({ connected: true, quota: null });
    expect(r.copies).toEqual({ waiting: 0, lost: 0, running: false, last_error: null, local_done: false });
    expect(r).toMatchObject({ min_free_upload: 1 * GB, warn_below: 5 * GB, critical_below: 2 * GB, backups_on: true });
    fs.rmSync(path.join(h.ctx.cfg.dataDir, 'media'), { recursive: true });
    fs.rmSync(path.join(h.ctx.cfg.dataDir, 'full'), { recursive: true });
    fs.rmSync(path.join(h.ctx.cfg.dataDir, 'tmp', 'upload-1'));
  });

  it('says when backups are off', async () => {
    h.ctx.cfg.backupDir = '';
    try {
      const r = (await h.admin.get('/api/admin/storage').expect(200)).body;
      expect(r.backups_on).toBe(false);
      expect(r.server.backups).toBe(0);
    } finally {
      h.ctx.cfg.backupDir = backupDir;
    }
  });

  it('is for super admins only', async () => {
    expect((await organiser.get('/api/admin/storage').expect(403)).body.error).toBe('super_admin_only');
    await request(h.app).get('/api/admin/storage').expect(401);
  });
});

describe('organiser uploads when the disk is nearly full', () => {
  let event: any;
  const send = (agent: ReturnType<typeof request.agent>, data: Buffer) =>
    agent.post(`/api/admin/events/${event.id}/photos`).set('content-type', 'image/jpeg').set('x-file-name', 'IMG_0001.JPG').send(data);
  const mediaRows = async () => (await h.ctx.db.query<{ n: number }>(`select count(*)::int as n from media where event_id = $1`, [event.id])).rows[0].n;

  beforeAll(async () => {
    event = (await h.admin.post('/api/admin/events').send({ title: 'Sports Day', starts_on: '2026-12-01' }).expect(201)).body.event;
  });

  it('are refused below 1 GB free for temporary files, before the photo is read, with a plain reason', async () => {
    free = 0.8 * GB;
    const photo = await makePhoto(21, [{ person: PERSON.red }]);
    for (const agent of [h.admin, organiser]) {
      const res = await send(agent, photo).expect(507);
      expect(res.body).toEqual({
        error: 'disk_full',
        message: 'This Mac has less than 1 GB free for temporary files, so uploads are paused. Photos and videos are kept in OneDrive; free some space on the Mac (Settings, Storage).',
      });
    }
    expect(await mediaRows()).toBe(0);
    expect(fs.readdirSync(path.join(h.driveDir, event.folder.name))).toEqual([]);
  });

  it('say the limit that is set (TEMP_MIN_FREE_GB)', async () => {
    h.ctx.cfg.uploadMinFreeBytes = 5 * GB;
    try {
      free = 4 * GB;
      expect((await send(h.admin, await makePhoto(22)).expect(507)).body.message).toBe(
        'This Mac has less than 5 GB free for temporary files, so uploads are paused. Photos and videos are kept in OneDrive; free some space on the Mac (Settings, Storage).',
      );
    } finally {
      h.ctx.cfg.uploadMinFreeBytes = 1 * GB;
    }
  });

  it('a video needs room for about 2.3 times its size on top: one that does not fit is refused, a photo still goes', async () => {
    free = 1.5 * GB;
    await expect(assertRoomForUploads(h.ctx.cfg, 'organiser', { video: true, bytes: 300 * 1024 * 1024 })).rejects.toMatchObject({
      status: 507,
      message: expect.stringMatching(/^This Mac has less than 1\.7 GB free for temporary files/),
    });
    await expect(assertRoomForUploads(h.ctx.cfg, 'organiser', { video: true, bytes: 100 * 1024 * 1024 })).resolves.toBeUndefined();
    await expect(assertRoomForUploads(h.ctx.cfg, 'student')).resolves.toBeUndefined();
  });

  it('go ahead again once there is room', async () => {
    free = 1.5 * GB; // photos are handled in memory: 1 GB free for temp files is enough
    expect((await send(h.admin, await makePhoto(23, [{ person: PERSON.blue }])).expect(201)).body.result).toBe('added');
    await settle(h);
    expect(await mediaRows()).toBe(1);
  });
});
