import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { DriveNotFoundError } from '../drive/types.js';
import { freeBytes } from '../lib/receive.js';
import { Queue } from '../lib/queue.js';
import {
  copiesIdle,
  emptyCopyTrash,
  emptyCopyTrashSoon,
  forget,
  isDriveKey,
  isLegacyKey,
  itemOf,
  LOCAL_ITEM,
  legacyPath,
  putCopies,
  putPeopleRef,
  removeLegacy,
  stateOf,
  sweepOrphans,
  track,
  withOriginal,
  type CopyKind,
} from './copies.js';
import { clearFlag, hasFlag, purgeKeys, setFlag } from './copyurls.js';
import { legacySceneKey, sweepTempDir, tempPath } from './files.js';
import { dropFullCopies, removeLegacyFullDir } from './fullcopy.js';
import { displayCopy, prepare, sceneCopy } from './prepare.js';
import { lookToApply } from './process.js';
import { ORIGINAL_GONE } from './upgrade.js';
import { extOfName, makeCleanCopy, makePreview, poster, probeVideo } from './video.js';

/**
 * The rebuild job: every photo and video whose copies are not (all) in OneDrive gets them, from what is still on this
 * server (moved up as it is) or from its original in OneDrive. This is how an install moves from copies on the Mac to
 * copies in OneDrive, and how a copy deleted in OneDrive by hand comes back.
 *
 * Its state is only in the database (the keys themselves, copies_missing, copies_tries), so a restart resumes where
 * it stopped. Order: anything a student is waiting for right now (rebuild:hot, set by the image route), then display
 * copies before scene descriptions and download copies, live events before closed ones, and the album's own order.
 * Two at a time (REBUILD_AT_ONCE) and at most REBUILD_PER_MIN a minute, in a line of its own: syncs and uploads never
 * wait behind it. It pauses while OneDrive is down or limiting requests.
 */

/** Display copies (thumbnail, web copy, video preview) that are missing or still on this server. */
export const NEEDS_DISPLAY = `(m.copies_missing or m.thumb_key is null or m.thumb_key not like 'od/%'
  or (m.duplicate_of is null and (m.web_key is null or m.web_key not like 'od/%'))
  or (m.duplicate_of is null and m.type = 'video' and (m.video_key is null or m.video_key not like 'od/%')))`;

/** A media row (m, with its event e) whose copies need work. `graph`: keys made by the stand-in drive count as missing. */
export function needsCopiesSql(opts: { graph?: boolean; clean?: boolean } = {}): string {
  return `(m.status = 'ready' and m.review <> 'rejected' and not m.copies_lost and m.copies_tries < 3 and (${NEEDS_DISPLAY}
    or (m.duplicate_of is null and m.type = 'photo' and m.scene_key is null)
    ${opts.clean === false ? '' : `or (m.duplicate_of is null and m.type = 'video' and m.clean_key is null and m.clean_tries < 3 and e.status <> 'archived')`}
    ${opts.graph ? `or copy_item(m.thumb_key) ~ '^[0-9]+-[0-9]+$' or copy_item(m.web_key) ~ '^[0-9]+-[0-9]+$' or copy_item(m.video_key) ~ '^[0-9]+-[0-9]+$'` : ''}))`;
}
/** For counts (Settings, alerts). */
export const NEEDS_COPIES = needsCopiesSql();
const needsFor = (ctx: Ctx) => needsCopiesSql({ graph: ctx.drive.kind === 'graph', clean: ctx.cfg.cleanVideoCopies });

const STOPS = ['DriveDownError', 'DriveAuthError', 'DriveBusyError', 'DriveFullError', 'FaceDownError', 'VideoToolsError', 'NoRoomError'];
/** A pass stopped by one of these (OneDrive itself): kicks from student requests wait (rebuild:paused) instead of hitting it again. */
const DRIVE_STOPS = ['DriveDownError', 'DriveAuthError', 'DriveBusyError', 'DriveFullError'];
/** This many items failing one after the other stop a pass: something nobody planned for is wrong, not each item. */
const FAILS_IN_A_ROW = 5;
/** Items per round: the round's query is where items students are waiting for (rebuild:hot) move to the front. */
const ROUND = 20;
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const MAX_TRIES = 3;
const HOT_MAX = 500;
const HOT_AGE_MS = 60 * 60_000;

class NoRoomError extends Error {
  constructor() {
    super('This Mac has too little room right now to rebuild a video.');
    this.name = 'NoRoomError';
  }
}

// ---- per-context state -----------------------------------------------------------------------------------
interface RebuildState {
  running: Promise<RebuildResult> | null;
  again: boolean;
  enabled: boolean;
  timer: NodeJS.Timeout | null;
  line: Queue | null;
  hot: Map<string, number>; // fallback when Redis is down
  lastError: string | null;
  /** Passes in a row stopped by OneDrive: each pause is longer (2, 4, 8, at most 10 minutes). */
  pauses: number;
}
const states = new WeakMap<Ctx, RebuildState>();
function st(ctx: Ctx): RebuildState {
  let s = states.get(ctx);
  if (!s) {
    s = { running: null, again: false, enabled: false, timer: null, line: null, hot: new Map(), lastError: null, pauses: 0 };
    states.set(ctx, s);
  }
  return s;
}
export const rebuildRunning = (ctx: Ctx) => !!st(ctx).running;

// ---- pacing (REBUILD_PER_MIN) -------------------------------------------------------------------------------
let pacer = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
/** Tests: a clock and a sleep of their own. null = the real ones. */
export function setRebuildPacer(p: { now: () => number; sleep: (ms: number) => Promise<void> } | null): void {
  pacer = p ?? { now: () => Date.now(), sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) };
}
const starts: number[] = [];
async function paced(perMin: number): Promise<void> {
  for (;;) {
    const now = pacer.now();
    while (starts.length && starts[0] <= now - 60_000) starts.shift();
    if (starts.length < perMin) {
      starts.push(now);
      return;
    }
    await pacer.sleep(starts[0] + 60_000 - now);
  }
}
/** Tests: forget the starts counted so far. */
export function resetRebuildPacing(): void {
  starts.length = 0;
}

// ---- hot: what students are waiting for ----------------------------------------------------------------------
/** A student asked for this photo and its copy is not there: it goes first. */
export async function markHot(ctx: Ctx, mediaId: string): Promise<void> {
  const now = Date.now();
  st(ctx).hot.set(mediaId, now);
  try {
    await ctx.redis.zadd('rebuild:hot', now, mediaId);
    await ctx.redis.zremrangebyrank('rebuild:hot', 0, -HOT_MAX - 1);
  } catch {
    /* Redis down: the in-process set holds it */
  }
}

async function hotIds(ctx: Ctx): Promise<string[]> {
  const cutoff = Date.now() - HOT_AGE_MS;
  try {
    await ctx.redis.zremrangebyscore('rebuild:hot', '-inf', cutoff);
    return await ctx.redis.zrevrange('rebuild:hot', 0, HOT_MAX - 1);
  } catch {
    const s = st(ctx);
    for (const [id, at] of s.hot) if (at < cutoff) s.hot.delete(id);
    return [...s.hot.keys()].slice(-HOT_MAX);
  }
}

async function unhot(ctx: Ctx, id: string): Promise<void> {
  st(ctx).hot.delete(id);
  await ctx.redis.zrem('rebuild:hot', id).catch(() => {});
}

// ---- one item ------------------------------------------------------------------------------------------------
/** 'gone': its original is not in OneDrive (counted as failed, but not a sign that something is wrong with the job). */
type One = 'done' | 'skipped' | 'lost' | 'failed' | 'gone';

/** Make what is missing of one item's copies. Throws (without counting a try) when OneDrive or a tool is not there. */
export async function rebuildOne(ctx: Ctx, mediaId: string): Promise<One> {
  const { cfg, db } = ctx;
  const graph = ctx.drive.kind === 'graph';
  const row = (
    await db.query<any>(
      `select m.*, m.processed_at::text as processed_text, e.status as event_status from media m join events e on e.id = m.event_id
        where m.id = $1 and ${needsFor(ctx)}`,
      [mediaId],
    )
  ).rows[0];
  if (!row) return 'skipped';
  const stale = (k: string | null) => !isDriveKey(k) || (graph && LOCAL_ITEM.test(itemOf(k)));
  const shown = row.duplicate_of == null;
  const missing = !!row.copies_missing;
  const need: Record<CopyKind, boolean> = {
    t: missing || stale(row.thumb_key),
    w: shown && (missing || stale(row.web_key)),
    v: shown && row.type === 'video' && (missing || stale(row.video_key)),
    s: shown && row.type === 'photo' && (missing || row.scene_key == null || stale(row.scene_key)),
    clean:
      shown && row.type === 'video' && cfg.cleanVideoCopies && row.event_status !== 'archived' && row.clean_tries < MAX_TRIES && (missing || row.clean_key == null || stale(row.clean_key)),
    full: false,
  };
  const display = need.t || need.w || need.v;
  const COL: Partial<Record<CopyKind, string>> = { t: 'thumb_key', w: 'web_key', v: 'video_key', s: 'scene_key' };

  // 1. What is still on this server goes up as it is (no original fetched; exactly what was shown).
  if (!missing) {
    const moves: { kind: CopyKind; col: string; old: string | null; abs: string; ext: string }[] = [];
    for (const kind of ['t', 'w', 'v'] as const) {
      const old = row[COL[kind]!];
      const abs = need[kind] && isLegacyKey(old) ? legacyPath(cfg, old) : null;
      if (abs && fs.existsSync(abs)) moves.push({ kind, col: COL[kind]!, old, abs, ext: path.extname(abs).slice(1).toLowerCase() });
    }
    const sceneFile = need.s && row.scene_key == null ? legacyPath(cfg, legacySceneKey(row.event_id, row.id)) : null;
    if (sceneFile && fs.existsSync(sceneFile) && row.sharpness != null) moves.push({ kind: 's', col: 'scene_key', old: null, abs: sceneFile, ext: 'bin' });
    if (moves.length) {
      const keys = await putCopies(ctx, row.event_id, row.id, moves.map((m) => ({ kind: m.kind, body: { file: m.abs }, ext: m.ext })));
      const params: unknown[] = [row.id];
      const sets = moves.map((m, i) => `${m.col} = $${params.push(keys[i])}`);
      const guards = moves.map((m) => `${m.col} is not distinct from $${params.push(m.old)}`);
      const n = await db.query(`update media set ${sets.join(', ')} where id = $1 and ${guards.join(' and ')}`, params);
      if (!n.rowCount) {
        await forget(ctx, keys);
        return 'skipped'; // changed meanwhile: the next pass looks again
      }
      await removeLegacy(cfg, moves.map((m) => (m.kind === 's' ? legacySceneKey(row.event_id, row.id) : m.old)));
      for (const m of moves) need[m.kind] = false;
    }
  }
  if (!Object.values(need).some(Boolean)) {
    await db.query(`update media set copies_missing = false, copies_tries = 0, copies_error = null where id = $1`, [row.id]);
    await unhot(ctx, row.id);
    return 'done';
  }

  // 2. The rest from the original in OneDrive.
  const gone = async (): Promise<One> => {
    if (display && (row.event_status === 'closed' || row.event_status === 'archived')) {
      // An album that is no longer synced keeps what it has; with nothing to show, the photo leaves the album.
      await db.query(`update media set copies_lost = true, copies_error = $2 where id = $1`, [row.id, ORIGINAL_GONE]);
      ctx.bump(row.event_id);
      await unhot(ctx, row.id);
      return 'lost';
    }
    // A synced event: its next listing decides (the photo leaves if its file is really gone). A copy that only lacks
    // its scene description or its clean copy is not asked about again.
    await db.query(`update media set copies_tries = case when $2 then copies_tries + 1 else ${MAX_TRIES} end, copies_error = $3 where id = $1`, [row.id, display, ORIGINAL_GONE]);
    return 'gone';
  };
  if (!row.onedrive_item_id) return gone();

  let keys: string[] = [];
  let taken = false;
  try {
    const kinds: CopyKind[] = [];
    const bodies: { kind: CopyKind; body: Buffer | { file: string }; ext: string }[] = [];
    let look: unknown = undefined;
    let copiesFixed: boolean | null = null;
    let sharpness: number | null = null;
    let sha: string | null = null;
    let videoFile: string | null = null;
    const cleanups: string[] = [];
    try {
      if (row.type === 'photo') {
        await withOriginal(ctx, row.onedrive_item_id, async (input) => {
          const prep = await prepare(input, cfg);
          sha = prep.sha256;
          const fix = await lookToApply(db, row.event_id, prep.look);
          if (shown && (need.t || need.w)) {
            // what the shown copies were made with (a copy's thumbnail is made the same way, as finishCopy does)
            look = prep.look ? JSON.stringify(prep.look) : null;
            copiesFixed = fix != null;
          }
          if (need.t) bodies.push({ kind: 't', body: await displayCopy(prep.work, cfg.thumbMaxPx, 72, fix), ext: 'webp' });
          if (need.w) bodies.push({ kind: 'w', body: await displayCopy(prep.work, cfg.webMaxPx, 80, fix), ext: 'webp' });
          if (need.s) {
            const sc = await ctx.face.scene(await sceneCopy(prep.work));
            sharpness = sc.sharpness;
            bodies.push({ kind: 's', body: sc.desc, ext: 'bin' });
          }
        });
      } else {
        const bytes = Number(row.bytes) || 0;
        if ((await freeBytes(path.dirname(tempPath(cfg, 'x')))) < bytes * 2.3 + 512 * 1024 * 1024) throw new NoRoomError();
        videoFile = tempPath(cfg, `rebuild-${row.id}-${Date.now()}.video`);
        cleanups.push(videoFile);
        await ctx.drive.download(row.onedrive_item_id, videoFile);
        const info = await probeVideo(cfg, videoFile);
        if (need.t || need.w) {
          const work = await poster(cfg, videoFile, info);
          if (need.t) bodies.push({ kind: 't', body: await displayCopy(work, cfg.thumbMaxPx, 72), ext: 'webp' });
          if (need.w) bodies.push({ kind: 'w', body: await displayCopy(work, cfg.webMaxPx, 80), ext: 'webp' });
        }
        if (need.v) {
          const preview = tempPath(cfg, `rebuild-${row.id}-${Date.now()}.preview.mp4`);
          cleanups.push(preview);
          await makePreview(cfg, videoFile, info, preview);
          bodies.push({ kind: 'v', body: { file: preview }, ext: 'mp4' });
        }
      }
      for (const b of bodies) kinds.push(b.kind);
      keys = bodies.length ? await putCopies(ctx, row.event_id, row.id, bodies) : [];

      const params: unknown[] = [row.id, row.processed_text];
      const sets: string[] = ['copies_missing = false', 'copies_tries = 0', 'copies_error = null'];
      kinds.forEach((k, i) => sets.push(`${COL[k]} = $${params.push(keys[i])}`));
      if (look !== undefined) sets.push(`look = $${params.push(look)}::jsonb`, `copies_fixed = $${params.push(copiesFixed)}`);
      if (sharpness != null) sets.push(`sharpness = coalesce(sharpness, $${params.push(sharpness)})`);
      // The original changed since it was read (edited in OneDrive): a synced event reads it again with its faces.
      if (sha && row.sha256 && sha !== row.sha256 && (row.event_status === 'draft' || row.event_status === 'live')) sets.push(`status = 'found'`);
      taken = await ctx.eventLock.run(row.event_id, async () => {
        const n = await db.query(
          `update media set ${sets.join(', ')} where id = $1 and status = 'ready' and review <> 'rejected' and processed_at::text is not distinct from $2`,
          params,
        );
        return n.rowCount > 0;
      });
      if (!taken) return 'skipped';
      emptyCopyTrashSoon(ctx); // the copies these replaced
      const old = kinds.map((k) => row[COL[k]!] as string | null);
      await purgeKeys(ctx, old);
      await removeLegacy(cfg, [...old, ...(kinds.includes('s') ? [legacySceneKey(row.event_id, row.id)] : [])]);
      if (sha && row.sha256 && sha !== row.sha256) await dropFullCopies(ctx, [row.id]);
      // A video's download copy: made now, while the original is here. Its failure never un-shows the video, but
      // it counts as a try of its own (clean_tries): after 3 the video is not downloaded again for it on every pass.
      if (videoFile && need.clean) {
        let made: string | null = null;
        try {
          made = await makeCleanCopy(ctx, row.id, videoFile, extOfName(String(row.name ?? '')));
        } catch (e) {
          ctx.log(`could not keep a location-free copy of a video: ${reasonOf(e)}`);
        }
        await db.query(`update media set clean_tries = ${made ? '0' : 'clean_tries + 1'} where id = $1`, [row.id]);
      }
      ctx.bump(row.event_id);
      await unhot(ctx, row.id);
      return 'done';
    } finally {
      for (const f of cleanups) await fs.promises.rm(f, { force: true });
    }
  } catch (e) {
    if (!taken) await forget(ctx, keys);
    if (e instanceof DriveNotFoundError) return gone();
    if (STOPS.includes((e as Error)?.name)) throw e;
    const reason = reasonOf(e);
    await db.query(
      `update media set copies_tries = copies_tries + 1, copies_error = $2, copies_lost = (copies_tries + 1 >= $3 and $4) where id = $1`,
      [row.id, reason, MAX_TRIES, display],
    );
    ctx.log(`could not make the copies of ${row.name ?? row.id} in OneDrive: ${reason}`);
    if (display) ctx.bump(row.event_id);
    return 'failed';
  }
}

// ---- a pass ----------------------------------------------------------------------------------------------------
export interface RebuildResult {
  done: number;
  lost: number;
  failed: number;
  /** Why the pass stopped early (OneDrive down or busy, a tool missing), or null. */
  stopped: string | null;
}

/**
 * Work through everything that needs its copies (in rounds of ROUND, so what students wait for goes first), then the People reference thumbnails, then the
 * end of the move (data/media, data/full, data/people go once nothing points at them). One pass at a time.
 */
export function rebuildPass(ctx: Ctx): Promise<RebuildResult> {
  const s = st(ctx);
  if (s.running) {
    s.again = true;
    return s.running;
  }
  s.running = track(
    ctx,
    (async () => {
      const out: RebuildResult = { done: 0, lost: 0, failed: 0, stopped: null };
      const seen = new Set<string>();
      const events = new Set<string>();
      const line = (s.line ??= new Queue(Math.max(1, ctx.cfg.rebuildAtOnce)));
      let failsInARow = 0;
      let stoppedBy: string | null = null;
      for (let round = 0; round < 10_000 && !out.stopped; round++) {
        if (await hasFlag(ctx, 'drive:throttled')) {
          out.stopped = 'OneDrive is limiting requests';
          break;
        }
        const hot = await hotIds(ctx);
        const rows = (
          await ctx.db.query<{ id: string; event_id: string }>(
            `select m.id, m.event_id from media m join events e on e.id = m.event_id
              where ${needsFor(ctx)} and not (m.id = any($2::uuid[]))
              order by (m.id = any($1::uuid[])) desc, ${NEEDS_DISPLAY} desc,
                       case e.status when 'live' then 0 when 'closed' then 1 when 'draft' then 2 else 3 end,
                       m.taken_at nulls last, m.id
              limit ${ROUND}`,
            [hot, [...seen]],
          )
        ).rows;
        if (!rows.length) break;
        await Promise.all(
          rows.map((r) =>
            line.push(async () => {
              seen.add(r.id);
              if (out.stopped) return;
              if (await hasFlag(ctx, 'drive:throttled')) {
                out.stopped = 'OneDrive is limiting requests';
                return;
              }
              await paced(ctx.cfg.rebuildPerMin);
              if (out.stopped) return;
              try {
                const one = await rebuildOne(ctx, r.id);
                if (one === 'done') {
                  out.done++;
                  failsInARow = 0;
                  events.add(r.event_id);
                } else if (one === 'lost') out.lost++;
                else if (one === 'gone') out.failed++;
                else if (one === 'failed') {
                  out.failed++;
                  if (++failsInARow >= FAILS_IN_A_ROW) out.stopped ??= `${FAILS_IN_A_ROW} items in a row could not be made; the next pass tries again`;
                }
              } catch (e) {
                if (!out.stopped) stoppedBy = (e as Error)?.name ?? null;
                out.stopped ??= reasonOf(e);
              }
            }),
          ),
        );
      }
      if (!out.stopped) {
        try {
          await rebuildPeopleRefs(ctx);
          await finishLocal(ctx);
        } catch (e) {
          out.stopped = reasonOf(e);
        }
      }
      // Leftovers of crashes in the events just worked on (files older than 2 hours that nothing points at).
      if (!out.stopped) {
        for (const id of events) await sweepOrphans(ctx, id).catch(() => 0);
        await emptyCopyTrash(ctx).catch(() => 0);
      }
      s.lastError = out.stopped;
      if (stoppedBy && DRIVE_STOPS.includes(stoppedBy)) {
        // OneDrive is down, full, signed out or busy: student requests do not start passes for a while (the
        // 10-minute pass still looks), and each pause in a row is longer.
        const ms = Math.min(10 * 60_000, 2 * 60_000 * 2 ** s.pauses);
        s.pauses++;
        await setFlag(ctx, 'rebuild:paused', ms);
      } else if (!out.stopped) {
        s.pauses = 0;
        await clearFlag(ctx, 'rebuild:paused');
      }
      if (out.done || out.lost || out.stopped) {
        ctx.log(`copies in OneDrive: ${out.done} made${out.lost ? `, ${out.lost} cannot be made (original gone)` : ''}${out.failed ? `, ${out.failed} failed` : ''}${out.stopped ? ` (paused: ${out.stopped})` : ''}`);
      }
      return out;
    })().finally(() => {
      s.running = null;
      if (s.again && s.enabled) {
        s.again = false;
        kickRebuild(ctx);
      }
      s.again = false;
    }),
  );
  return s.running;
}

/** People reference thumbnails still on this server go up (or are forgotten when their file is gone). */
async function rebuildPeopleRefs(ctx: Ctx): Promise<void> {
  const rows = (await ctx.db.query<{ id: string; thumb_key: string }>(`select id, thumb_key from person_refs where thumb_key like 'people/%' limit 500`)).rows;
  for (const r of rows) {
    const abs = legacyPath(ctx.cfg, r.thumb_key);
    if (abs && fs.existsSync(abs)) {
      const key = await putPeopleRef(ctx, r.id, await fs.promises.readFile(abs));
      const n = await ctx.db.query(`update person_refs set thumb_key = $2 where id = $1 and thumb_key = $3`, [r.id, key, r.thumb_key]);
      if (n.rowCount) await removeLegacy(ctx.cfg, [r.thumb_key]);
      else await forget(ctx, [key]);
    } else {
      // The face photo itself is gone; its face data still matches. The console says "Add this face photo again to see it".
      await ctx.db.query(`update person_refs set thumb_key = null where id = $1 and thumb_key = $2`, [r.id, r.thumb_key]);
    }
  }
}

/**
 * The end of the move: once no row points at a file on this server, data/media, data/people and data/full go.
 * Rows that are not shown (waiting, failed, lost) and point at a file that is not there forget that key.
 */
async function finishLocal(ctx: Ctx): Promise<void> {
  const { cfg, db } = ctx;
  if ((await db.query(`select 1 from app_state where key = 'copies_local_done'`)).rows.length && !['media', 'full', 'people'].some((d) => fs.existsSync(path.join(cfg.dataDir, d)))) return;
  const LEGACY = `(m.thumb_key like 'media/%' or m.web_key like 'media/%' or m.video_key like 'media/%')`;
  const idle = (
    await db.query<{ id: string; thumb_key: string | null; web_key: string | null; video_key: string | null }>(
      `select m.id, m.thumb_key, m.web_key, m.video_key from media m join events e on e.id = m.event_id
        where ${LEGACY} and not ${needsFor(ctx)} limit 1000`,
    )
  ).rows;
  for (const r of idle) {
    for (const col of ['thumb_key', 'web_key', 'video_key'] as const) {
      const k = r[col];
      const abs = legacyPath(cfg, k);
      if (isLegacyKey(k) && !(abs && fs.existsSync(abs))) await db.query(`update media set ${col} = null where id = $1 and ${col} = $2`, [r.id, k]);
    }
  }
  const left = (await db.query(`select 1 from media m where ${LEGACY} union all select 1 from person_refs where thumb_key like 'people/%' limit 1`)).rows.length;
  if (left) return;
  const sizes: string[] = [];
  for (const d of ['media', 'people']) {
    const abs = path.join(cfg.dataDir, d);
    if (fs.existsSync(abs)) {
      await fs.promises.rm(abs, { recursive: true, force: true });
      sizes.push(`data/${d}`);
    }
  }
  if (await removeLegacyFullDir(cfg)) sizes.push('data/full');
  if (sizes.length) ctx.log(`every photo and video copy is in OneDrive now: ${sizes.join(', ')} removed from this Mac`);
  await db.query(
    `insert into app_state (key, value, updated_at) values ('copies_local_done', to_jsonb(now()::text), now()) on conflict (key) do nothing`,
  );
}

/** Start a pass now (after a short pause, so several kicks make one), when the job is running in this server. */
export function kickRebuild(ctx: Ctx): void {
  const s = st(ctx);
  if (!s.enabled) return;
  if (s.running) {
    s.again = true;
    return;
  }
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    void (async () => {
      if (await hasFlag(ctx, 'rebuild:paused')) return; // OneDrive stopped the last pass: the 10-minute pass looks again
      await rebuildPass(ctx);
    })().catch((e) => ctx.log(`the copies job stopped: ${reasonOf(e)}`));
  }, 1000);
  s.timer.unref?.();
}

/** Resolves when no rebuild pass is running and no copies work waits. */
export async function rebuildIdle(ctx: Ctx): Promise<void> {
  const s = st(ctx);
  while (s.running) await s.running.catch(() => {});
  await copiesIdle(ctx);
}

/**
 * At start: the rebuild job (30 s after start, every 10 minutes, after each sync and on a student's request), the
 * copy trash every 10 minutes, request temp files older than 6 hours every hour, and leftovers of crashes once a day (03:00).
 */
export function startCopies(ctx: Ctx): () => void {
  const s = st(ctx);
  s.enabled = true;
  stateOf(ctx); // the copies state, made now
  const timers: NodeJS.Timeout[] = [];
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    timers.push(t);
  };
  const every = (ms: number, fn: () => void) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    timers.push(t);
  };
  const pass = () => void rebuildPass(ctx).catch((e) => ctx.log(`the copies job stopped: ${reasonOf(e)}`));
  later(30_000, pass);
  every(10 * 60_000, pass);
  // Every row of the trash, also those that failed 20 times (only real failures count; an outage does not).
  every(10 * 60_000, () => void track(ctx, emptyCopyTrash(ctx, { all: true })).catch(() => {}));
  every(60 * 60_000, () => {
    const n = sweepTempDir(ctx.cfg);
    if (n) ctx.log(`removed ${n} request temp file(s) older than 6 hours from data/tmp`);
  });
  let sweptOn = '';
  every(60 * 60_000, () => {
    const now = new Date();
    const day = now.toDateString();
    if (now.getHours() !== 3 || sweptOn === day) return;
    sweptOn = day;
    void (async () => {
      const ids = (await ctx.db.query<{ id: string }>(`select id from events where copies_folders ? 'root'`)).rows.map((r) => r.id);
      let n = 0;
      for (const id of ids) n += await sweepOrphans(ctx, id).catch(() => 0);
      if (n) ctx.log(`removed ${n} leftover copies from OneDrive`);
    })();
  });
  return () => {
    s.enabled = false;
    for (const t of timers) clearTimeout(t);
    if (s.timer) clearTimeout(s.timer);
  };
}
