/**
 * Keep me updated (feature E): the face vector is kept only after the student's own opt-in, new photos of the event are
 * matched against it (sure matches only), the student is told by Web Push, and turning it off or deleting the results
 * deletes the vector.
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { freshCount, keepVector, matchNewMedia } from '../src/keep/keep-updated.js';
import { setDiskProbe } from '../src/ops/disk.js';
import { flushPushes, pushPayload, PUSH_DELAY_MS, PUSH_MAX_WAIT_MS, queueNewPhotos, saveSubscription, sendDue, setPushSender, type BrowserSubscription } from '../src/keep/push.js';
import { expectNoLocalMedia, makeEvent, makeHarness, phone, settle, syncNow, type Harness } from './helpers/harness.js';
import { makePhoto, makeSelfie, PERSON } from './helpers/photos.js';

let h: Harness;
let event: any;
const FOLDER = '2026-11-20 Freshers Day';
const TITLE = "Freshers' Day";

const sent: { sub: BrowserSubscription; payload: any }[] = [];
let answer = 201;

const red = () => phone(h, 'red-keeper');
const keepOn = (p: ReturnType<typeof phone>, image: Buffer, consent: string | null = 'k1') => {
  const r = p.post(`/api/e/${event.slug}/keep`).set('content-type', 'image/jpeg');
  if (consent) r.set('x-keep-consent', consent);
  return r.send(image);
};
const guestRow = async (token: string) =>
  (
    await h.ctx.db.query(
      `select g.* from guests g where g.event_id = $1 and g.device_token_hash = encode(sha256(convert_to($2, 'utf8')), 'hex')`,
      [event.id, token],
    )
  ).rows[0];
const SUB = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/test-${n}`, keys: { p256dh: `p256-${n}`, auth: `auth-${n}` } });
const mediaId = async (name: string) => (await h.ctx.db.query(`select id from media where event_id = $1 and name = $2`, [event.id, name])).rows[0].id as string;

beforeAll(async () => {
  setDiskProbe(async () => ({ free: 100 * 1024 ** 3, total: 500 * 1024 ** 3 })); // whatever this computer has free
  h = await makeHarness();
  event = await makeEvent(h, TITLE, FOLDER);
  h.put(FOLDER, 'IMG_0001.jpg', await makePhoto(1, [{ person: PERSON.red }, { person: PERSON.blue }]));
  h.put(FOLDER, 'IMG_0002.jpg', await makePhoto(2, [{ person: PERSON.green }]));
  await syncNow(h, event.id);
  await h.admin.patch(`/api/admin/events/${event.id}`).send({ status: 'live' }).expect(200);
  setPushSender(async (sub, payload) => {
    sent.push({ sub, payload: JSON.parse(payload) });
    return { statusCode: answer };
  });
});
afterEach(() => {
  answer = 201;
});
afterAll(async () => {
  setPushSender(null);
  setDiskProbe(null);
  await flushPushes(h.ctx);
  await h.close();
});
// The owner's rule: no photo or video bytes stay on this server (only temp files during a job, gone afterwards).
afterEach(() => expectNoLocalMedia(h));

describe('turning it on', () => {
  it('a selfie search keeps no vector, and My prints offers Keep me updated', async () => {
    const found = (await red().selfie(event.slug, await makeSelfie(PERSON.red)).expect(200)).body;
    expect(found.sure).toHaveLength(1);
    expect(found.sure[0].fresh).toBe(false);
    expect((await guestRow(red().token)).embedding).toBeNull();
    const mine = (await red().get(`/api/e/${event.slug}/mine`).expect(200)).body;
    expect(mine.keep).toEqual({ available: true, on: false, push: false, consent_version: 'k1' });
    expect(mine.fresh_count).toBe(0);
    expect(mine.removal).toBeNull();
    expect(mine.sure[0].fresh).toBe(false);
  });

  it('needs its own consent, a selfie, a face and a search first', async () => {
    const selfie = await makeSelfie(PERSON.red);
    expect((await keepOn(red(), selfie, null).expect(400)).body.error).toBe('consent_needed');
    expect((await keepOn(red(), selfie, 'v1').expect(400)).body).toMatchObject({ error: 'consent_needed', message: 'Please read the line next to the box first.' });
    expect((await keepOn(red(), Buffer.from('tiny')).expect(400)).body.error).toBe('no_selfie');
    expect((await keepOn(red(), await makePhoto(500)).expect(422)).body.error).toBe('no_face');
    expect((await keepOn(phone(h, 'never-searched'), selfie).expect(409)).body).toMatchObject({ error: 'not_searched', message: 'Find your photos first.' });
    const g = await guestRow(red().token);
    expect(g.embedding).toBeNull();
    expect(g.keep_updated).toBe(false);
    expect(g.keep_consent_version).toBeNull();
  });

  it('with consent keeps only the face vector, for this event', async () => {
    const files = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? files(path.join(d, f.name)) : [path.join(d, f.name)]));
    const before = new Set(files(h.ctx.cfg.dataDir));
    const keysBefore = new Set(await h.ctx.redis.keys(`${h.ctx.cfg.redisPrefix}*`));
    const res = (await keepOn(red(), await makeSelfie(PERSON.red)).expect(200)).body;
    expect(res.keep).toEqual({ available: true, on: true, push: false, consent_version: 'k1' });
    const g = await guestRow(red().token);
    expect(g.keep_updated).toBe(true);
    expect(g.keep_consent_version).toBe('k1');
    expect(g.keep_consent_at).toBeInstanceOf(Date);
    expect(g.keep_model).toBe('stub');
    expect(Buffer.from(g.embedding).length).toBe(128 * 4); // the vector, never the picture
    // Nothing of the selfie on disk (no file at all was added), nor in Redis: no new key but the rate-limit
    // counter, and no value there bigger than a counter. (KEYS takes and gives the test's key prefix in
    // full; the other commands add it themselves.)
    expect(files(h.ctx.cfg.dataDir).filter((f) => !before.has(f))).toEqual([]);
    const prefix = h.ctx.cfg.redisPrefix;
    const now = (await h.ctx.redis.keys(`${prefix}*`)).map((k) => k.slice(prefix.length));
    expect(now.filter((k) => !keysBefore.has(prefix + k) && !k.startsWith('limit:keep:'))).toEqual([]);
    expect(now.some((k) => k.startsWith('limit:keep:'))).toBe(true); // the listing does see this test's keys
    for (const k of now) {
      if ((await h.ctx.redis.type(k)) === 'string') expect(String((await h.ctx.redis.get(k)) ?? '').length).toBeLessThan(200);
    }
  });

  it('Keep me updated off on the server: not offered, refused', async () => {
    h.ctx.cfg.keepUpdated = false;
    try {
      expect((await keepOn(red(), await makeSelfie(PERSON.red)).expect(403)).body.error).toBe('keep_off');
      expect((await red().get(`/api/e/${event.slug}/mine`).expect(200)).body.keep.available).toBe(false);
      expect((await request(h.app).get('/api/push/key').expect(200)).body).toEqual({ key: null });
    } finally {
      h.ctx.cfg.keepUpdated = true;
    }
  });
});

describe('push subscriptions', () => {
  it('gives the VAPID public key, made once and kept with mode 600', async () => {
    const a = (await request(h.app).get('/api/push/key').expect(200)).body.key;
    expect(a).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect((await request(h.app).get('/api/push/key').expect(200)).body.key).toBe(a);
    const file = path.join(h.ctx.cfg.dataDir, 'vapid.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).publicKey).toBe(a);
  });

  it('only for a phone that turned Keep me updated on, and only to a push service', async () => {
    const other = phone(h, 'no-keep');
    await other.selfie(event.slug, await makeSelfie(PERSON.blue)).expect(200);
    expect((await other.post(`/api/e/${event.slug}/push`).send(SUB(9)).expect(409)).body).toMatchObject({ error: 'keep_off_for_you', message: 'Turn on Keep me updated first.' });
    for (const bad of [
      { ...SUB(1), endpoint: 'http://fcm.googleapis.com/fcm/send/x' },
      { ...SUB(1), endpoint: 'https://127.0.0.1/push' },
      { ...SUB(1), endpoint: 'https://evil.example/push' },
      { ...SUB(1), endpoint: `https://fcm.googleapis.com/${'x'.repeat(1001)}` },
      { endpoint: SUB(1).endpoint, keys: { p256dh: 'x'.repeat(201), auth: 'a' } },
      { endpoint: SUB(1).endpoint },
    ]) {
      expect((await red().post(`/api/e/${event.slug}/push`).send(bad).expect(400)).body.error).toBe('invalid_input');
    }
    await red().post(`/api/e/${event.slug}/push`).send(SUB(1)).expect(201);
    await red().post(`/api/e/${event.slug}/push`).send(SUB(1)).expect(201); // the same again: one row
    expect((await red().get(`/api/e/${event.slug}/mine`).expect(200)).body.keep.push).toBe(true);
    const g = await guestRow(red().token);
    expect((await h.ctx.db.query(`select count(*)::int as n from push_subscriptions where guest_id = $1`, [g.id])).rows[0].n).toBe(1);
  });

  it('keeps at most 5 per phone (the oldest go), and DELETE removes one', async () => {
    const g = await guestRow(red().token);
    for (let i = 2; i <= 7; i++) await red().post(`/api/e/${event.slug}/push`).send(SUB(i)).expect(201);
    let rows = (await h.ctx.db.query(`select endpoint from push_subscriptions where guest_id = $1 order by endpoint`, [g.id])).rows.map((r) => r.endpoint);
    expect(rows).toHaveLength(5);
    expect(rows).not.toContain(SUB(1).endpoint);
    expect(rows).not.toContain(SUB(2).endpoint);
    for (let i = 3; i <= 6; i++) await red().del(`/api/e/${event.slug}/push`).send({ endpoint: SUB(i).endpoint }).expect(200);
    rows = (await h.ctx.db.query(`select endpoint from push_subscriptions where guest_id = $1`, [g.id])).rows.map((r) => r.endpoint);
    expect(rows).toEqual([SUB(7).endpoint]);
  });
});

describe('new photos', () => {
  it('a sync of new photos adds the sure matches as new, and tells the phone once', async () => {
    const plain = phone(h, 'red-no-keep');
    await plain.selfie(event.slug, await makeSelfie(PERSON.red)).expect(200);
    h.put(FOLDER, 'IMG_0003.jpg', await makePhoto(3, [{ person: PERSON.red }]));
    h.put(FOLDER, 'IMG_0004.jpg', await makePhoto(4, [{ person: PERSON.green }]));
    h.put(FOLDER, 'IMG_0005.jpg', await makePhoto(5, [{ person: PERSON.red, dim: true }])); // a "maybe": not added
    await syncNow(h, event.id);
    await settle(h);

    const mine = (await red().get(`/api/e/${event.slug}/mine`).expect(200)).body;
    expect(mine.sure).toHaveLength(2);
    expect(mine.maybe).toHaveLength(0);
    expect(mine.fresh_count).toBe(1);
    const fresh = mine.sure.filter((p: any) => p.fresh);
    expect(fresh.map((p: any) => p.id)).toEqual([await mediaId('IMG_0003.jpg')]);
    // The home page and the event page say "1 new".
    const listed = (await red().get('/api/events').expect(200)).body.events.find((e: any) => e.slug === event.slug);
    expect(listed).toMatchObject({ mine: 2, mine_new: 1, face_ended: false });
    expect((await red().get(`/api/e/${event.slug}`).expect(200)).body.event).toMatchObject({ mine_new: 1, face_ended: false });
    // A phone that did not turn it on gets nothing new.
    const other = (await plain.get(`/api/e/${event.slug}/mine`).expect(200)).body;
    expect(other.sure).toHaveLength(1);
    expect(other.fresh_count).toBe(0);
    expect((await plain.get('/api/events').expect(200)).body.events.find((e: any) => e.slug === event.slug).mine_new).toBe(0);

    sent.length = 0;
    await flushPushes(h.ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].sub).toEqual({ endpoint: SUB(7).endpoint, keys: { p256dh: 'p256-7', auth: 'auth-7' } });
    expect(sent[0].payload).toEqual({
      title: 'Event Photos',
      body: "1 new photo of you at Freshers' Day",
      url: `/e/${event.slug}/mine`,
      tag: `ep-new-${event.slug}`,
      count: 1,
      event: TITLE,
    });
    await flushPushes(h.ctx);
    expect(sent).toHaveLength(1); // nothing queued twice
  });

  it('never adds over an existing row: "Not me" stays, and the same photo again adds nothing', async () => {
    const id = await mediaId('IMG_0003.jpg');
    await red().post(`/api/e/${event.slug}/mine/${id}/not-me`).expect(200);
    await matchNewMedia(h.ctx, [id, await mediaId('IMG_0001.jpg')]);
    const g = await guestRow(red().token);
    const row = (await h.ctx.db.query(`select not_me from matches where guest_id = $1 and media_id = $2`, [g.id, id])).rows[0];
    expect(row.not_me).toBe(true);
    expect(await freshCount(h.ctx.db, g.id)).toBe(0);
    const mine = (await red().get(`/api/e/${event.slug}/mine`).expect(200)).body;
    expect(mine.sure.map((p: any) => p.id)).not.toContain(id);
    sent.length = 0;
    await flushPushes(h.ctx);
    expect(sent).toHaveLength(0);
  });

  it("a student's upload is matched when it is approved, not before", async () => {
    const up = (await phone(h, 'uploader').upload(event.slug, await makePhoto(6, [{ person: PERSON.red }])).expect(201)).body;
    await settle(h);
    const g = await guestRow(red().token);
    expect(await freshCount(h.ctx.db, g.id)).toBe(0); // waiting for approval: not shown, not matched
    const waiting = (await h.ctx.db.query(`select id from media where event_id = $1 and review = 'pending'`, [event.id])).rows;
    expect(waiting).toHaveLength(1);
    expect(up.result).toBe('added');
    await h.admin.patch('/api/admin/media').send({ ids: [waiting[0].id], action: 'approve' }).expect(200);
    expect(await freshCount(h.ctx.db, g.id)).toBe(1);
    sent.length = 0;
    await flushPushes(h.ctx);
    expect(sent.map((s) => s.payload.body)).toEqual(["1 new photo of you at Freshers' Day"]);
  });

  it('My prints seen: the "new" marks go', async () => {
    await red().post(`/api/e/${event.slug}/mine/seen`).expect(200, { ok: true });
    const mine = (await red().get(`/api/e/${event.slug}/mine`).expect(200)).body;
    expect(mine.fresh_count).toBe(0);
    expect(mine.sure.every((p: any) => p.fresh === false)).toBe(true);
    expect((await red().get('/api/events').expect(200)).body.events.find((e: any) => e.slug === event.slug).mine_new).toBe(0);
  });

  it('a push service that says the subscription is gone: it is deleted; other failures count to 5', async () => {
    const g = await guestRow(red().token);
    await h.ctx.db.query(`update matches set fresh = true where guest_id = $1 and not not_me`, [g.id]);
    answer = 500;
    for (let i = 1; i <= 4; i++) {
      queueNewPhotos(h.ctx, g.id);
      await flushPushes(h.ctx);
      expect((await h.ctx.db.query(`select failures from push_subscriptions where guest_id = $1`, [g.id])).rows[0].failures).toBe(i);
    }
    answer = 201;
    queueNewPhotos(h.ctx, g.id);
    await flushPushes(h.ctx);
    const after = (await h.ctx.db.query(`select failures, last_sent_at from push_subscriptions where guest_id = $1`, [g.id])).rows[0];
    expect(after.failures).toBe(0);
    expect(after.last_sent_at).toBeInstanceOf(Date);
    expect(sent.at(-1)!.payload.body).toBe("2 new photos of you at Freshers' Day");

    answer = 410;
    queueNewPhotos(h.ctx, g.id);
    await flushPushes(h.ctx);
    expect((await h.ctx.db.query(`select count(*)::int as n from push_subscriptions where guest_id = $1`, [g.id])).rows[0].n).toBe(0);
    await red().post(`/api/e/${event.slug}/mine/seen`).expect(200);
  });

  it('nothing new or no subscription: nothing is sent', async () => {
    const g = await guestRow(red().token);
    sent.length = 0;
    queueNewPhotos(h.ctx, g.id); // no subscription left
    await flushPushes(h.ctx);
    await red().post(`/api/e/${event.slug}/push`).send(SUB(8)).expect(201);
    queueNewPhotos(h.ctx, g.id); // a subscription, but nothing new
    await flushPushes(h.ctx);
    expect(sent).toHaveLength(0);
  });

  it('waits 2 minutes after the last new photo, and at most 10 minutes after the first', async () => {
    const g = await guestRow(red().token);
    await h.ctx.db.query(`update matches set fresh = true where guest_id = $1 and not not_me`, [g.id]);
    sent.length = 0;
    const t0 = 1_000_000;
    queueNewPhotos(h.ctx, g.id, t0);
    expect(await sendDue(h.ctx, t0 + PUSH_DELAY_MS - 1)).toBe(0);
    queueNewPhotos(h.ctx, g.id, t0 + 60_000); // more arrive: it waits again
    expect(await sendDue(h.ctx, t0 + PUSH_DELAY_MS + 1000)).toBe(0);
    expect(await sendDue(h.ctx, t0 + 60_000 + PUSH_DELAY_MS)).toBe(1);
    expect(sent).toHaveLength(1);

    // New photos keep coming every minute: still sent 10 minutes after the first.
    for (let t = t0; t < t0 + PUSH_MAX_WAIT_MS; t += 60_000) {
      queueNewPhotos(h.ctx, g.id, t);
      expect(await sendDue(h.ctx, t)).toBe(0);
    }
    expect(await sendDue(h.ctx, t0 + PUSH_MAX_WAIT_MS)).toBe(1);
    expect(sent).toHaveLength(2);
    await red().post(`/api/e/${event.slug}/mine/seen`).expect(200);
  });

  it('the notification text', () => {
    expect(pushPayload(1, 'freshers', "Freshers' Day").body).toBe("1 new photo of you at Freshers' Day");
    expect(pushPayload(3, 'freshers', "Freshers' Day")).toMatchObject({ body: "3 new photos of you at Freshers' Day", count: 3, tag: 'ep-new-freshers', url: '/e/freshers/mine' });
  });
});

describe('turning it off', () => {
  it('one tap: the vector and the subscriptions go, the results stay', async () => {
    const before = (await red().get(`/api/e/${event.slug}/mine`).expect(200)).body.sure.length;
    const res = (await red().del(`/api/e/${event.slug}/keep`).expect(200)).body;
    expect(res.keep).toEqual({ available: true, on: false, push: false, consent_version: 'k1' });
    const g = await guestRow(red().token);
    expect(g.embedding).toBeNull();
    expect(g.keep_updated).toBe(false);
    expect(g.keep_model).toBeNull();
    expect((await h.ctx.db.query(`select count(*)::int as n from push_subscriptions where guest_id = $1`, [g.id])).rows[0].n).toBe(0);
    expect((await red().get(`/api/e/${event.slug}/mine`).expect(200)).body.sure).toHaveLength(before);
    await red().del(`/api/e/${event.slug}/keep`).expect(200); // again: fine

    // New photos of them are no longer matched.
    h.put(FOLDER, 'IMG_0007.jpg', await makePhoto(7, [{ person: PERSON.red }]));
    await syncNow(h, event.id);
    await settle(h);
    expect(await freshCount(h.ctx.db, g.id)).toBe(0);
    expect((await red().get(`/api/e/${event.slug}/mine`).expect(200)).body.sure).toHaveLength(before);
  });

  it('Delete my results deletes the vector with everything else', async () => {
    await keepOn(red(), await makeSelfie(PERSON.red)).expect(200);
    await red().post(`/api/e/${event.slug}/push`).send(SUB(1)).expect(201);
    const g = await guestRow(red().token);
    await red().del(`/api/e/${event.slug}/me`).expect(200);
    expect((await h.ctx.db.query(`select count(*)::int as n from guests where id = $1`, [g.id])).rows[0].n).toBe(0);
    expect((await h.ctx.db.query(`select count(*)::int as n from push_subscriptions where guest_id = $1`, [g.id])).rows[0].n).toBe(0);
    expect((await h.ctx.db.query(`select count(*)::int as n from guests where event_id = $1 and embedding is not null`, [event.id])).rows[0].n).toBe(0);
  });

  it('turning it on is limited to 10 times in 10 minutes per phone', async () => {
    const p = phone(h, 'many-taps');
    const selfie = await makeSelfie(PERSON.green);
    await p.selfie(event.slug, selfie).expect(200);
    for (let i = 0; i < 10; i++) await keepOn(p, selfie).expect(200);
    expect((await keepOn(p, selfie).expect(429)).body).toMatchObject({ error: 'slow_down', message: 'Try again in a few minutes.' });
  });
});

describe('races with the face data going', () => {
  it('a vector is not kept when the face data was deleted while the selfie was read', async () => {
    const p = phone(h, 'late-keeper');
    await p.selfie(event.slug, await makeSelfie(PERSON.blue)).expect(200);
    const g = await guestRow(p.token);
    const v = new Float32Array(128);
    v[PERSON.blue] = 1;
    await h.ctx.db.query(`update events set face_deleted_at = now() where id = $1`, [event.id]);
    try {
      expect(await keepVector(h.ctx, g.id, v)).toBe(false);
    } finally {
      await h.ctx.db.query(`update events set face_deleted_at = null where id = $1`, [event.id]);
    }
    const after = await guestRow(p.token);
    expect(after.embedding).toBeNull();
    expect(after.keep_updated).toBe(false);
    expect(await keepVector(h.ctx, g.id, v)).toBe(true); // and it works while face search is on
    await p.del(`/api/e/${event.slug}/keep`).expect(200);
  });

  it('no subscription is saved for a phone that has Keep me updated off', async () => {
    const p = phone(h, 'late-keeper');
    const g = await guestRow(p.token);
    expect(await saveSubscription(h.ctx.db, g.id, SUB(42))).toBe(false);
    expect((await h.ctx.db.query(`select count(*)::int as n from push_subscriptions where guest_id = $1`, [g.id])).rows[0].n).toBe(0);
  });
});
