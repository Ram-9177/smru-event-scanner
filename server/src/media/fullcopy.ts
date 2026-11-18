import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Ctx } from '../context.js';
import { Queue } from '../lib/queue.js';
import { emptyCopyTrashSoon, forget, itemOf, putCopy, track } from './copies.js';
import { fullQuality, type Look } from './prepare.js';

/**
 * Full-quality downloads that have to be made (a photo with its fix, an iPhone HEIC, or one whose metadata cannot be
 * cleaned): decoding and encoding a 12 to 48 MP photo costs about a second of CPU and a few hundred MB, so:
 *   - at most two are made at the same moment by this server, whatever the number of students downloading
 *   - each one made is kept in OneDrive (_app copies (do not edit)/<event>/full) for the next student who asks (a
 *     group photo is downloaded by everyone in it), with a row in full_copies: found by the photo's id and a hash of
 *     the SHA-256 of its original, its fix and how copies are made, so a changed original or a changed fix never gets
 *     an old copy. A copy kept is streamed from OneDrive without the original being fetched again.
 *   - kept within FULL_COPIES_GB (50 GB by default): the copies used longest ago go first
 * Copies of a photo that leaves the app are removed with it (the row goes; a trigger queues the file for deletion).
 * They are only ever served after the same checks as the original (the photo is shown, the phone may see it,
 * downloads are on), and only streamed through this server: their links never leave it.
 */

const renders = new Queue(2);
/** Version of how the copies are made: a change here makes every copy kept so far unused (and pruned in time). */
const RECIPE = 'v2-q93';
const UUID = /^[0-9a-f-]{36}$/;

/** The hash that names a copy: the original's content, the fix and the recipe. */
export function recipeOf(sha256: string, look: Look | null): string {
  return createHash('sha256').update(`${sha256}|${look ? JSON.stringify([look.lo, look.hi, look.gamma, look.sat]) : 'none'}|${RECIPE}`).digest('hex').slice(0, 24);
}

export interface KeptCopy {
  itemId: string;
  name: string;
  bytes: number;
}

/** The kept copy for this photo and fix, when there is one (it counts as just used). */
export async function keptFullCopy(ctx: Ctx, mediaId: string, sha256: string | null, look: Look | null): Promise<KeptCopy | null> {
  if (!sha256 || !UUID.test(mediaId)) return null;
  const r = (
    await ctx.db.query<{ drive_item_id: string; name: string; bytes: number }>(
      `update full_copies set used_at = now() where media_id = $1 and recipe = $2 returning drive_item_id, name, bytes`,
      [mediaId, recipeOf(sha256, look)],
    )
  ).rows[0];
  return r ? { itemId: r.drive_item_id, name: r.name, bytes: Number(r.bytes) } : null;
}

/** A kept copy that turned out to be gone from OneDrive: its row goes, so the next download makes it again. */
export async function forgetFullCopy(ctx: Ctx, itemId: string): Promise<void> {
  await ctx.db.query(`delete from full_copies where drive_item_id = $1`, [itemId]);
  emptyCopyTrashSoon(ctx);
}

const making = new Map<string, Promise<FullCopy>>();
/** Bumped by dropFullCopies for each photo: a copy that was being made while its photo left the app is not kept. */
const dropped = new Map<string, number>();

export interface FullCopy {
  data: Buffer;
  /** Resolves once the copy is kept in OneDrive (true) or could not be (false). Nobody has to wait for it. */
  kept: Promise<boolean>;
}

/**
 * Make the full-quality copy of an original just fetched to `file` (in the render line) and return its bytes as soon
 * as it is rendered (the caller sends them from memory: the copy is not fetched back). Keeping it in OneDrive for the
 * next student happens in the background, in the shared upload line: the student's download never waits for it. The
 * same copy asked for twice at once is made once. Without a SHA-256 (the bytes are not the original the app knows)
 * it is made for this download alone.
 */
export async function makeFullCopy(ctx: Ctx, mediaId: string, sha256: string | null, file: string, look: Look | null): Promise<FullCopy> {
  const render = () => renders.push(() => fullQuality(file, look, ctx.cfg.ffmpegPath));
  if (!sha256 || !UUID.test(mediaId)) return { data: await render(), kept: Promise.resolve(false) };
  const recipe = recipeOf(sha256, look);
  const name = `${mediaId}:${recipe}`;
  let job = making.get(name);
  if (!job) {
    const turn = dropped.get(mediaId) ?? 0;
    const rendered = render();
    const keep = async (data: Buffer): Promise<boolean> => {
      if ((dropped.get(mediaId) ?? 0) !== turn) return false; // rejected, removed or archived meanwhile
      const ev = (await ctx.db.query<{ event_id: string }>(`select event_id from media where id = $1`, [mediaId])).rows[0];
      if (!ev) return false;
      let key: string;
      try {
        key = await putCopy(ctx, ev.event_id, mediaId, 'full', data, 'jpg', `${mediaId}-${recipe}`);
      } catch (e) {
        // OneDrive could not keep it: this download still got it; the next one makes it again.
        ctx.log(`a full-quality copy could not be kept in OneDrive: ${(e as Error).message}`);
        return false;
      }
      const ins = await ctx.db.query(
        `insert into full_copies (media_id, recipe, drive_item_id, name, bytes)
           select $1, $2, $3, $4, $5 where exists (select 1 from media where id = $1)
         on conflict do nothing returning media_id`,
        [mediaId, recipe, itemOf(key), key.slice(key.lastIndexOf('/') + 1), data.length],
      );
      if (!ins.rowCount || (dropped.get(mediaId) ?? 0) !== turn) {
        if (ins.rowCount) await ctx.db.query(`delete from full_copies where drive_item_id = $1`, [itemOf(key)]); // the trigger queues it
        else await forget(ctx, [key]);
        emptyCopyTrashSoon(ctx);
        return false;
      }
      void pruneFullCopies(ctx).catch(() => {});
      return true;
    };
    const kept = track(
      ctx,
      rendered.then(keep, () => false).catch((e) => {
        ctx.log(`a full-quality copy could not be kept in OneDrive: ${(e as Error).message}`);
        return false;
      }),
    );
    // Asked for again while it is still being kept: the same bytes, not a second render.
    job = rendered.then((data) => ({ data, kept }));
    making.set(name, job);
    const done = () => making.delete(name);
    void kept.then(done);
  }
  return job;
}

let pruning: Promise<void> | null = null;
/** Keep the full copies within FULL_COPIES_GB: the ones used longest ago go first (never one used in the last minute). */
export function pruneFullCopies(ctx: Ctx): Promise<void> {
  pruning ??= (async () => {
    for (let i = 0; i < 1000; i++) {
      const total = Number((await ctx.db.query<{ n: string }>(`select coalesce(sum(bytes), 0)::text as n from full_copies`)).rows[0].n);
      if (total <= ctx.cfg.fullCopiesBytes) break;
      const gone = await ctx.db.query(
        `delete from full_copies where (media_id, recipe) in (
           select media_id, recipe from full_copies where used_at < now() - interval '1 minute' order by used_at limit 50)`,
      );
      if (!gone.rowCount) break;
    }
    emptyCopyTrashSoon(ctx);
  })().finally(() => (pruning = null));
  return pruning;
}

/** Remove every kept copy of these photos (they left the app, or their event was archived). The trigger queues the files. */
export async function dropFullCopies(ctx: Ctx, mediaIds: string[]): Promise<void> {
  if (!mediaIds.length) return;
  for (const id of mediaIds) dropped.set(id, (dropped.get(id) ?? 0) + 1); // first: a copy still being made is not kept either
  for (let i = 0; i < mediaIds.length; i += 1000) {
    await ctx.db.query(`delete from full_copies where media_id = any($1::uuid[])`, [mediaIds.slice(i, i + 1000)]);
  }
  emptyCopyTrashSoon(ctx);
}

/** Once: the folder where full copies were kept on this server before they lived in OneDrive (only a cache, not moved). */
export async function removeLegacyFullDir(cfg: Pick<Config, 'dataDir'>): Promise<boolean> {
  const dir = path.join(cfg.dataDir, 'full');
  if (!fs.existsSync(dir)) return false;
  await fs.promises.rm(dir, { recursive: true, force: true });
  return true;
}
