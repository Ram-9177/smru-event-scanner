import { audit, type Ctx } from '../context.js';
import { forgetEventKept } from '../keep/keep-updated.js';
import { forgetIndex } from '../media/search.js';

/**
 * Face-data expiry and auto close (feature G, contract: bigger-contract.md). Owner: server-admin.
 *
 * Every hour (cfg.expiryEveryMin): Live events whose close_on day has come become Closed; events whose face_expiry_at
 * has passed lose every face vector of their photos and every kept student vector (deleteFaceData), keep their photos,
 * and get face_deleted_at. Both are written to the activity log as actor 'system'.
 */

/** The SQL that sets face_expiry_at from face_days and the event's last day (use in insert/update ... set). */
export const FACE_EXPIRY_SQL = `case when face_days is null then null else (coalesce(ends_on, starts_on, created_at::date) + face_days)::timestamptz end`;

export interface FaceDataDeleted {
  /** Face vectors of the event's photos and videos removed. */
  faces: number;
  /** Kept student vectors (Keep me updated) removed. */
  kept: number;
  /** Students' saved results removed (only with results: true). */
  results: number;
}

/**
 * Delete an event's face data: every row of faces for it, every kept student vector (and push subscription), and,
 * with results: true (archive), every phone's saved results too. Sets events.face_deleted_at (first time only).
 * The photos stay. The search index is dropped. Shared by archive (admin.ts), expiry (runExpiry) and
 * POST /api/admin/events/:id/face-data/delete.
 */
export async function deleteFaceData(ctx: Ctx, eventId: string, opts: { results?: boolean } = {}): Promise<FaceDataDeleted> {
  const out = await ctx.db.tx(async (q) => {
    const faces = (await q.query(`delete from faces where event_id = $1`, [eventId])).rowCount;
    const kept = await forgetEventKept(q, eventId);
    const results = opts.results ? (await q.query(`delete from matches where guest_id in (select id from guests where event_id = $1)`, [eventId])).rowCount : 0;
    await q.query(`update events set face_deleted_at = coalesce(face_deleted_at, now()) where id = $1`, [eventId]);
    return { faces, kept, results };
  });
  forgetIndex(eventId);
  ctx.bump(eventId);
  return out;
}

export interface ExpiryRun {
  /** Event ids closed because their close_on day came. */
  closed: string[];
  /** Event ids whose face data was deleted now. */
  expired: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * One run: close what is due, delete face data that is due (and faces that turned up again for an event whose face
 * data is already deleted). `now` is for tests.
 */
export async function runExpiry(ctx: Ctx, now: Date = new Date()): Promise<ExpiryRun> {
  const out: ExpiryRun = { closed: [], expired: [] };

  // 1. "Close the album automatically on": that morning a Live event becomes Closed (students still see the photos).
  const closing = (
    await ctx.db.query<{ id: string; title: string }>(
      `update events set status = 'closed' where status = 'live' and close_on is not null and close_on <= $1::date returning id, title`,
      [localDay(now)],
    )
  ).rows;
  for (const e of closing) {
    out.closed.push(e.id);
    ctx.bump(e.id);
    await audit(ctx, 'system', 'event.auto_close', e.id, { title: e.title });
  }

  // 2. Face data that is due: the vectors go, the photos (and the students' saved results) stay.
  const due = (await ctx.db.query<{ id: string; title: string }>(`select id, title from events where face_expiry_at <= $1 and face_deleted_at is null order by face_expiry_at, id`, [now])).rows;
  for (const e of due) {
    try {
      const d = await deleteFaceData(ctx, e.id);
      out.expired.push(e.id);
      await audit(ctx, 'system', 'event.face_expired', e.id, { title: e.title, faces: d.faces, kept: d.kept });
    } catch (err) {
      ctx.log(`face data of "${e.title}" could not be deleted yet: ${(err as Error).message}`);
    }
  }

  // 3. Faces that came back after the face data was deleted (a photo processed since, a re-read): they go too.
  const again = (
    await ctx.db.query<{ id: string }>(
      `select e.id from events e
        where e.face_deleted_at is not null
          and (exists (select 1 from faces f where f.event_id = e.id) or exists (select 1 from guests g where g.event_id = e.id and (g.keep_updated or g.embedding is not null)))`,
    )
  ).rows;
  for (const e of again) {
    await ctx.db.tx(async (q) => {
      await q.query(`delete from faces where event_id = $1`, [e.id]);
      await forgetEventKept(q, e.id);
    });
    forgetIndex(e.id);
    ctx.bump(e.id);
  }
  return out;
}

/** Start the hourly job (index.ts): a first run a minute after start. Returns stop. */
export function startExpiry(ctx: Ctx): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runExpiry(ctx);
      if (r.closed.length) ctx.log(`closed ${r.closed.length} event(s) on their close date`);
      if (r.expired.length) ctx.log(`deleted the face data of ${r.expired.length} event(s) as planned`);
    } catch (e) {
      ctx.log(`face data and auto close: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  let every: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    void tick();
    every = setInterval(() => void tick(), ctx.cfg.expiryEveryMin * 60_000);
    every.unref();
  }, 60_000);
  first.unref();
  return () => {
    clearTimeout(first);
    if (every) clearInterval(every);
  };
}
