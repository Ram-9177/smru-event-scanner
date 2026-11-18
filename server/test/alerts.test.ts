/**
 * Alerts for the organisers (feature C): each problem is raised and cleared, the console sees what it may see,
 * emails go out at most once per problem per 12 hours (and once when it is fixed), the morning summary, and
 * Settings > Alerts (email on/off, Send a test email).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkAlerts, localDay, sendDigest, setServerStart } from '../src/alerts/alerts.js';
import { setBackupState } from '../src/backup.js';
import { syncEvent } from '../src/sync/sync.js';
import { setDiskProbe } from '../src/ops/disk.js';
import type { Mailer } from '../src/lib/mail.js';
import { ADMIN, makeEvent, makeHarness, type Harness } from './helpers/harness.js';

const GB = 1024 ** 3;
const HOUR = 3600 * 1000;
let h: Harness;
let backupDir: string;
let organiser: ReturnType<typeof request.agent>;
let free = 500 * GB;
/** The clock the checks are given: starts at the real time and is moved on by the tests. */
let clock = Date.now();
const at = (plusMs = 0) => new Date((clock += plusMs));

const active = async () => (await h.ctx.db.query(`select key, kind, severity, title, detail, started_at, emailed_at from alerts where cleared_at is null order by key`)).rows;
const mailsAbout = (subject: string) => h.mail.filter((m) => m.subject === subject);

beforeAll(async () => {
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-alert-backups-'));
  // Backups are watched only in their own test (h.ctx.cfg.backupDir is set there).
  h = await makeHarness({ backupDir: '', msClientSecretExpires: '' });
  setDiskProbe(async () => ({ free, total: 1000 * GB }));
  setServerStart(new Date());
  await h.admin.post('/api/admin/team').send({ email: 'helper@college.test', password: 'another-long-password', role: 'organiser' }).expect(201);
  organiser = request.agent(h.app);
  await organiser.post('/api/admin/login').send({ email: 'helper@college.test', password: 'another-long-password' }).expect(200);
  h.mail.length = 0; // the welcome email to the organiser
});
afterAll(async () => {
  setDiskProbe(null);
  await h.close();
  fs.rmSync(backupDir, { recursive: true, force: true });
});
afterEach(async () => {
  // every test starts with nothing wrong
  free = 500 * GB;
  h.ctx.face.health = async () => true;
  setBackupState({ lastAt: null, lastError: null });
  h.ctx.cfg.backupDir = '';
  h.ctx.cfg.msClientSecretExpires = '';
  (h.ctx.drive as any).kind = 'local';
  await h.ctx.db.query(`update events set sync_failures = 0`);
  await checkAlerts(h.ctx, at(1000));
  h.mail.length = 0;
});

describe('when nothing is wrong', () => {
  it('there are no alerts and no emails', async () => {
    expect(await checkAlerts(h.ctx, at())).toEqual([]);
    expect((await h.admin.get('/api/admin/alerts').expect(200)).body).toEqual({ alerts: [] });
    expect(h.mail).toHaveLength(0);
  });
});

describe('face recognition down', () => {
  it('is raised and emailed once, again only after 12 hours, and a "Fixed" email when it clears', async () => {
    h.ctx.face.health = async () => false;
    const found = await checkAlerts(h.ctx, at());
    expect(found.map((f) => f.kind)).toEqual(['face_down']);
    const [row] = await active();
    expect(row).toMatchObject({ key: 'face_down', severity: 'critical', title: 'Face recognition is not running' });

    const sent = mailsAbout('Event Photos: Face recognition is not running');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(ADMIN.email); // the super admin, never the organiser
    expect(sent[0].text).toContain('New photos cannot be read and selfies do not work.');
    expect(sent[0].text).toContain('Open the console: https://photos.college.test/admin');
    expect(sent[0].text).toContain(`You get this because email alerts are on for ${ADMIN.email}. Turn them off in the console: Settings, Alerts and storage.`);

    // still down an hour later: no second email
    await checkAlerts(h.ctx, at(HOUR));
    expect(mailsAbout('Event Photos: Face recognition is not running')).toHaveLength(1);
    // still down 12 hours after the email: one more
    await checkAlerts(h.ctx, at(12 * HOUR));
    expect(mailsAbout('Event Photos: Face recognition is not running')).toHaveLength(2);

    // both organisers and super admins see it in the console
    const forSuper = (await h.admin.get('/api/admin/alerts').expect(200)).body.alerts;
    expect(forSuper).toEqual([
      expect.objectContaining({ key: 'face_down', kind: 'face_down', severity: 'critical', title: 'Face recognition is not running', event: null, action: null }),
    ]);
    expect((await organiser.get('/api/admin/alerts').expect(200)).body.alerts.map((a: any) => a.kind)).toEqual(['face_down']);

    h.ctx.face.health = async () => true;
    await checkAlerts(h.ctx, at(60_000));
    expect(await active()).toEqual([]);
    const fixed = mailsAbout('Fixed: Face recognition is not running');
    expect(fixed).toHaveLength(1);
    expect(fixed[0].text).toContain('This is fixed now: Face recognition is not running.');
  });

  it('coming back within 12 hours of the last email is shown again but not emailed again, and needs no "Fixed"', async () => {
    h.ctx.face.health = async () => false;
    await checkAlerts(h.ctx, at());
    expect(mailsAbout('Event Photos: Face recognition is not running')).toHaveLength(0); // emailed less than 12 h ago (the test before)
    expect((await active()).map((a) => a.kind)).toEqual(['face_down']);
    h.ctx.face.health = async () => true;
    await checkAlerts(h.ctx, at(60_000));
    expect(mailsAbout('Fixed: Face recognition is not running')).toHaveLength(0);
  });
});

describe('disk space', () => {
  it('says nothing about the server\'s disk while uploads go (photos are in OneDrive); once they are paused, a critical alert for super admins only', async () => {
    free = 4.04 * GB;
    await checkAlerts(h.ctx, at(13 * HOUR));
    expect(await active()).toEqual([]);
    free = 1.6 * GB; // nearly full, but uploads still go
    await checkAlerts(h.ctx, at(30_000));
    expect(await active()).toEqual([]);

    free = 0.6 * GB;
    await checkAlerts(h.ctx, at(30_000));
    const [row] = await active();
    expect(row).toMatchObject({
      key: 'disk_low',
      severity: 'critical',
      title: 'Uploads are paused: the server is out of space',
      detail: 'Uploads start again once there is at least 1 GB free. Free up space on the Mac.',
    });
    expect(mailsAbout('Event Photos: Uploads are paused: the server is out of space')).toHaveLength(1);

    const alert = (await h.admin.get('/api/admin/alerts').expect(200)).body.alerts[0];
    expect(alert.action).toEqual({ label: 'See storage', to: '/admin/settings?tab=alerts' });
    expect((await organiser.get('/api/admin/alerts').expect(200)).body.alerts).toEqual([]);

    free = 40 * GB;
    await checkAlerts(h.ctx, at(60_000));
    expect(await active()).toEqual([]);
    expect(mailsAbout('Fixed: Uploads are paused: the server is out of space')).toHaveLength(1);
  });

  it('ALERT_DISK_WARN_GB and ALERT_DISK_CRITICAL_GB ask to be told earlier', async () => {
    h.ctx.cfg.alerts.diskWarnBytes = 5 * GB;
    h.ctx.cfg.alerts.diskCriticalBytes = 2 * GB;
    try {
      free = 4.04 * GB;
      await checkAlerts(h.ctx, at(13 * HOUR));
      let [row] = await active();
      expect(row).toMatchObject({ key: 'disk_low', severity: 'warn', title: 'Only 4.0 GB free on the server', detail: 'Free up space on the Mac. Uploads stop below 1 GB.' });
      free = 1.6 * GB;
      await checkAlerts(h.ctx, at(30_000));
      [row] = await active();
      expect(row).toMatchObject({ key: 'disk_low', severity: 'critical', title: 'The server is nearly full: 1.6 GB free', detail: 'Free up space on the Mac. Uploads stop below 1 GB.' });
    } finally {
      h.ctx.cfg.alerts.diskWarnBytes = 0;
      h.ctx.cfg.alerts.diskCriticalBytes = 0;
      free = 40 * GB;
    }
    await checkAlerts(h.ctx, at(60_000));
    expect(await active()).toEqual([]);
  });

  it('on a server (not a Mac): says nothing at 1.9 GB free, and once uploads are paused advises a bigger disk', async () => {
    h.ctx.cfg.machine = 'server';
    try {
      free = 1.9 * GB; // as on the live server: little room, but uploads go
      await checkAlerts(h.ctx, at(60_000));
      expect(await active()).toEqual([]);
      free = 0.6 * GB;
      await checkAlerts(h.ctx, at(60_000));
      const [row] = await active();
      expect(row).toMatchObject({
        key: 'disk_low',
        severity: 'critical',
        title: 'Uploads are paused: the server is out of space',
        detail: 'Uploads start again once there is at least 1 GB free. Give the server a bigger disk, or free up space on it.',
      });
      free = 40 * GB;
      await checkAlerts(h.ctx, at(60_000));
      expect(await active()).toEqual([]);
    } finally {
      h.ctx.cfg.machine = 'Mac';
      free = 40 * GB;
    }
  });
});

describe('photos in OneDrive', () => {
  it('copies that cannot be made, a long rebuild, OneDrive nearly full and OneDrive not giving photos are each raised and cleared', async () => {
    const e = await makeEvent(h, 'Lost Copies', 'Lost Copies');
    const m = (await h.ctx.db.knex('media').insert({ event_id: e.id, type: 'photo', name: 'gone.jpg', status: 'ready', thumb_key: 'media/x_t.webp', copies_lost: true }).returning('id'))[0].id;
    await checkAlerts(h.ctx, at(60_000));
    const lost = (await active()).find((a: any) => a.kind === 'copies_lost');
    expect(lost).toMatchObject({ key: `copies_lost:${e.id}`, severity: 'warn', title: '1 photo of Lost Copies cannot be shown: their originals are no longer in OneDrive.' });
    const seen = (await organiser.get('/api/admin/alerts').expect(200)).body.alerts.find((a: any) => a.kind === 'copies_lost');
    expect(seen.action).toEqual({ label: 'Open the Media manager', to: `/admin/events/${e.id}?tab=media&filter=lost` });
    await h.ctx.db.query(`update media set copies_lost = false where id = $1`, [m]);

    // more than 50 waiting for over 30 minutes
    await h.ctx.db.knex('media').insert(Array.from({ length: 51 }, (_, i) => ({ event_id: e.id, type: 'photo', name: `w${i}.jpg`, status: 'ready', thumb_key: `media/w${i}_t.webp`, web_key: `media/w${i}_w.webp` })));
    await checkAlerts(h.ctx, at(60_000));
    expect((await active()).some((a: any) => a.kind === 'copies_rebuilding')).toBe(false); // not yet 30 minutes
    await checkAlerts(h.ctx, at(31 * 60_000));
    expect((await active()).find((a: any) => a.kind === 'copies_rebuilding')).toMatchObject({ title: 'Rebuilding album copies in OneDrive: 52 left.' });
    await h.ctx.db.query(`delete from media where event_id = $1`, [e.id]);

    // OneDrive nearly full
    const status = h.ctx.drive.status.bind(h.ctx.drive);
    h.ctx.drive.status = async () => ({ ...(await status()), quota: { total: 100 * GB, used: 96 * GB, remaining: 4 * GB } });
    // OneDrive not giving photos for 5 minutes
    await h.ctx.redis.set('drive:down', String(at().getTime() - 6 * 60_000), 'EX', 60);
    try {
      await checkAlerts(h.ctx, at(60_000));
      const kinds = (await active()).map((a: any) => a.kind);
      expect(kinds).toEqual(expect.arrayContaining(['onedrive_space_low', 'images_unavailable']));
      expect(kinds).not.toContain('copies_lost');
      expect(kinds).not.toContain('copies_rebuilding');
      expect((await active()).find((a: any) => a.kind === 'onedrive_space_low')).toMatchObject({ severity: 'critical', title: 'OneDrive is nearly full: 4.0 GB free of 100 GB' });
    } finally {
      h.ctx.drive.status = status;
      await h.ctx.redis.del('drive:down');
    }
    await checkAlerts(h.ctx, at(60_000));
    expect((await active()).map((a: any) => a.kind).filter((k: string) => ['onedrive_space_low', 'images_unavailable', 'copies_lost', 'copies_rebuilding'].includes(k))).toEqual([]);
    h.mail.length = 0;
  });
});

describe('sync failing', () => {
  it('two failed syncs in a row raise it for that event; a sync that works clears it', async () => {
    const e = await makeEvent(h, 'Choir Night', 'Choir Night');
    const folder = path.join(h.driveDir, 'Choir Night');
    fs.rmSync(folder, { recursive: true, force: true });
    await expect(syncEvent(h.ctx, e.id)).rejects.toThrow();
    const failures = async () => (await h.ctx.db.query<{ n: number }>(`select sync_failures as n from events where id = $1`, [e.id])).rows[0].n;
    expect(await failures()).toBe(1);
    expect(await checkAlerts(h.ctx, at(13 * HOUR))).toEqual([]); // one failure is not a problem yet

    await expect(syncEvent(h.ctx, e.id)).rejects.toThrow();
    expect(await failures()).toBe(2);
    const [found] = await checkAlerts(h.ctx, at(60_000));
    expect(found).toMatchObject({ key: `sync_failing:${e.id}`, severity: 'warn', title: 'Sync is failing for Choir Night', detail: 'The event folder is no longer in OneDrive.' });
    const forOrganiser = (await organiser.get('/api/admin/alerts').expect(200)).body.alerts;
    expect(forOrganiser).toEqual([
      expect.objectContaining({ kind: 'sync_failing', event: { id: e.id, title: 'Choir Night' }, action: { label: 'Open the event', to: `/admin/events/${e.id}?tab=settings` } }),
    ]);
    expect(mailsAbout('Event Photos: Sync is failing for Choir Night')).toHaveLength(1);

    // the face service being down is not the sync's fault: not counted
    h.ctx.face.health = async () => false;
    await expect(syncEvent(h.ctx, e.id)).rejects.toThrow();
    expect(await failures()).toBe(2);
    h.ctx.face.health = async () => true;

    fs.mkdirSync(folder, { recursive: true });
    // the folder came back (with a new id in the stand-in drive): link it again, which also resets the count
    const f = (await h.admin.get('/api/admin/onedrive/folders').expect(200)).body.folders.find((x: any) => x.name === 'Choir Night');
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ onedrive_folder_id: f.id }).expect(200);
    await h.ctx.db.query(`update events set sync_failures = 2 where id = $1`, [e.id]);
    await syncEvent(h.ctx, e.id);
    expect(await failures()).toBe(0);
    await checkAlerts(h.ctx, at(60_000));
    expect(await active()).toEqual([]);
    expect(mailsAbout('Fixed: Sync is failing for Choir Night')).toHaveLength(1);
  });

  it('a closed event is not watched', async () => {
    const e = await makeEvent(h, 'Old Debate', 'Old Debate');
    await h.ctx.db.query(`update events set sync_failures = 3, status = 'closed' where id = $1`, [e.id]);
    expect(await checkAlerts(h.ctx, at(60_000))).toEqual([]);
  });
});

describe('backups', () => {
  it('a failed backup is critical; an old one, or none after two days, a warning', async () => {
    h.ctx.cfg.backupDir = backupDir;
    setBackupState({ lastAt: null, lastError: 'pg_dump: connection refused' });
    await checkAlerts(h.ctx, at(13 * HOUR));
    expect(await active()).toEqual([expect.objectContaining({ key: 'backup_failed', severity: 'critical', title: 'The database backup did not work', detail: 'pg_dump: connection refused' })]);
    expect((await organiser.get('/api/admin/alerts').expect(200)).body.alerts).toEqual([]);

    setBackupState({ lastAt: new Date(clock - 3 * 24 * HOUR - HOUR), lastError: null });
    await checkAlerts(h.ctx, at(60_000));
    expect(await active()).toEqual([
      expect.objectContaining({ key: 'backup_old', severity: 'warn', title: 'The last database backup is 3 days old', detail: `Backups go to ${backupDir}. Check that pg_dump works (PG_DUMP in server/.env).` }),
    ]);

    setBackupState({ lastAt: null, lastError: null });
    setServerStart(new Date(clock - HOUR)); // just started: give it time
    await checkAlerts(h.ctx, at(60_000));
    expect(await active()).toEqual([]);
    setServerStart(new Date(clock - 49 * HOUR));
    await checkAlerts(h.ctx, at(60_000));
    expect((await active()).map((a) => a.title)).toEqual(['No database backup has been made yet']);
    setServerStart(new Date());
  });
});

describe('OneDrive', () => {
  it('needs connecting again (critical), and a sign-in not used for 76 days or more (warning)', async () => {
    (h.ctx.drive as any).kind = 'graph';
    await h.ctx.db.query(
      `insert into connections (org_id, refresh_token, root_item_id, needs_reconnect, connected_at) values ($1, 'x', 'root', true, now())
       on conflict (org_id) do update set needs_reconnect = true, refresh_token = 'x', root_item_id = 'root', connected_at = now(), renewed_at = null`,
      [h.ctx.orgId],
    );
    await checkAlerts(h.ctx, at(13 * HOUR));
    expect(await active()).toEqual([expect.objectContaining({ key: 'onedrive_reconnect', severity: 'critical', title: 'OneDrive needs connecting again' })]);
    const alert = (await h.admin.get('/api/admin/alerts').expect(200)).body.alerts[0];
    expect(alert.action).toEqual({ label: 'Open OneDrive settings', to: '/admin/settings?tab=onedrive' });

    await h.ctx.db.query(`update connections set needs_reconnect = false, connected_at = $2 where org_id = $1`, [h.ctx.orgId, new Date(clock - 80 * 24 * HOUR)]);
    await checkAlerts(h.ctx, at(60_000));
    expect(await active()).toEqual([
      expect.objectContaining({
        key: 'onedrive_signin',
        severity: 'warn',
        title: 'The OneDrive sign-in has not been used for 80 days',
        detail: 'Microsoft ends it after 90 days without use. Press Sync now on any event to keep it, or connect OneDrive again.',
      }),
    ]);
    // the sign-in was used (graph.ts sets renewed_at on every token refresh)
    await h.ctx.db.query(`update connections set renewed_at = $2 where org_id = $1`, [h.ctx.orgId, new Date(clock)]);
    await checkAlerts(h.ctx, at(60_000));
    expect(await active()).toEqual([]);
    await h.ctx.db.query(`delete from connections`);
  });

  it('the client secret: a warning 14 days before its end date, critical once it has run out', async () => {
    const day = (n: number) => localDay(new Date(clock + n * 24 * HOUR));
    h.ctx.cfg.msClientSecretExpires = day(30);
    expect(await checkAlerts(h.ctx, at(13 * HOUR))).toEqual([]);

    h.ctx.cfg.msClientSecretExpires = '2026-12-03';
    const now = new Date(2026, 10, 25, 10, 0); // 8 days before
    await checkAlerts(h.ctx, now);
    expect(await active()).toEqual([
      expect.objectContaining({
        key: 'onedrive_secret',
        severity: 'warn',
        title: 'The OneDrive client secret runs out on 3 Dec 2026',
        detail:
          'Make a new client secret in Microsoft Entra (Certificates & secrets), put its Value in MS_CLIENT_SECRET in server/.env, set MS_CLIENT_SECRET_EXPIRES to its end date, and restart.',
      }),
    ]);
    await checkAlerts(h.ctx, new Date(2026, 11, 4, 10, 0));
    expect(await active()).toEqual([expect.objectContaining({ key: 'onedrive_secret', severity: 'critical', title: 'The OneDrive client secret has run out' })]);
    clock = Math.max(clock, new Date(2026, 11, 4, 10, 1).getTime());
  });
});

describe('who gets emails', () => {
  it('nobody when email is not set up (the console still shows it), nor a super admin who turned them off', async () => {
    const real = h.ctx.mailer;
    const sent: string[] = [];
    h.ctx.mailer = { configured: false, send: async (m) => (sent.push(m.subject), false) } satisfies Mailer;
    try {
      h.ctx.face.health = async () => false;
      await checkAlerts(h.ctx, at(13 * HOUR));
      expect(sent).toEqual([]);
      expect((await h.admin.get('/api/admin/alerts').expect(200)).body.alerts).toHaveLength(1);
    } finally {
      h.ctx.mailer = real;
    }
    h.ctx.face.health = async () => true;
    await checkAlerts(h.ctx, at(60_000));
    expect(h.mail).toHaveLength(0); // never emailed about it, so no "Fixed" either

    await h.admin.patch('/api/admin/alerts/settings').send({ email_alerts: false }).expect(200);
    h.ctx.face.health = async () => false;
    await checkAlerts(h.ctx, at(13 * HOUR));
    expect(h.mail).toHaveLength(0);
    await h.admin.patch('/api/admin/alerts/settings').send({ email_alerts: true }).expect(200);
  });
});

describe('Settings > Alerts', () => {
  it('shows and changes my email alerts; organisers cannot', async () => {
    expect((await h.admin.get('/api/admin/alerts/settings').expect(200)).body).toEqual({ smtp: true, email_alerts: true, email: ADMIN.email, digest_hour: 9 });
    const off = (await h.admin.patch('/api/admin/alerts/settings').send({ email_alerts: false }).expect(200)).body;
    expect(off.email_alerts).toBe(false);
    expect((await h.ctx.db.query(`select detail from audit_log where action = 'alerts.settings' order by id desc limit 1`)).rows[0].detail).toEqual({ email_alerts: false });
    await h.admin.patch('/api/admin/alerts/settings').send({ email_alerts: true }).expect(200);
    await h.admin.patch('/api/admin/alerts/settings').send({ email_alerts: 'yes' }).expect(400);

    expect((await organiser.get('/api/admin/alerts/settings').expect(403)).body.error).toBe('super_admin_only');
    await organiser.patch('/api/admin/alerts/settings').send({ email_alerts: false }).expect(403);
    await organiser.post('/api/admin/alerts/test').expect(403);
    await request(h.app).get('/api/admin/alerts').expect(401);
  });

  it('says when the morning summary is off', async () => {
    h.ctx.cfg.alerts.digestHour = -1;
    try {
      expect((await h.admin.get('/api/admin/alerts/settings').expect(200)).body.digest_hour).toBeNull();
    } finally {
      h.ctx.cfg.alerts.digestHour = 9;
    }
  });

  it('sends a test email, says when email is not set up or the send failed, and stops after five an hour', async () => {
    const real = h.ctx.mailer;
    try {
      h.ctx.mailer = { configured: false, send: async () => false };
      const none = (await h.admin.post('/api/admin/alerts/test').expect(409)).body;
      expect(none).toEqual({ error: 'no_smtp', message: 'Email is not set up on this server. Set SMTP_URL in server/.env and restart.' });
      expect((await h.admin.get('/api/admin/alerts/settings').expect(200)).body.smtp).toBe(false);

      h.ctx.mailer = { configured: true, send: async () => false };
      expect((await h.admin.post('/api/admin/alerts/test').expect(502)).body).toEqual({ error: 'send_failed', message: 'The email could not be sent. Check SMTP_URL in server/.env.' });
    } finally {
      h.ctx.mailer = real;
    }
    expect((await h.admin.post('/api/admin/alerts/test').expect(200)).body).toEqual({ sent: true, to: ADMIN.email });
    const [m] = mailsAbout('Event Photos: test email');
    expect(m.to).toBe(ADMIN.email);
    expect(m.text).toContain('This is a test email from Event Photos. Alerts will reach you at this address.');
    expect(m.text).toContain('Open the console: https://photos.college.test/admin');
    // two counted so far (the failed send and this one): three more, then a wait
    for (let i = 0; i < 3; i++) await h.admin.post('/api/admin/alerts/test').expect(200);
    expect((await h.admin.post('/api/admin/alerts/test').expect(429)).body).toEqual({ error: 'slow_down', message: 'That is a lot of test emails. Try again later.' });
  });
});

describe('the morning summary', () => {
  const morning = (day: number, hour: number) => new Date(2027, 0, day, hour, 30);

  it('goes once a day from 09:00, only when uploads or requests are waiting', async () => {
    await h.ctx.db.query(`delete from app_state`);
    // nothing waiting: nothing sent, but the day is used up
    expect(await sendDigest(h.ctx, morning(5, 9))).toBe(false);
    expect((await h.ctx.db.query(`select value from app_state where key = 'digest_last'`)).rows[0].value).toBe('2027-01-05');

    const e = await makeEvent(h, 'Sports Day', 'Sports Day');
    await h.ctx.db.query(`insert into media (event_id, type, status, review, source, name) values ($1, 'photo', 'ready', 'pending', 'crowd', 'a.jpg'), ($1, 'photo', 'ready', 'pending', 'crowd', 'b.jpg')`, [e.id]);
    await h.ctx.db.query(`insert into media (event_id, type, status, review, source, name) values ($1, 'photo', 'processing', 'pending', 'crowd', 'c.jpg')`, [e.id]); // not ready: not counted
    await h.ctx.db.query(`insert into requests (event_id, kind, reason) values ($1, 'report', 'not me'), ($1, 'removal', null)`, [e.id]);

    expect(await sendDigest(h.ctx, morning(5, 10))).toBe(false); // already done today
    expect(await sendDigest(h.ctx, morning(6, 8))).toBe(false); // too early
    expect(await sendDigest(h.ctx, morning(6, 9))).toBe(true);
    const [m] = h.mail;
    expect(m.to).toBe(ADMIN.email);
    expect(m.subject).toBe('Event Photos: 2 uploads to approve, 2 open requests');
    expect(m.text).toContain('Sports Day: 2 waiting for approval');
    expect(m.text).toContain('Reports from students: 1');
    expect(m.text).toContain('Removal requests: 1');
    expect(m.text).toContain('Open the console: https://photos.college.test/admin');
    expect(await sendDigest(h.ctx, morning(6, 11))).toBe(false); // once a day
    expect(await sendDigest(h.ctx, morning(7, 12))).toBe(false); // the window is 09:00 to 12:00
    expect(await sendDigest(h.ctx, morning(8, 11))).toBe(true);
    expect(h.mail).toHaveLength(2);

    await h.ctx.db.query(`update media set review = 'approved' where event_id = $1 and name = 'b.jpg'`, [e.id]);
    await h.ctx.db.query(`update requests set status = 'approved' where event_id = $1 and kind = 'removal'`, [e.id]);
    expect(await sendDigest(h.ctx, morning(9, 9))).toBe(true);
    expect(h.mail[2].subject).toBe('Event Photos: 1 upload to approve, 1 open request');

    h.ctx.cfg.alerts.digestHour = -1;
    try {
      expect(await sendDigest(h.ctx, morning(10, 9))).toBe(false);
    } finally {
      h.ctx.cfg.alerts.digestHour = 9;
    }
  });
});
