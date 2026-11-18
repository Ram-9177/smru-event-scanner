/**
 * Face-data expiry and auto close (feature G): new events delete face data 90 days after the event, the hourly job
 * closes albums on their day and deletes face data when it is due (keeping the photos), "Delete face data now",
 * the reminder on old closed events, and archiving through the same deleteFaceData.
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runExpiry } from '../src/ops/expiry.js';
import { setDiskProbe } from '../src/ops/disk.js';
import { expectNoLocalMedia, makeEvent, makeHarness, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, PERSON } from './helpers/photos.js';

let h: Harness;
let organiser: ReturnType<typeof request.agent>;

const one = async (sql: string, params: unknown[] = []) => (await h.ctx.db.query<any>(sql, params)).rows[0];
const n = async (sql: string, params: unknown[]) => (await one(sql, params)).n as number;
const faces = (id: string) => n(`select count(*)::int as n from faces where event_id = $1`, [id]);
const shown = async (id: string) => (await h.admin.get(`/api/admin/events/${id}`).expect(200)).body.event.counts.shown as number;
const adminEvent = async (id: string) => (await h.admin.get(`/api/admin/events/${id}`).expect(200)).body.event;
const audits = async (action: string, target: string) => (await h.ctx.db.query<any>(`select actor, target, detail from audit_log where action = $1 and target = $2 order by id`, [action, target])).rows;

/** An event with two synced photos (one face each), a phone that kept its face (Keep me updated) and a saved result. */
async function eventWithFaces(title: string, extra: Record<string, unknown> = {}) {
  const e = await makeEvent(h, title, title, extra);
  h.put(title, 'a.jpg', await makePhoto(31, [{ person: PERSON.red }]));
  h.put(title, 'b.jpg', await makePhoto(32, [{ person: PERSON.green }]));
  await syncNow(h, e.id);
  const media = (await h.ctx.db.query<{ id: string }>(`select id from media where event_id = $1 order by name`, [e.id])).rows;
  const guest = await one(
    `insert into guests (event_id, device_token_hash, keep_updated, embedding, keep_consent_version, keep_consent_at, keep_model)
     values ($1, $2, true, $3, 'k1', now(), 'stub') returning id`,
    [e.id, `hash-${title}`, Buffer.alloc(512, 1)],
  );
  await h.ctx.db.query(`insert into push_subscriptions (guest_id, endpoint, p256dh, auth) values ($1, 'https://push.test/1', 'k', 'a')`, [guest.id]);
  await h.ctx.db.query(`insert into matches (guest_id, media_id, similarity, tier) values ($1, $2, 0.9, 'sure')`, [guest.id, media[0].id]);
  return { e, guest: guest.id as string };
}

beforeAll(async () => {
  h = await makeHarness({ backupDir: '' });
  setDiskProbe(async () => ({ free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 }));
  await h.admin.post('/api/admin/team').send({ email: 'helper@college.test', password: 'another-long-password', role: 'organiser' }).expect(201);
  organiser = request.agent(h.app);
  await organiser.post('/api/admin/login').send({ email: 'helper@college.test', password: 'another-long-password' }).expect(200);
});
afterAll(async () => {
  setDiskProbe(null);
  await h.close();
});
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

describe('the dates on an event', () => {
  it('a new event deletes its face data 90 days after its last day unless told otherwise', async () => {
    const e = (await h.admin.post('/api/admin/events').send({ title: 'Fresher Fest', starts_on: '2026-12-01', ends_on: '2026-12-03' }).expect(201)).body.event;
    expect(e).toMatchObject({ face_days: 90, close_on: null, face_deleted_at: null, sync_failures: 0, face_reminder: false });
    expect((await one(`select face_expiry_at = ('2026-12-03'::date + 90)::timestamptz as ok from events where id = $1`, [e.id])).ok).toBe(true);

    // changing the last day, or the days, moves the date
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ ends_on: '2026-12-05', face_days: 30, close_on: '2026-12-20' }).expect(200);
    const after = await adminEvent(e.id);
    expect(after).toMatchObject({ face_days: 30, close_on: '2026-12-20' });
    expect((await one(`select face_expiry_at = ('2026-12-05'::date + 30)::timestamptz as ok from events where id = $1`, [e.id])).ok).toBe(true);

    // empty = keep it until the event is archived
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ face_days: null, close_on: null }).expect(200);
    expect(await adminEvent(e.id)).toMatchObject({ face_days: null, close_on: null, face_expiry_at: null });
  });

  it('takes the days and the close day from the form, and refuses what makes no sense', async () => {
    const kept = (await h.admin.post('/api/admin/events').send({ title: 'Keep Fest', starts_on: '2026-12-01', face_days: null, close_on: '2026-12-10' }).expect(201)).body.event;
    expect(kept).toMatchObject({ face_days: null, face_expiry_at: null, close_on: '2026-12-10' });
    expect((await h.admin.post('/api/admin/events').send({ title: 'Short Fest', starts_on: '2026-12-01', face_days: 7 }).expect(201)).body.event.face_days).toBe(7);
    for (const bad of [0, 3651, 2.5, '30']) await h.admin.post('/api/admin/events').send({ title: 'Bad Fest', face_days: bad }).expect(400);
    await h.admin.post('/api/admin/events').send({ title: 'Bad Fest', close_on: '20-12-2026' }).expect(400);
  });

  it('FACE_DAYS_DEFAULT=0 leaves new events without a date', async () => {
    h.ctx.cfg.faceDaysDefault = 0;
    try {
      expect((await h.admin.post('/api/admin/events').send({ title: 'No Date Fest', starts_on: '2026-12-01' }).expect(201)).body.event).toMatchObject({ face_days: null, face_expiry_at: null });
    } finally {
      h.ctx.cfg.faceDaysDefault = 90;
    }
  });
});

describe('the hourly job', () => {
  it('closes a Live album on its close day, as "system" in the activity log', async () => {
    const due = await makeEvent(h, 'Close Me', 'Close Me', { close_on: '2027-01-10' });
    const later = await makeEvent(h, 'Not Yet', 'Not Yet', { close_on: '2027-01-11' });
    const draft = await makeEvent(h, 'Draft One', 'Draft One', { close_on: '2027-01-01' });
    for (const e of [due, later]) await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);

    expect((await runExpiry(h.ctx, new Date(2027, 0, 9, 23, 0))).closed).toEqual([]);
    const run = await runExpiry(h.ctx, new Date(2027, 0, 10, 1, 0));
    expect(run.closed).toEqual([due.id]);
    expect((await adminEvent(due.id)).status).toBe('closed');
    expect((await adminEvent(later.id)).status).toBe('live');
    expect((await adminEvent(draft.id)).status).toBe('draft'); // only Live albums close
    expect(await audits('event.auto_close', due.id)).toEqual([{ actor: 'system', target: due.id, detail: { title: 'Close Me' } }]);
    expect((await runExpiry(h.ctx, new Date(2027, 0, 10, 2, 0))).closed).toEqual([]);

    // opened again by hand after its day: the day is used up, so the job does not close it again
    await h.ctx.db.query(`update events set close_on = current_date - 1 where id = $1`, [due.id]);
    await h.admin.patch(`/api/admin/events/${due.id}`).send({ status: 'live' }).expect(200);
    expect((await adminEvent(due.id)).close_on).toBeNull();
  });

  it('deletes face data when it is due: vectors and kept faces go, photos and saved results stay', async () => {
    const { e, guest } = await eventWithFaces('Old Gala', { starts_on: '2026-06-01', face_days: 30 });
    const other = await eventWithFaces('Kept Gala', { starts_on: '2026-06-02', face_days: null });
    expect(await faces(e.id)).toBe(2);

    const run = await runExpiry(h.ctx, new Date());
    expect(run.expired).toEqual([e.id]);
    expect(await faces(e.id)).toBe(0);
    expect(await one(`select keep_updated, embedding, keep_model from guests where id = $1`, [guest])).toEqual({ keep_updated: false, embedding: null, keep_model: null });
    expect(await n(`select count(*)::int as n from push_subscriptions where guest_id = $1`, [guest])).toBe(0);
    expect(await n(`select count(*)::int as n from matches where guest_id = $1`, [guest])).toBe(1); // results stay
    expect(await shown(e.id)).toBe(2); // the photos stay
    const ev = await adminEvent(e.id);
    expect(ev.face_deleted_at).not.toBeNull();
    expect(await audits('event.face_expired', e.id)).toEqual([{ actor: 'system', target: e.id, detail: { title: 'Old Gala', faces: 2, kept: 1 } }]);

    // an event without a date keeps its face data
    expect(await faces(other.e.id)).toBe(2);
    expect(await n(`select count(*)::int as n from guests where id = $1 and keep_updated`, [other.guest])).toBe(1);

    // the next run does nothing more
    expect((await runExpiry(h.ctx, new Date())).expired).toEqual([]);
    expect(await audits('event.face_expired', e.id)).toHaveLength(1);

    // faces that come back afterwards (a photo processed since) are deleted too, without a log line
    const m = await one(`select id from media where event_id = $1 limit 1`, [e.id]);
    await h.ctx.db.query(`insert into faces (event_id, media_id, embedding, box_x, box_y, box_w, box_h, det_score, model) values ($1, $2, $3, 0, 0, 10, 10, 0.9, 'stub')`, [e.id, m.id, Buffer.alloc(512)]);
    await runExpiry(h.ctx, new Date());
    expect(await faces(e.id)).toBe(0);
    expect(await audits('event.face_expired', e.id)).toHaveLength(1);
  });
});

describe('"Delete face data now" and the reminder', () => {
  it('reminds about a closed event more than 90 days old that still has face data, and deletes it on request', async () => {
    const { e, guest } = await eventWithFaces('Spring Fest', { starts_on: '2026-03-01', face_days: null });
    expect((await adminEvent(e.id)).face_reminder).toBe(false); // not closed
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'closed' }).expect(200);
    expect((await adminEvent(e.id)).face_reminder).toBe(true);
    expect((await h.admin.get('/api/admin/events').expect(200)).body.events.find((x: any) => x.id === e.id).face_reminder).toBe(true);

    const res = (await organiser.post(`/api/admin/events/${e.id}/face-data/delete`).expect(200)).body;
    expect(res.deleted).toEqual({ faces: 2, kept: 1, results: 0 });
    expect(res.event).toMatchObject({ id: e.id, face_reminder: false });
    expect(res.event.face_deleted_at).not.toBeNull();
    expect(await faces(e.id)).toBe(0);
    expect(await n(`select count(*)::int as n from matches where guest_id = $1`, [guest])).toBe(1);
    expect(await shown(e.id)).toBe(2);
    expect(await audits('event.face_delete', e.id)).toEqual([{ actor: 'helper@college.test', target: e.id, detail: { title: 'Spring Fest', faces: 2, kept: 1 } }]);

    // a second press: nothing left to delete
    expect((await h.admin.post(`/api/admin/events/${e.id}/face-data/delete`).expect(200)).body.deleted).toEqual({ faces: 0, kept: 0, results: 0 });
    await h.admin.post(`/api/admin/events/00000000-0000-0000-0000-000000000000/face-data/delete`).expect(404);
    await request(h.app).post(`/api/admin/events/${e.id}/face-data/delete`).expect(401);
  });

  it('a recent closed event, or one without face data, gets no reminder', async () => {
    const recent = await eventWithFaces('Recent Fest', { starts_on: '2026-11-01', face_days: null });
    await h.admin.patch(`/api/admin/events/${recent.e.id}`).send({ status: 'closed' }).expect(200);
    expect((await adminEvent(recent.e.id)).face_reminder).toBe(false);
    const bare = await makeEvent(h, 'Bare Fest', 'Bare Fest', { starts_on: '2026-01-01', face_days: null });
    await h.admin.patch(`/api/admin/events/${bare.id}`).send({ status: 'closed' }).expect(200);
    expect((await adminEvent(bare.id)).face_reminder).toBe(false);
  });
});

describe('archiving', () => {
  it('deletes the face data, the kept faces and the saved results; brought back, face search can be restored', async () => {
    const { e, guest } = await eventWithFaces('Archive Fest', { starts_on: '2026-11-25' });
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'archived' }).expect(200);
    expect(await faces(e.id)).toBe(0);
    expect(await n(`select count(*)::int as n from matches where guest_id = $1`, [guest])).toBe(0);
    expect(await one(`select keep_updated, embedding from guests where id = $1`, [guest])).toEqual({ keep_updated: false, embedding: null });
    expect(await n(`select count(*)::int as n from push_subscriptions where guest_id = $1`, [guest])).toBe(0);
    expect((await adminEvent(e.id)).face_deleted_at).not.toBeNull();

    // brought back before its face data was due: "Read every photo again" can restore face search
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'live' }).expect(200);
    expect((await adminEvent(e.id)).face_deleted_at).toBeNull();
  });

  it('brought back after its face data was due, face search stays ended', async () => {
    const { e } = await eventWithFaces('Ancient Fest', { starts_on: '2026-01-10', face_days: 30 });
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'archived' }).expect(200);
    await h.admin.patch(`/api/admin/events/${e.id}`).send({ status: 'closed' }).expect(200);
    expect((await adminEvent(e.id)).face_deleted_at).not.toBeNull();
  });
});
