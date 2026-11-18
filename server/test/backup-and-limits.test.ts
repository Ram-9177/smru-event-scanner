/**
 * Automatic database backups (backup.ts), deleting an event (super admins only), and the selfie limit per network
 * address that holds when a script makes itself a new phone for every try.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupName, backupNow, backupStatus, findPgDump, pgEnv, pruneBackups } from '../src/backup.js';
import { networkOf } from '../src/routes/public.js';
import { makeEvent, makeHarness, phone, syncNow, type Harness } from './helpers/harness.js';
import { TEST_DATABASE_URL } from './helpers/db.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
const FOLDER = 'Sports Day';
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-backups-'));

beforeAll(async () => {
  h = await makeHarness({ searchesPerIp10Min: 3, searchesPer10Min: 50, searchesPerDay: 50, backupDir });
  event = await makeEvent(h, 'Sports Day 2026', FOLDER);
  h.put(FOLDER, 'p1 red.jpg', await makePhoto(1, [{ person: PERSON.red }]));
  await syncNow(h, event.id);
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
});
afterAll(async () => {
  await h.close();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

describe('automatic database backups', () => {
  it('dumps the database into the folder under a whole name and keeps only the newest of its own', async (t) => {
    const major = Math.floor(Number((await h.ctx.db.query<{ v: string }>(`select current_setting('server_version_num') as v`)).rows[0].v) / 10000);
    const pgDump = await findPgDump({ pgDumpPath: process.env.PG_DUMP || '' }, major);
    if (!pgDump) return t.skip();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-backup-'));
    try {
      // Older dumps of this job, a half-written one a stopped server left, and files that are not the job's.
      for (const d of ['01', '02', '03', '04']) fs.writeFileSync(path.join(dir, `event_photos-2020-01-${d}-0300.dump`), 'old');
      fs.writeFileSync(path.join(dir, '.event_photos-2020-01-05-0300.dump.part'), 'half');
      fs.writeFileSync(path.join(dir, 'event_photos-before-005.sql'), 'mine');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
      const schema = (await h.ctx.db.query<{ s: string }>(`select current_schema() as s`)).rows[0].s;
      const cfg = { databaseUrl: TEST_DATABASE_URL, backupDir: dir, backupKeep: 3, pgDumpPath: pgDump };

      const [made, second] = await Promise.all([backupNow(cfg, pgDump, { schema }), backupNow(cfg, pgDump, { schema })]);
      expect(second).toBeNull(); // never two at once
      expect(path.basename(made!)).toMatch(/^event_photos-\d{4}-\d{2}-\d{2}-\d{4}\.dump$/);
      expect(fs.readFileSync(made!).subarray(0, 5).toString()).toBe('PGDMP'); // pg_dump's custom format
      expect(fs.statSync(made!).mode & 0o777).toBe(0o600); // personal data: for this server's user only
      expect(fs.readdirSync(dir).sort()).toEqual([path.basename(made!), 'event_photos-2020-01-03-0300.dump', 'event_photos-2020-01-04-0300.dump', 'event_photos-before-005.sql', 'notes.txt'].sort());

      // A failed dump leaves nothing behind.
      await expect(backupNow({ ...cfg, databaseUrl: TEST_DATABASE_URL.replace(/\/[^/]+$/, '/no_such_database_here') }, pgDump)).rejects.toThrow();
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
      expect(fs.readdirSync(dir)).toHaveLength(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the newest ones and never removes a file it did not make', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-prune-'));
    try {
      for (const n of ['event_photos-2026-11-01-0900.dump', 'event_photos-2026-11-03-0900.dump', 'event_photos-2026-11-02-0900.dump', 'other-2026-01-01-0000.dump']) fs.writeFileSync(path.join(dir, n), 'x');
      expect(pruneBackups(dir, 1).sort()).toEqual(['event_photos-2026-11-01-0900.dump', 'event_photos-2026-11-02-0900.dump']);
      expect(fs.readdirSync(dir).sort()).toEqual(['event_photos-2026-11-03-0900.dump', 'other-2026-01-01-0000.dump']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives pg_dump the connection through its environment, never the password on its command line', () => {
    expect(pgEnv('postgres://photos:s%40cret@db.college.test:5433/event_photos?sslmode=require')).toEqual({
      PGHOST: 'db.college.test',
      PGPORT: '5433',
      PGUSER: 'photos',
      PGPASSWORD: 's@cret',
      PGDATABASE: 'event_photos',
      PGSSLMODE: 'require',
    });
    expect(pgEnv('postgres://localhost/event_photos')).toEqual({ PGHOST: 'localhost', PGDATABASE: 'event_photos' });
  });

  it('shows the backup folder to super admins only', async () => {
    expect((await h.admin.get('/api/admin/onedrive/status').expect(200)).body.backup).toEqual({ dir: backupDir, last_at: null, last_error: null });
    const at = new Date('2026-11-16T21:30:00Z');
    fs.writeFileSync(path.join(backupDir, backupName(at)), 'x');
    fs.utimesSync(path.join(backupDir, backupName(at)), at, at);
    expect((await h.admin.get('/api/admin/onedrive/status').expect(200)).body.backup.last_at).toBe(at.toISOString());
    expect(backupStatus({ backupDir: '' })).toEqual({ dir: null, last_at: null, last_error: null }); // BACKUP_DIR=off
  });
});

describe('deleting an event', () => {
  const ORGANISER = { email: 'ravi@college.test', password: 'an-organiser-password' };

  it('is for super admins only: an organiser can archive, not delete', async () => {
    await h.admin.post('/api/admin/team').send(ORGANISER).expect(201);
    const ravi = request.agent(h.app);
    await ravi.post('/api/admin/login').send(ORGANISER).expect(200);
    const doomed = (await ravi.post('/api/admin/events').send({ title: 'Mock Drill' }).expect(201)).body.event;
    expect((await ravi.delete(`/api/admin/events/${doomed.id}`).expect(403)).body.error).toBe('super_admin_only');
    await ravi.get(`/api/admin/events/${doomed.id}`).expect(200); // still there
    expect((await ravi.get('/api/admin/onedrive/status').expect(200)).body.backup).toBeUndefined();
    await h.admin.delete(`/api/admin/events/${doomed.id}`).expect(200);
    await h.admin.get(`/api/admin/events/${doomed.id}`).expect(404);
  });
});

describe('selfie searches per network address', () => {
  let selfie: Buffer;
  const from = (name: string, ip?: string) => {
    const r = phone(h, name).selfie(event.slug, selfie);
    return ip ? r.set('x-forwarded-for', ip) : r;
  };

  it('holds back a script that makes a new phone for every try, and no one else', async () => {
    selfie = await makeSelfie(PERSON.red);
    for (let i = 0; i < 3; i++) await from(`script-${i}`, '203.0.113.7').expect(200);
    const over = await from('script-3', '203.0.113.7').expect(429);
    expect(over.body).toMatchObject({ error: 'slow_down', message: expect.stringMatching(/this network/) });
    await from('other-network', '198.51.100.2').expect(200);
    // Through a tunnel on this computer that does not pass the visitor's address on, everyone is 127.0.0.1: not counted.
    for (let i = 0; i < 4; i++) await from(`local-${i}`).expect(200);
  });

  it('counts the visitor, not a tunnel or proxy on this computer', () => {
    expect(networkOf('::ffff:127.0.0.1', 'loopback')).toBeNull();
    expect(networkOf('::1', 'loopback')).toBeNull();
    expect(networkOf('::ffff:203.0.113.7', 'loopback')).toBe('203.0.113.7');
    expect(networkOf('192.168.1.20', 'loopback')).toBe('192.168.1.20'); // a phone on the campus Wi-Fi, reached directly
    expect(networkOf('192.168.1.20', false)).toBeNull(); // no proxy trusted: maybe a proxy in the building, not one phone
    expect(networkOf('192.168.1.20', 0)).toBeNull(); // TRUST_PROXY=0 is the same
    // IPv6: a phone has a whole /64, so changing the address inside it does not give it more tries.
    expect(networkOf('2001:db8:a:b:1:2:3:4', 'loopback')).toBe('2001:db8:a:b::/64');
    expect(networkOf('2001:db8:a:b::99', 'loopback')).toBe('2001:db8:a:b::/64');
    expect(networkOf('2001:db8::1', 'loopback')).toBe('2001:db8:0:0::/64');
  });
});
