import type { Ctx } from '../context.js';
import { DriveBusyError, DriveNotFoundError } from '../drive/types.js';
import { Queue } from '../lib/queue.js';
import { COLUMN, isDriveKey, itemOf, track, type CopyKind } from './copies.js';

/**
 * Short-lived OneDrive download links for the album's copies (the image route redirects to them).
 *
 *   - Redis cu:<item id> -> {"u": link, "x": expires at}, kept until DRIVE_URL_MARGIN_MIN (20) minutes before the link
 *     ends: a link is handed out only while at least that much of it is left, and a browser keeps the redirect for 5
 *     minutes at most, so it is always followed while the link still works.
 *   - one Graph call per item at a time (single flight), at most 8 lookups at once for requests (urlLookups)
 *   - warmFolder: one listing of a copies folder (999 a page) fills the links of a whole album at once
 *   - Redis down: an in-process cache of 5 000 links with the same rule
 *   - OneDrive limiting requests (429): drive:throttled is set for its Retry-After, and requests that are not cached
 *     get a quick "try again" instead of waiting
 */

interface Cached {
  u: string;
  x: number;
}
const MEM_MAX = 5000;
const mem = new Map<string, Cached>();
const memFlags = new Map<string, { v: string; until: number }>();
const inflight = new Map<string, Promise<string>>();
/** Request-path lookups at the same moment. */
const urlLookups = new Queue(8);
/**
 * Listings of a copies folder running in this process (`<prefix><event>:<kind>`): resolves once the links of that
 * listing are in the cache. An album's 50 to 100 image requests that arrive while it runs wait for it (at most
 * WARM_WAIT_MS) instead of each making a Graph call of its own.
 */
const warming = new Map<string, Promise<void>>();
const WARM_WAIT_MS = 5000;
const warmKey = (ctx: Ctx, eventId: string, kind: CopyKind) => `${ctx.cfg.redisPrefix}${eventId}:${kind}`;

const marginMs = (ctx: Ctx) => ctx.cfg.driveUrlMarginMin * 60_000;
/** Tests: move the clock used for the margin rule. */
let clock = () => Date.now();
export function setUrlClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

function memSet(id: string, c: Cached): void {
  mem.delete(id);
  mem.set(id, c);
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value!);
}

// ---- flags (drive:throttled, drive:down), with an in-process fallback when Redis is down ---------------
export async function setFlag(ctx: Ctx, name: string, ms: number, value = '1'): Promise<void> {
  memFlags.set(`${ctx.cfg.redisPrefix}${name}`, { v: value, until: Date.now() + ms });
  await ctx.redis.set(name, value, 'PX', Math.max(1, Math.round(ms))).catch(() => {});
}
export async function getFlag(ctx: Ctx, name: string): Promise<string | null> {
  try {
    return await ctx.redis.get(name);
  } catch {
    const f = memFlags.get(`${ctx.cfg.redisPrefix}${name}`);
    return f && f.until > Date.now() ? f.v : null;
  }
}
export async function hasFlag(ctx: Ctx, name: string): Promise<boolean> {
  return (await getFlag(ctx, name)) !== null;
}
export async function clearFlag(ctx: Ctx, name: string): Promise<void> {
  memFlags.delete(`${ctx.cfg.redisPrefix}${name}`);
  await ctx.redis.del(name).catch(() => {});
}

/** OneDrive is limiting requests: remember it for its Retry-After (at least 5 s). */
export async function markThrottled(ctx: Ctx, e: DriveBusyError): Promise<void> {
  await setFlag(ctx, 'drive:throttled', Math.max(5000, e.retryAfterMs));
}

/**
 * OneDrive could not give a photo just now: remembered for a minute (the album says "Photos can't be loaded right
 * now"), with the moment it started, for the images_unavailable alert.
 */
export async function markDown(ctx: Ctx): Promise<void> {
  const since = (await getFlag(ctx, 'drive:down')) ?? String(Date.now());
  await setFlag(ctx, 'drive:down', 60_000, since);
}
export async function downSince(ctx: Ctx): Promise<number | null> {
  const v = await getFlag(ctx, 'drive:down');
  return v ? Number(v) || Date.now() : null;
}

// ---- the cache ----------------------------------------------------------------------------------------
async function cached(ctx: Ctx, id: string): Promise<string | null> {
  const now = clock();
  let c: Cached | null = null;
  try {
    const raw = await ctx.redis.get(`cu:${id}`);
    c = raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    c = mem.get(id) ?? null;
  }
  if (!c || c.x - now <= marginMs(ctx)) return null;
  return c.u;
}

async function store(ctx: Ctx, entries: { id: string; u: string; x: number }[]): Promise<void> {
  const now = clock();
  const keep = entries.filter((e) => e.x - now > marginMs(ctx));
  if (!keep.length) return;
  for (const e of keep) memSet(e.id, { u: e.u, x: e.x });
  try {
    const p = ctx.redis.pipeline();
    for (const e of keep) p.set(`cu:${e.id}`, JSON.stringify({ u: e.u, x: e.x }), 'PX', Math.max(1, e.x - now - marginMs(ctx)));
    await p.exec();
  } catch {
    /* Redis down: the in-process cache holds them */
  }
}

/** Forget links (a copy was hidden, rejected, removed or replaced): the next request looks it up again. */
export async function purgeUrls(ctx: Ctx, itemIds: string[]): Promise<void> {
  if (!itemIds.length) return;
  for (const id of itemIds) mem.delete(id);
  await ctx.redis.del(...itemIds.map((id) => `cu:${id}`)).catch(() => {});
}

/** The links of these keys, forgotten (for a photo just hidden or rejected). */
export async function purgeKeys(ctx: Ctx, keys: (string | null | undefined)[]): Promise<void> {
  await purgeUrls(ctx, keys.filter(isDriveKey).map(itemOf));
}

/**
 * A working download link for one copy. From the cache when it has one with enough life left; else a listing of the
 * copies folder fills the whole album (t, w, s), or one lookup. Throws DriveBusyError at once while OneDrive is
 * limiting requests, DriveNotFoundError when the copy is gone.
 */
export async function copyUrl(ctx: Ctx, key: string, opts: { eventId?: string; kind?: CopyKind } = {}): Promise<string> {
  const id = itemOf(key);
  const hit = await cached(ctx, id);
  if (hit) return hit;
  let job = inflight.get(id);
  if (!job) {
    job = (async () => {
      if (await hasFlag(ctx, 'drive:throttled')) throw new DriveBusyError(5000);
      try {
        if (opts.eventId && opts.kind && (opts.kind === 't' || opts.kind === 'w' || opts.kind === 's')) {
          // One listing for the whole album: started here if none is running, waited for if one is.
          if (!warming.has(warmKey(ctx, opts.eventId, opts.kind))) void track(ctx, warmFolder(ctx, opts.eventId, opts.kind)).catch(() => {});
          const listing = warming.get(warmKey(ctx, opts.eventId, opts.kind));
          if (listing) {
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([listing, new Promise<void>((r) => (timer = setTimeout(r, WARM_WAIT_MS)))]);
            clearTimeout(timer);
          }
          const warm = await cached(ctx, id);
          if (warm) return warm;
          if (await hasFlag(ctx, 'drive:throttled')) throw new DriveBusyError(5000); // the listing itself was told to wait
        }
        const e = await urlLookups.push(() => ctx.drive.item(id, { patient: false }));
        if (!e.url) throw new Error('OneDrive did not give a download link for this copy.');
        await store(ctx, [{ id, u: e.url, x: e.urlExpiresAt ?? clock() + ctx.cfg.driveUrlLifeMin * 60_000 }]);
        return e.url;
      } catch (e) {
        if (e instanceof DriveBusyError) await markThrottled(ctx, e);
        throw e;
      }
    })().finally(() => inflight.delete(id));
    inflight.set(id, job);
  }
  return job;
}

/**
 * Fill the link cache for one copies folder of an event with one listing (999 a page), at most once per margin
 * (20 minutes). Copies of the event that the listing does not have, and that are really gone, are marked
 * copies_missing for the rebuild job (someone deleted them in OneDrive).
 */
export function warmFolder(ctx: Ctx, eventId: string, kind: CopyKind): Promise<number> {
  const k = warmKey(ctx, eventId, kind);
  const running = warming.get(k);
  if (running) return running.then(() => 0);
  let listed!: () => void;
  warming.set(k, new Promise<void>((r) => (listed = r)));
  return warmFolderNow(ctx, eventId, kind, listed).finally(() => {
    listed();
    warming.delete(k);
  });
}

async function warmFolderNow(ctx: Ctx, eventId: string, kind: CopyKind, listed: () => void): Promise<number> {
  const row = (await ctx.db.query<{ copies_folders: Record<string, string> }>(`select copies_folders from events where id = $1`, [eventId])).rows[0];
  const folderId = row?.copies_folders?.[kind];
  if (!folderId) return 0;
  let first = true;
  try {
    first = (await ctx.redis.set(`cuw:${folderId}`, '1', 'EX', Math.max(1, Math.round(marginMs(ctx) / 1000)), 'NX')) === 'OK';
  } catch {
    first = true;
  }
  if (!first) return 0;
  let files;
  try {
    files = (await ctx.drive.children(folderId, 999, { urls: true, patient: false })).filter((f) => !f.isFolder);
  } catch (e) {
    await ctx.redis.del(`cuw:${folderId}`).catch(() => {});
    if (e instanceof DriveBusyError) await markThrottled(ctx, e);
    if (e instanceof DriveNotFoundError) {
      // The folder itself is gone: every copy of this kind is missing.
      if (kind !== 'full') await ctx.db.query(`update media set copies_missing = true where event_id = $1 and ${COLUMN[kind]} like 'od/%'`, [eventId]);
      await ctx.db.query(`update events set copies_folders = '{}'::jsonb where id = $1`, [eventId]);
      return 0;
    }
    throw e;
  }
  const now = clock();
  await store(
    ctx,
    files.filter((f) => f.url).map((f) => ({ id: f.id, u: f.url!, x: f.urlExpiresAt ?? now + ctx.cfg.driveUrlLifeMin * 60_000 })),
  );
  listed(); // the requests waiting for this listing go on now; the look for missing copies below takes longer
  if (kind !== 'full') {
    const listed = new Set(files.map((f) => f.id));
    const col = COLUMN[kind];
    const rows = (
      await ctx.db.query<{ id: string; k: string }>(`select id, ${col} as k from media where event_id = $1 and ${col} like 'od/%' and not copies_missing`, [eventId])
    ).rows.filter((r) => !listed.has(itemOf(r.k)));
    // Looked up one by one before anything is marked (a copy made after the listing started is not missing).
    for (const r of rows.slice(0, 20)) {
      try {
        await ctx.drive.item(itemOf(r.k), { patient: false });
      } catch (e) {
        if (e instanceof DriveNotFoundError) await ctx.db.query(`update media set copies_missing = true where id = $1 and ${col} = $2`, [r.id, r.k]);
        else break;
      }
    }
  }
  return files.length;
}

/** warmFolder in the background (the album and results pages call it before answering). */
export function warmSoon(ctx: Ctx, eventId: string, kind: CopyKind): void {
  void track(ctx, warmFolder(ctx, eventId, kind)).catch(() => {});
}
