import fs from 'node:fs';
import path from 'node:path';
import { generateVAPIDKeys, sendNotification, WebPushError } from 'web-push';
import type { Config } from '../config.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db/index.js';
import { freshCount } from './keep-updated.js';

/**
 * Web Push for Keep me updated (feature E, contract: bigger-contract.md). Owner: server-public.
 *
 * The VAPID key pair comes from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or is made once and kept in DATA_DIR/vapid.json
 * (mode 600), as dev-secret and the JWT key are. New matches are announced per guest a little after the last one
 * arrived (a sync finds many at once): "N new photos of you at <event>", opening /e/<slug>/mine.
 */

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** What the service worker receives (web/public/sw.js shows it). */
export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap goes: /e/<slug>/mine */
  url: string;
  /** One notification per event: a newer one replaces it. ep-new-<slug> */
  tag: string;
  count: number;
  event: string;
}

/** A subscription as PushSubscription.toJSON() gives it in the browser. */
export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Sends one push. The real one is web-push's sendNotification; tests put in their own (setPushSender). */
export type PushSender = (sub: BrowserSubscription, payload: string, vapid: VapidKeys) => Promise<{ statusCode: number }>;

/** A push goes this long after the last new match of a guest (a sync finds many at once)... */
export const PUSH_DELAY_MS = 120_000;
/** ...but never later than this after the first one. */
export const PUSH_MAX_WAIT_MS = 600_000;
/** How long the push service keeps a push for a phone that is off (seconds). */
const PUSH_TTL_S = 24 * 60 * 60;
/** Failed sends in a row (other than "gone") after which a subscription is dropped. */
const MAX_FAILURES = 5;
/** Subscriptions kept per guest (the oldest go). */
const MAX_SUBS_PER_GUEST = 5;

/** The real sender: web-push. An answer other than 2xx comes back as its status code. */
const webPushSender: PushSender = async (sub, payload, vapid) => {
  try {
    const r = await sendNotification(sub, payload, {
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: PUSH_TTL_S,
      urgency: 'normal',
      timeout: 15_000,
    });
    return { statusCode: r.statusCode };
  } catch (e) {
    if (e instanceof WebPushError) return { statusCode: e.statusCode };
    throw e;
  }
};
let sender: PushSender = webPushSender;

/** Tests: replace how pushes are sent (null = web-push again). */
export function setPushSender(fn: PushSender | null): void {
  sender = fn ?? webPushSender;
}

const loaded = new Map<string, VapidKeys>();

/** The VAPID keys: from the settings, else made once and kept in DATA_DIR/vapid.json. */
export function loadVapid(cfg: Pick<Config, 'vapid' | 'dataDir'>): VapidKeys {
  if (cfg.vapid.publicKey && cfg.vapid.privateKey) return cfg.vapid;
  const have = loaded.get(cfg.dataDir);
  if (have) return { ...have, subject: cfg.vapid.subject };
  const file = path.join(cfg.dataDir, 'vapid.json');
  let keys: { publicKey: string; privateKey: string } | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof j.publicKey === 'string' && typeof j.privateKey === 'string') keys = { publicKey: j.publicKey, privateKey: j.privateKey };
  } catch {
    /* not made yet */
  }
  if (!keys) {
    keys = generateVAPIDKeys();
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  }
  const out = { ...keys, subject: cfg.vapid.subject };
  loaded.set(cfg.dataDir, out);
  return out;
}

/**
 * Save (or refresh) a phone's subscription for one guest. Only while the guest has Keep me updated on (the guest row
 * is locked for share, so turning it off at the same moment cannot leave a subscription behind). Returns false when
 * nothing was saved.
 */
export async function saveSubscription(q: Queryable, guestId: string, sub: BrowserSubscription): Promise<boolean> {
  const saved = await q.query(
    `insert into push_subscriptions (guest_id, endpoint, p256dh, auth)
     select $1, $2, $3, $4
      where exists (select 1 from guests g where g.id = $1 and g.keep_updated and g.embedding is not null for share)
     on conflict (guest_id, endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, failures = 0, created_at = now()`,
    [guestId, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
  );
  if (!saved.rowCount) return false;
  // At most a few per guest: the oldest go.
  await q.query(
    `delete from push_subscriptions where guest_id = $1 and id not in (
       select id from push_subscriptions where guest_id = $1 order by created_at desc, id limit $2)`,
    [guestId, MAX_SUBS_PER_GUEST],
  );
  return true;
}

/** Remove a guest's subscriptions (all, or the one with this endpoint). */
export async function removeSubscriptions(q: Queryable, guestId: string, endpoint?: string): Promise<void> {
  if (endpoint) await q.query(`delete from push_subscriptions where guest_id = $1 and endpoint = $2`, [guestId, endpoint]);
  else await q.query(`delete from push_subscriptions where guest_id = $1`, [guestId]);
}

// ---- the queue: one push per guest a little after their last new match ------------------------------------------

interface Waiting {
  /** When the first and the last note for this guest came (ms). */
  first: number;
  last: number;
}

interface PushState {
  waiting: Map<string, Waiting>;
  timer: NodeJS.Timeout | null;
  /** startPush was called (the timer runs); without it pushes wait for flushPushes (tests). */
  running: boolean;
  /** Sends being handed to the push services right now. */
  inflight: Set<Promise<void>>;
}

const states = new WeakMap<Ctx, PushState>();

function stateOf(ctx: Ctx): PushState {
  let s = states.get(ctx);
  if (!s) {
    s = { waiting: new Map(), timer: null, running: false, inflight: new Set() };
    states.set(ctx, s);
  }
  return s;
}

const dueAt = (w: Waiting) => Math.min(w.last + PUSH_DELAY_MS, w.first + PUSH_MAX_WAIT_MS);

function schedule(ctx: Ctx, s: PushState): void {
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  if (!s.running || !s.waiting.size) return;
  const next = Math.min(...[...s.waiting.values()].map(dueAt));
  s.timer = setTimeout(() => {
    s.timer = null;
    void sendDue(ctx, Date.now()).finally(() => schedule(ctx, s));
  }, Math.max(0, next - Date.now()));
  s.timer.unref?.();
}

/**
 * Note that a guest got new matches: a push is sent to their subscriptions a little later (PUSH_DELAY_MS after the
 * last note, at most PUSH_MAX_WAIT_MS after the first), counting their fresh matches at that moment. No subscription:
 * nothing is sent (the phone sees "N new" on its next visit).
 */
export function queueNewPhotos(ctx: Ctx, guestId: string, now = Date.now()): void {
  const s = stateOf(ctx);
  const w = s.waiting.get(guestId);
  s.waiting.set(guestId, w ? { first: w.first, last: now } : { first: now, last: now });
  schedule(ctx, s);
}

/** Send the pushes whose time has come (`now` in ms). Exported for tests. */
export async function sendDue(ctx: Ctx, now: number): Promise<number> {
  const s = stateOf(ctx);
  const due = [...s.waiting].filter(([, w]) => dueAt(w) <= now).map(([g]) => g);
  for (const g of due) s.waiting.delete(g);
  await sendTo(ctx, s, due);
  return due.length;
}

/** Send the pushes queued now (tests, and on stop). Resolves when they have been handed to the push services. */
export async function flushPushes(ctx: Ctx): Promise<void> {
  const s = stateOf(ctx);
  const all = [...s.waiting.keys()];
  s.waiting.clear();
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  await sendTo(ctx, s, all);
  await Promise.allSettled([...s.inflight]);
}

/** Start the push sender (index.ts). Returns stop: what is queued is sent first. */
export function startPush(ctx: Ctx): () => Promise<void> {
  const s = stateOf(ctx);
  s.running = true;
  schedule(ctx, s);
  return async () => {
    s.running = false;
    await flushPushes(ctx);
  };
}

async function sendTo(ctx: Ctx, s: PushState, guests: string[]): Promise<void> {
  if (!guests.length) return;
  const run = (async () => {
    for (const g of guests) {
      try {
        await sendOne(ctx, g);
      } catch (e) {
        ctx.log(`Keep me updated: a notification could not be sent: ${(e as Error).message}`);
      }
    }
  })();
  s.inflight.add(run);
  try {
    await run;
  } finally {
    s.inflight.delete(run);
  }
}

/** The text of the notification: "1 new photo of you at Freshers' Day", "3 new photos of you at Freshers' Day". */
export function pushPayload(count: number, slug: string, title: string): PushPayload {
  return {
    title: 'Event Photos',
    body: `${count} new ${count === 1 ? 'photo' : 'photos'} of you at ${title}`,
    url: `/e/${slug}/mine`,
    tag: `ep-new-${slug}`,
    count,
    event: title,
  };
}

async function sendOne(ctx: Ctx, guestId: string): Promise<void> {
  const { db } = ctx;
  const subs = (
    await db.query<{ id: string; endpoint: string; p256dh: string; auth: string; slug: string; title: string }>(
      `select s.id, s.endpoint, s.p256dh, s.auth, e.slug, e.title
         from push_subscriptions s join guests g on g.id = s.guest_id join events e on e.id = g.event_id
        where s.guest_id = $1 and g.keep_updated and e.status in ('live', 'closed') and e.face_deleted_at is null`,
      [guestId],
    )
  ).rows;
  if (!subs.length) return;
  const n = await freshCount(db, guestId);
  if (n <= 0) return;
  const payload = JSON.stringify(pushPayload(n, subs[0].slug, subs[0].title));
  const vapid = loadVapid(ctx.cfg);
  for (const sub of subs) {
    let status = 0;
    try {
      status = (await sender({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, vapid)).statusCode;
    } catch (e) {
      ctx.log(`Keep me updated: a push service did not answer: ${(e as Error).message}`);
    }
    if (status >= 200 && status < 300) {
      await db.query(`update push_subscriptions set last_sent_at = now(), failures = 0 where id = $1`, [sub.id]);
    } else if (status === 404 || status === 410) {
      // The phone unsubscribed (or the browser was reset): this subscription is gone for good.
      await db.query(`delete from push_subscriptions where id = $1`, [sub.id]);
    } else {
      await db.query(`update push_subscriptions set failures = failures + 1 where id = $1`, [sub.id]);
      await db.query(`delete from push_subscriptions where id = $1 and failures >= $2`, [sub.id, MAX_FAILURES]);
    }
  }
}
