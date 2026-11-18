/**
 * Remove me, the organisers' side (feature F): a removal request lists the student's photos in Requests; "Remove from
 * album" hides them all (as Hide does), "Keep photos" leaves them. Reports keep working as before.
 * The requests are made here directly in the database (the students' side has its own tests).
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setDiskProbe } from '../src/ops/disk.js';
import { expectNoLocalMedia, fetchImage, makeEvent, makeHarness, phone, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
let organiser: ReturnType<typeof request.agent>;
const ids: Record<string, string> = {};

const one = async (sql: string, params: unknown[] = []) => (await h.ctx.db.query<any>(sql, params)).rows[0];
const albumTotal = async () => (await phone(h, 'viewer').get(`/api/e/${event.slug}/album`).expect(200)).body.total as number;
const hidden = async (name: string) => (await one(`select hidden from media where id = $1`, [ids[name]])).hidden as boolean;

/** A removal request from a phone, listing these photos, as the students' side makes it. */
async function removal(device: string, names: string[], note: string | null = null): Promise<string> {
  const guest = await one(`insert into guests (event_id, device_token_hash) values ($1, $2) returning id`, [event.id, `hash-${device}`]);
  const q = await one(`insert into requests (event_id, guest_id, kind, reason, media_id) values ($1, $2, 'removal', $3, null) returning id`, [event.id, guest.id, note]);
  for (const n of names) await h.ctx.db.query(`insert into request_media (request_id, media_id) values ($1, $2)`, [q.id, ids[n]]);
  return q.id;
}

const listed = async (status = '') => (await h.admin.get(`/api/admin/requests${status}`).expect(200)).body.requests as any[];

beforeAll(async () => {
  h = await makeHarness({ backupDir: '' });
  setDiskProbe(async () => ({ free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 }));
  event = await makeEvent(h, 'Annual Day', 'Annual Day');
  h.put('Annual Day', 'a.jpg', await makePhoto(41, [{ person: PERSON.red }]));
  h.put('Annual Day', 'b.jpg', await makePhoto(42, [{ person: PERSON.red }, { person: PERSON.blue }]));
  h.put('Annual Day', 'c.jpg', await makePhoto(43, [{ person: PERSON.green }]));
  h.put('Annual Day', 'd.jpg', await makePhoto(44, [{ person: PERSON.cyan }]));
  await syncNow(h, event.id);
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
  for (const m of (await h.ctx.db.query<{ id: string; name: string }>(`select id, name from media where event_id = $1`, [event.id])).rows) ids[m.name.replace('.jpg', '')] = m.id;
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

describe('Requests', () => {
  it('lists a removal request with its photos and count, and a report with its one photo', async () => {
    const id = await removal('amy', ['a', 'b'], 'Please take these down');
    await h.ctx.db.query(`insert into requests (event_id, media_id, kind, reason) values ($1, $2, 'report', 'not appropriate')`, [event.id, ids.d]);
    const all = await listed();
    const rm = all.find((q) => q.id === id);
    expect(rm).toMatchObject({ kind: 'removal', status: 'open', reason: 'Please take these down', media_id: null, event_id: event.id, event_title: 'Annual Day', count: 2 });
    expect(rm.photos.map((p: any) => p.id).sort()).toEqual([ids.a, ids.b].sort());
    for (const p of rm.photos) {
      expect(p).toMatchObject({ type: 'photo', video: null, hidden: false });
      expect(p.thumb).toContain('&a=1');
      expect((await fetchImage(h, p.thumb)).status).toBe(200);
      expect((await fetchImage(h, p.web)).status).toBe(200);
    }
    const report = all.find((q) => q.kind === 'report');
    expect(report).toMatchObject({ media_id: ids.d, count: 1 });
    expect(report.photos).toEqual([expect.objectContaining({ id: ids.d, type: 'photo', hidden: false })]);
    expect(report.thumb).toBeTruthy(); // the fields the console already used stay
  });

  it('"Remove from album" hides every listed photo at once and marks the request done', async () => {
    const id = (await listed()).find((q) => q.kind === 'removal').id;
    expect(await albumTotal()).toBe(4);
    const res = (await organiser.patch(`/api/admin/requests/${id}`).send({ status: 'approved' }).expect(200)).body;
    expect(res).toEqual({ ok: true, hidden: 2 });
    expect(await hidden('a')).toBe(true);
    expect(await hidden('b')).toBe(true);
    expect(await hidden('c')).toBe(false);
    expect(await albumTotal()).toBe(2);
    expect(await one(`select status, resolved_at is not null as resolved from requests where id = $1`, [id])).toEqual({ status: 'approved', resolved: true });
    const log = await one(`select actor, target, detail from audit_log where action = 'request.approved' order by id desc limit 1`);
    expect(log).toEqual({ actor: 'helper@college.test', target: id, detail: { kind: 'removal', count: 2 } });

    // gone from the open list; in the full list it shows its photos as hidden
    expect((await listed()).some((q) => q.id === id)).toBe(false);
    const done = (await listed('?status=all')).find((q) => q.id === id);
    expect(done.status).toBe('approved');
    expect(done.photos.every((p: any) => p.hidden)).toBe(true);
  });

  it('"Keep photos" leaves the album as it is', async () => {
    const id = await removal('ben', ['c']);
    expect((await listed()).find((q) => q.id === id)).toMatchObject({ reason: null, count: 1 });
    expect((await h.admin.patch(`/api/admin/requests/${id}`).send({ status: 'declined' }).expect(200)).body).toEqual({ ok: true, hidden: 0 });
    expect(await hidden('c')).toBe(false);
    expect((await one(`select status from requests where id = $1`, [id])).status).toBe('declined');
    expect(await albumTotal()).toBe(2);
  });

  it('a listed photo that has since become a copy: the photo shown in its place is hidden', async () => {
    // e is a copy of c (as when the same shot is found again)
    const copy = await one(
      `insert into media (event_id, type, status, review, name, duplicate_of, source) values ($1, 'photo', 'ready', 'approved', 'e.jpg', $2, 'onedrive') returning id`,
      [event.id, ids.c],
    );
    ids.e = copy.id;
    const id = await removal('cat', ['e']);
    expect((await h.admin.patch(`/api/admin/requests/${id}`).send({ status: 'approved' }).expect(200)).body).toEqual({ ok: true, hidden: 1 });
    expect(await hidden('c')).toBe(true);
    expect(await albumTotal()).toBe(1);
  });

  it('reports work as before, and an unknown request is not found', async () => {
    const report = (await listed()).find((q) => q.kind === 'report');
    expect((await h.admin.patch(`/api/admin/requests/${report.id}`).send({ status: 'approved' }).expect(200)).body).toEqual({ ok: true });
    expect(await hidden('d')).toBe(true);
    await h.admin.patch('/api/admin/requests/00000000-0000-0000-0000-000000000000').send({ status: 'approved' }).expect(404);
    await h.admin.patch(`/api/admin/requests/${report.id}`).send({ status: 'maybe' }).expect(400);
  });
});
