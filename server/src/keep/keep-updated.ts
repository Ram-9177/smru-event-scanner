import type { Ctx } from '../context.js';
import { toBuffer, type Queryable } from '../db/index.js';
import { VISIBLE } from '../db/schema.js';
import { bufferToVector, vectorToBuffer } from '../face/index.js';
import { queueNewPhotos } from './push.js';

/**
 * Keep me updated (feature E, contract: bigger-contract.md). Owner: server-public.
 *
 * Only after a student ticks "Tell me when new photos of me arrive" (its own consent, KEEP_CONSENT_VERSION) is the face
 * vector of their selfie kept: in guests.embedding, for that one event, with guests.keep_updated = true. New photos and
 * videos of the event that become visible are compared with the kept vectors (sure matches only, cfg.faceSure); new
 * matches go into the student's results with matches.fresh = true and are announced by Web Push (push.ts).
 * Turning it off, "Delete my results", face-data expiry and archiving delete the vector.
 */

/** The wording version of the Keep me updated consent (sent by the phone in the x-keep-consent header). */
export const KEEP_CONSENT_VERSION = 'k1';

const DIM = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keep this vector for the guest (the opt-in): guests.embedding, keep_updated = true, keep_consent_version,
 * keep_consent_at = now(), keep_model = ctx.face.model. Replaces an earlier kept vector.
 * Only while the guest's event is open with face search on and its face data not deleted: the event row is locked
 * (for share) while the vector is written, and read again afterwards, so a vector is never left behind by an expiry
 * or archive that ran while the selfie was being read. Returns false (and keeps nothing) otherwise.
 */
export async function keepVector(ctx: Ctx, guestId: string, vector: Float32Array): Promise<boolean> {
  const stillOpen = (q: Queryable) =>
    q.query(
      `select 1 from events e join guests g on g.event_id = e.id
        where g.id = $1 and e.face_deleted_at is null and e.face_enabled and e.status in ('live', 'closed')
        for share of e`,
      [guestId],
    );
  const kept = await ctx.db.tx(async (q) => {
    if (!(await stillOpen(q)).rows.length) return false;
    await q.query(
      `update guests set embedding = $2, keep_updated = true, keep_consent_version = $3, keep_consent_at = now(), keep_model = $4 where id = $1`,
      [guestId, vectorToBuffer(vector), KEEP_CONSENT_VERSION, ctx.face.model],
    );
    return true;
  });
  if (!kept) return false;
  // Face data deleted (or the event archived) at the same moment: the vector goes again at once.
  if (!(await ctx.db.tx(async (q) => (await stillOpen(q)).rows.length > 0))) {
    await stopKeeping(ctx.db, guestId);
    return false;
  }
  return true;
}

/**
 * Turn Keep me updated off for one guest: the vector goes (embedding = null, keep_updated = false, keep_model = null)
 * and so do the guest's push subscriptions. The results (matches) stay.
 */
export async function stopKeeping(q: Queryable, guestId: string): Promise<void> {
  await q.query(`update guests set embedding = null, keep_updated = false, keep_model = null where id = $1`, [guestId]);
  await q.query(`delete from push_subscriptions where guest_id = $1`, [guestId]);
}

/**
 * Every kept vector of one event goes (face-data expiry, archive). Used by ops/expiry.ts deleteFaceData.
 * Returns how many guests had one.
 */
export async function forgetEventKept(q: Queryable, eventId: string): Promise<number> {
  const n = (await q.query(`update guests set embedding = null, keep_updated = false, keep_model = null where event_id = $1 and (keep_updated or embedding is not null)`, [eventId])).rowCount;
  await q.query(`delete from push_subscriptions where guest_id in (select id from guests where event_id = $1)`, [eventId]);
  return n;
}

/**
 * Called from media/after.ts mediaChanged for every change that can make photos visible. For the ids (and the photos
 * shown in their place) that are VISIBLE and have faces: compare with the event's kept vectors, add sure matches the
 * guest does not have yet (fresh = true; never over an existing row, so "Not me" stays), and queue a push per guest
 * that got new ones (push.ts queueNewPhotos). Never throws (logs instead). Does nothing when cfg.keepUpdated is off.
 */
export async function matchNewMedia(ctx: Ctx, mediaIds: string[]): Promise<void> {
  if (!ctx.cfg.keepUpdated) return;
  const ids = [...new Set(mediaIds.filter((id) => typeof id === 'string' && UUID.test(id)))];
  if (!ids.length) return;
  try {
    for (const guestId of await findNewMatches(ctx, ids)) queueNewPhotos(ctx, guestId);
  } catch (e) {
    ctx.log(`Keep me updated: could not check ${ids.length} item(s) against kept faces: ${(e as Error).message}`);
  }
}

/** Adds the new sure matches; returns the guests that got at least one. */
async function findNewMatches(ctx: Ctx, mediaIds: string[]): Promise<Set<string>> {
  const { db, cfg } = ctx;
  const model = ctx.face.model;
  // The photos shown for these ids (a copy stands for the one shown in its place), visible now, in open events whose
  // face search is on and has not ended, where at least one student kept their face with this face model.
  const shown = (
    await db.query<{ id: string; event_id: string }>(
      `select distinct m.id, m.event_id
         from media o
         join media m on m.id = coalesce(o.duplicate_of, o.id)
         join events e on e.id = m.event_id
        where o.id = any($1::uuid[]) and ${VISIBLE}
          and e.face_deleted_at is null and e.face_enabled and e.status in ('live', 'closed')
          and exists (select 1 from guests g where g.event_id = m.event_id and g.keep_updated and g.embedding is not null and g.keep_model = $2)`,
      [mediaIds, model],
    )
  ).rows;
  const out = new Set<string>();
  const byEvent = new Map<string, string[]>();
  for (const r of shown) byEvent.set(r.event_id, [...(byEvent.get(r.event_id) ?? []), r.id]);
  for (const [eventId, ids] of byEvent) {
    const guests = (
      await db.query<{ id: string; embedding: Uint8Array }>(
        `select id, embedding from guests where event_id = $1 and keep_updated and embedding is not null and keep_model = $2`,
        [eventId, model],
      )
    ).rows
      .map((g) => ({ id: g.id, v: bufferToVector(toBuffer(g.embedding)!) }))
      .filter((g) => g.v.length === DIM);
    if (!guests.length) continue;
    const faces = (
      await db.query<{ media_id: string; embedding: Uint8Array; at_ms: number | null }>(
        `select media_id, embedding, at_ms from faces where media_id = any($1::uuid[]) and model = $2`,
        [ids, model],
      )
    ).rows
      .map((f) => ({ mediaId: f.media_id, v: bufferToVector(toBuffer(f.embedding)!), at: f.at_ms }))
      .filter((f) => f.v.length === DIM);
    if (!faces.length) continue;
    // The best face per (student, photo); only sure matches are added (the same line as a selfie search's sure tier).
    const rows: { guest: string; media: string; score: number; at: number | null }[] = [];
    for (const g of guests) {
      const best = new Map<string, { score: number; at: number | null }>();
      for (const f of faces) {
        let s = 0;
        for (let k = 0; k < DIM; k++) s += f.v[k] * g.v[k];
        if (s < cfg.faceSure) continue;
        if (s > (best.get(f.mediaId)?.score ?? -Infinity)) best.set(f.mediaId, { score: s, at: f.at });
      }
      for (const [media, b] of best) rows.push({ guest: g.id, media, score: b.score, at: b.at });
    }
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const params: unknown[] = [];
      const values = chunk.map((r, k) => {
        params.push(r.guest, r.media, r.score, r.at);
        return `($${k * 4 + 1}::uuid, $${k * 4 + 2}::uuid, $${k * 4 + 3}::real, $${k * 4 + 4}::int)`;
      });
      // Never over a row the student has already (so "Not me" stays), nor for a photo they already have through one
      // of its copies.
      const added = await db.query<{ guest_id: string }>(
        `insert into matches (guest_id, media_id, similarity, tier, at_ms, fresh)
         select v.g, v.m, v.s, 'sure', v.a, true
           from (values ${values.join(', ')}) as v(g, m, s, a)
          where not exists (
            select 1 from matches x join media o on o.id = x.media_id
             where x.guest_id = v.g and coalesce(o.duplicate_of, o.id) = v.m)
         on conflict (guest_id, media_id) do nothing
         returning guest_id`,
        params,
      );
      for (const r of added.rows) out.add(r.guest_id);
    }
  }
  return out;
}

/** How many fresh (not yet seen) visible sure matches a guest has. */
export async function freshCount(q: Queryable, guestId: string): Promise<number> {
  const r = await q.query<{ n: number }>(
    `select count(*)::int as n from (
       select m.id
         from matches mt
         join media o on o.id = mt.media_id
         join media m on m.id = coalesce(o.duplicate_of, o.id)
        where mt.guest_id = $1 and ${VISIBLE}
        group by m.id
       having bool_or(mt.fresh and mt.tier = 'sure') and not bool_or(mt.not_me)
     ) x`,
    [guestId],
  );
  return r.rows[0]?.n ?? 0;
}

/** The student has seen My prints: their fresh marks are cleared. */
export async function markSeen(q: Queryable, guestId: string): Promise<void> {
  await q.query(`update matches set fresh = false where guest_id = $1 and fresh`, [guestId]);
}
