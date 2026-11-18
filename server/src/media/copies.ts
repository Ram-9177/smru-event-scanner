import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Ctx } from '../context.js';
import type { DriveEntry } from '../drive/types.js';
import { DriveNotFoundError } from '../drive/types.js';
import { Queue } from '../lib/queue.js';
import { hasFlag, purgeUrls } from './copyurls.js';

/**
 * Every photo and video byte the app keeps lives in OneDrive, next to the originals, in one folder of its own:
 *
 *   <app root>/_app copies (do not edit)/
 *     README.txt
 *     people-refs/<refId>-<rand>.jpg          People reference thumbnails
 *     <eventId>/t|w|v|s|clean|full/...        thumbnails, web copies, video previews, scene descriptions,
 *                                             location-free video copies, full-quality download copies
 *
 * This server keeps only the database (with the keys of these files), temp files for one job or one request, and
 * short-lived caches. A key is od/<drive item id>/<file name>: the item id finds the file, the name keeps its
 * extension (thumb_key like '%.jpg' still works). Every write is a new file under a new unique name, never a replace
 * (a replace makes a OneDrive version, which counts against the quota). A key that leaves the database is queued in
 * copy_trash by a trigger in the same transaction, and emptyCopyTrash removes the file: nothing is stranded by a
 * crash. A file uploaded but never committed (a crash between the two) is removed by sweepOrphans after 2 hours.
 */

export const COPIES_FOLDER = '_app copies (do not edit)';
export const PEOPLE_REFS_FOLDER = 'people-refs';
export type CopyKind = 't' | 'w' | 'v' | 's' | 'clean' | 'full';
export const COPY_KINDS: readonly CopyKind[] = ['t', 'w', 'v', 's', 'clean', 'full'];
/** The media column that holds each kind (full copies have their own table). */
export const COLUMN: Record<Exclude<CopyKind, 'full'>, string> = { t: 'thumb_key', w: 'web_key', v: 'video_key', s: 'scene_key', clean: 'clean_key' };

const README = `Made by Event Photos.

This folder holds the app's own copies of your event photos and videos: album thumbnails, web-size copies, video
previews, download copies and People reference photos. Your originals are in the event folders, not here.

Do not edit, rename or move files here. Deleting them only makes the app make them again from the originals.
If this folder is synced to a computer by the OneDrive app, set it to "Free up space" (online only).
`;

// ---- keys ---------------------------------------------------------------------------------------
export const isDriveKey = (k: string | null | undefined): k is string => typeof k === 'string' && k.startsWith('od/');
/** A key from before photos lived only in OneDrive: a file under server/data. */
export const isLegacyKey = (k: string | null | undefined): k is string => typeof k === 'string' && (k.startsWith('media/') || k.startsWith('people/'));
export const itemOf = (k: string): string => k.split('/')[1] ?? '';
export const nameOf = (k: string): string => k.slice(3 + itemOf(k).length + 1);
export const extOf = (k: string): string => {
  const n = isDriveKey(k) ? nameOf(k) : k;
  const i = n.lastIndexOf('.');
  return i < 0 ? '' : n.slice(i + 1).toLowerCase();
};
export const keyOf = (e: Pick<DriveEntry, 'id' | 'name'>): string => `od/${e.id}/${e.name}`;
/** LocalDrive item ids (<inode>-<birth ms>): a key made by the stand-in drive, worthless once OneDrive is connected. */
export const LOCAL_ITEM = /^\d+-\d+$/;

const rand = () => {
  const b = randomBytes(6);
  let s = '';
  for (const x of b) s += '0123456789abcdefghijklmnopqrstuvwxyz'[x % 36];
  return s;
};

const MIME: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  bin: 'application/octet-stream',
  txt: 'text/plain',
};
export const mimeOfExt = (ext: string) => MIME[ext.toLowerCase()] ?? 'application/octet-stream';

// ---- per-context state ---------------------------------------------------------------------------
interface State {
  root: { id: string; at: number } | null;
  rootMaking: Promise<string> | null;
  folders: Map<string, string>; // `${rootId}:${eventId}:${kind}` -> folder id
  peopleRefs: { root: string; id: string } | null;
  trashTimer: NodeJS.Timeout | null;
  trashRun: Promise<number> | null;
  /** Background work that tests (and a stop) wait for: trash runs, clean video copies, rekeys, rebuild passes. */
  busy: Set<Promise<unknown>>;
}
const states = new WeakMap<Ctx, State>();
export function stateOf(ctx: Ctx): State {
  let s = states.get(ctx);
  if (!s) {
    s = { root: null, rootMaking: null, folders: new Map(), peopleRefs: null, trashTimer: null, trashRun: null, busy: new Set() };
    states.set(ctx, s);
  }
  return s;
}

/** Keep track of background work (copiesIdle waits for it). */
export function track<T>(ctx: Ctx, p: Promise<T>): Promise<T> {
  const s = stateOf(ctx);
  const q = p.catch(() => {});
  s.busy.add(q);
  void q.finally(() => s.busy.delete(q));
  return p;
}

/** Resolves when no copies work is waiting or running: the trash emptied (now, not in 2 s), clean copies made, rekeys done. */
export async function copiesIdle(ctx: Ctx): Promise<void> {
  const s = stateOf(ctx);
  for (let i = 0; i < 50; i++) {
    if (s.trashTimer) {
      clearTimeout(s.trashTimer);
      s.trashTimer = null;
      track(ctx, emptyCopyTrash(ctx));
    }
    if (!s.busy.size) return;
    await Promise.all([...s.busy]);
  }
}

/** Uploads to OneDrive at the same moment, across every job of this server. */
export const driveWrites = new Queue(6);

// ---- folders -------------------------------------------------------------------------------------
/** The copies root (made on first use, with its README). Cached for 10 minutes; a folder that went is made again. */
export async function copiesRoot(ctx: Ctx): Promise<string> {
  const s = stateOf(ctx);
  if (s.root && Date.now() - s.root.at < 10 * 60_000) return s.root.id;
  s.rootMaking ??= (async () => {
    try {
      const listed = (await ctx.drive.children(null)).find((e) => e.isFolder && e.name.toLowerCase() === COPIES_FOLDER.toLowerCase());
      const root = listed ?? (await ctx.drive.createFolder(null, COPIES_FOLDER));
      if (!listed) {
        await ctx.drive.upload(root.id, 'README.txt', Buffer.from(README), 'text/plain').catch(() => {});
      }
      if (s.root && s.root.id !== root.id) s.folders.clear();
      s.root = { id: root.id, at: Date.now() };
      await ctx.db
        ?.query(
          `insert into app_state (key, value, updated_at) values ('copies_root', $1::jsonb, now())
           on conflict (key) do update set value = excluded.value, updated_at = now()`,
          [JSON.stringify({ drive: ctx.drive.kind, id: root.id })],
        )
        .catch(() => {});
      return root.id;
    } finally {
      s.rootMaking = null;
    }
  })();
  return s.rootMaking;
}

/** Forget the cached folder ids (one was found gone): the next write looks them up again. */
export function forgetFolders(ctx: Ctx, eventId?: string): void {
  const s = stateOf(ctx);
  s.root = null;
  s.peopleRefs = null;
  if (!eventId) s.folders.clear();
  else for (const k of [...s.folders.keys()]) if (k.includes(`:${eventId}:`)) s.folders.delete(k);
}

/**
 * <root>/<eventId>/<kind>, made on first use and remembered in events.copies_folders (only while the root it was made
 * in is the current one). Throws when the event is gone.
 */
export async function copiesFolder(ctx: Ctx, eventId: string, kind: CopyKind): Promise<string> {
  const s = stateOf(ctx);
  const root = await copiesRoot(ctx);
  const cacheKey = `${root}:${eventId}:${kind}`;
  const hit = s.folders.get(cacheKey);
  if (hit) return hit;
  return ctx.eventLock.run(`copies:${eventId}`, async () => {
    const again = s.folders.get(cacheKey);
    if (again) return again;
    const row = (await ctx.db.query<{ copies_folders: Record<string, string> }>(`select copies_folders from events where id = $1`, [eventId])).rows[0];
    if (!row) throw new Error('The event is no longer in the app.');
    const known = row.copies_folders?.root === root ? row.copies_folders : {};
    let eventFolder = known.event;
    if (!eventFolder) eventFolder = (await ctx.drive.createFolder(root, eventId)).id;
    let id = known[kind];
    if (!id) id = (await ctx.drive.createFolder(eventFolder, kind)).id;
    await ctx.db.query(
      `update events set copies_folders = (case when copies_folders->>'root' = $2 then copies_folders else '{}'::jsonb end) || $3::jsonb where id = $1`,
      [eventId, root, JSON.stringify({ root, event: eventFolder, [kind]: id })],
    );
    s.folders.set(cacheKey, id);
    return id;
  });
}

/** <root>/people-refs, for the People reference thumbnails. */
export async function copiesPeopleRefsFolder(ctx: Ctx): Promise<string> {
  const s = stateOf(ctx);
  const root = await copiesRoot(ctx);
  if (s.peopleRefs?.root === root) return s.peopleRefs.id;
  const f = await ctx.drive.createFolder(root, PEOPLE_REFS_FOLDER);
  s.peopleRefs = { root, id: f.id };
  return f.id;
}

// ---- writing and reading ---------------------------------------------------------------------------
/** Buffers up to this size go up in one request; larger ones and files in pieces (an upload session). */
const SMALL = 4 * 1024 * 1024;

async function upload(ctx: Ctx, folder: string, name: string, body: Buffer | { file: string }, ext: string): Promise<DriveEntry> {
  const mime = mimeOfExt(ext);
  if (Buffer.isBuffer(body)) {
    if (body.length <= SMALL) return ctx.drive.upload(folder, name, body, mime);
    const tmp = path.join(ctx.cfg.dataDir, 'tmp', `copy-${rand()}.part`);
    await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
    try {
      await fs.promises.writeFile(tmp, body);
      return await ctx.drive.uploadFile(folder, name, tmp, mime);
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }
  return ctx.drive.uploadFile(folder, name, body.file, mime);
}

/**
 * Upload one copy under a new unique name; returns its od/ key. `stem` replaces the media id at the front of the name
 * (full copies: <mediaId>-<recipe>). A folder that was deleted by hand is made again once.
 */
export async function putCopy(ctx: Ctx, eventId: string, mediaId: string, kind: CopyKind, body: Buffer | { file: string }, ext: string, stem = mediaId): Promise<string> {
  const name = `${stem}-${rand()}.${ext}`;
  return driveWrites.push(async () => {
    for (let tries = 0; ; tries++) {
      const folder = await copiesFolder(ctx, eventId, kind);
      try {
        return keyOf(await upload(ctx, folder, name, body, ext));
      } catch (e) {
        if (!(e instanceof DriveNotFoundError) || tries) throw e;
        // The folder is gone (deleted in OneDrive): made again.
        forgetFolders(ctx, eventId);
        await ctx.db.query(`update events set copies_folders = '{}'::jsonb where id = $1`, [eventId]);
      }
    }
  });
}

/** A People reference thumbnail into people-refs; returns its od/ key. */
export async function putPeopleRef(ctx: Ctx, refId: string, data: Buffer): Promise<string> {
  const name = `${refId}-${rand()}.jpg`;
  return driveWrites.push(async () => {
    for (let tries = 0; ; tries++) {
      try {
        return keyOf(await ctx.drive.upload(await copiesPeopleRefsFolder(ctx), name, data, 'image/jpeg'));
      } catch (e) {
        if (!(e instanceof DriveNotFoundError) || tries) throw e;
        forgetFolders(ctx);
      }
    }
  });
}

/** A copy's bytes, in memory (scene descriptions, small copies). */
export function readCopy(ctx: Ctx, key: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (!isDriveKey(key)) throw new DriveNotFoundError();
  return ctx.drive.readAll(itemOf(key), maxBytes, signal);
}

/**
 * Remove copies that were uploaded but never reached the database (a job that failed or lost its race), or that the
 * caller took out of the database itself. Best effort: what cannot be removed now goes into copy_trash for later.
 */
export async function forget(ctx: Ctx, keys: (string | null | undefined)[]): Promise<void> {
  for (const k of new Set(keys.filter(isDriveKey))) {
    const id = itemOf(k);
    try {
      await ctx.drive.remove(id, { permanent: true });
      await purgeUrls(ctx, [id]);
    } catch (e) {
      await ctx.db.query(`insert into copy_trash (drive_item_id, last_error) values ($1, $2) on conflict do nothing`, [id, String((e as Error).message).slice(0, 300)]).catch(() => {});
      emptyCopyTrashSoon(ctx);
    }
  }
}

// ---- the trash ---------------------------------------------------------------------------------------
const STOPS = ['DriveDownError', 'DriveAuthError', 'DriveBusyError', 'DriveFullError'];
/**
 * After this many failed tries a row is no longer tried by every pass, only by the 10-minute pass (`all`). Only
 * failures of the item itself count: OneDrive down, busy or signed out stops the pass without counting a try.
 */
const MAX_TRIES = 20;

/**
 * Delete what copy_trash holds: whole event folders first (then that event's item rows), then items, 20 at a time.
 * A file already gone counts as done. OneDrive down or busy: the pass stops, the rows stay (tries counted).
 */
export async function emptyCopyTrash(ctx: Ctx, opts: { all?: boolean } = {}): Promise<number> {
  const s = stateOf(ctx);
  if (s.trashRun) {
    // One pass at a time; a call while one runs waits for it and then runs once more (new rows may have come).
    await s.trashRun.catch(() => 0);
    if (s.trashRun) return s.trashRun;
  }
  const maxTries = opts.all ? 2_000_000_000 : MAX_TRIES;
  s.trashRun = (async () => {
    let done = 0;
    if (await hasFlag(ctx, 'drive:throttled')) return 0;
    const tried = new Set<string>(); // failed in this run: not tried again until the next one
    for (let pass = 0; pass < 100; pass++) {
      const rows = (
        await ctx.db.query<{ drive_item_id: string; folder: boolean; event_id: string | null; tries: number }>(
          `select drive_item_id, folder, event_id, tries from copy_trash where tries < $1 and not (drive_item_id = any($2::text[]))
            order by folder desc, created_at limit 200`,
          [maxTries, [...tried]],
        )
      ).rows;
      if (!rows.length) break;
      const folders = rows.filter((r) => r.folder);
      const items = rows.filter((r) => !r.folder);
      let stop: Error | null = null;
      const one = async (r: (typeof rows)[number]) => {
        try {
          await ctx.drive.remove(r.drive_item_id, { permanent: true });
          if (r.folder) {
            await ctx.db.query(`delete from copy_trash where drive_item_id = $1 or (event_id = $2 and not folder)`, [r.drive_item_id, r.event_id]);
            if (r.event_id) forgetFolders(ctx, r.event_id);
          } else await ctx.db.query(`delete from copy_trash where drive_item_id = $1`, [r.drive_item_id]);
          await purgeUrls(ctx, [r.drive_item_id]);
          done++;
        } catch (e) {
          if (e instanceof DriveNotFoundError) {
            await ctx.db.query(`delete from copy_trash where drive_item_id = $1`, [r.drive_item_id]);
            return;
          }
          tried.add(r.drive_item_id);
          if (STOPS.includes((e as Error)?.name)) {
            // OneDrive, not this item: the pass stops and no try is counted.
            stop = e as Error;
            await ctx.db.query(`update copy_trash set last_error = $2 where drive_item_id = $1`, [r.drive_item_id, String((e as Error).message).slice(0, 300)]);
            return;
          }
          await ctx.db.query(`update copy_trash set tries = tries + 1, last_error = $2 where drive_item_id = $1`, [r.drive_item_id, String((e as Error).message).slice(0, 300)]);
        }
      };
      const goneEvents = new Set<string>();
      for (const f of folders) {
        if (stop) break;
        const before = done;
        await one(f);
        if (done > before && f.event_id) goneEvents.add(f.event_id);
      }
      // Copies inside an event folder that just went are gone with it (their rows went with the folder's).
      const left = items.filter((r) => !(r.event_id && goneEvents.has(r.event_id)));
      for (let i = 0; i < left.length && !stop; i += 20) await Promise.all(left.slice(i, i + 20).map(one));
      if (stop) break;
    }
    return done;
  })().finally(() => (s.trashRun = null));
  return s.trashRun;
}

/** emptyCopyTrash in 2 s (several changes in a row make one pass). */
export function emptyCopyTrashSoon(ctx: Ctx): void {
  const s = stateOf(ctx);
  if (s.trashTimer) return;
  s.trashTimer = setTimeout(() => {
    s.trashTimer = null;
    track(ctx, emptyCopyTrash(ctx)).catch((e) => ctx.log(`could not remove copies from OneDrive yet: ${(e as Error).message}`));
  }, 2000);
  s.trashTimer.unref?.();
}

// ---- orphans --------------------------------------------------------------------------------------------
/** Files older than this in a copies folder that no row points at are leftovers of a crash. */
const ORPHAN_AGE_MS = 2 * 60 * 60_000;

/** Files in an event's copies folders that no row points at, older than 2 hours: deleted. Returns how many. */
export async function sweepOrphans(ctx: Ctx, eventId: string, now = Date.now()): Promise<number> {
  const row = (await ctx.db.query<{ copies_folders: Record<string, string> }>(`select copies_folders from events where id = $1`, [eventId])).rows[0];
  if (!row?.copies_folders?.root) return 0;
  let root: string;
  try {
    root = await copiesRoot(ctx);
  } catch {
    return 0;
  }
  if (row.copies_folders.root !== root) return 0;
  const known = new Set<string>();
  const keys = (
    await ctx.db.query<{ k: string }>(
      `select unnest(array[thumb_key, web_key, video_key, scene_key, clean_key]) as k from media where event_id = $1`,
      [eventId],
    )
  ).rows;
  for (const { k } of keys) if (isDriveKey(k)) known.add(itemOf(k));
  for (const r of (await ctx.db.query<{ drive_item_id: string }>(`select f.drive_item_id from full_copies f join media m on m.id = f.media_id where m.event_id = $1`, [eventId])).rows) known.add(r.drive_item_id);
  for (const r of (await ctx.db.query<{ drive_item_id: string }>(`select drive_item_id from copy_trash`)).rows) known.add(r.drive_item_id);
  let n = 0;
  for (const kind of COPY_KINDS) {
    const folder = row.copies_folders[kind];
    if (!folder) continue;
    let files: DriveEntry[];
    try {
      files = await ctx.drive.children(folder, 999);
    } catch (e) {
      if (e instanceof DriveNotFoundError) continue;
      throw e;
    }
    for (const f of files) {
      if (f.isFolder || known.has(f.id)) continue;
      const at = f.modifiedAt?.getTime() ?? now;
      if (now - at < ORPHAN_AGE_MS) continue;
      // Looked at once more: a copy committed after the list above was read is not an orphan.
      const used = (
        await ctx.db.query(
          `select 1 from media where $1 in (copy_item(thumb_key), copy_item(web_key), copy_item(video_key), copy_item(scene_key), copy_item(clean_key))
           union all select 1 from full_copies where drive_item_id = $1 limit 1`,
          [f.id],
        )
      ).rows.length;
      if (used) continue;
      await ctx.drive.remove(f.id, { permanent: true });
      n++;
    }
  }
  return n;
}

// ---- the transition from server/data ---------------------------------------------------------------------
/** The file of a legacy key under dataDir, or null when the key is not one (or would point outside). */
export function legacyPath(cfg: Pick<Config, 'dataDir'>, key: string | null | undefined): string | null {
  if (!isLegacyKey(key)) return null;
  const abs = path.resolve(cfg.dataDir, key);
  return abs.startsWith(path.resolve(cfg.dataDir) + path.sep) ? abs : null;
}

/** Transition only: remove legacy media/... or people/... files under dataDir. */
export async function removeLegacy(cfg: Pick<Config, 'dataDir'>, keys: (string | null | undefined)[]): Promise<void> {
  for (const k of keys) {
    const abs = legacyPath(cfg, k);
    if (abs) await fs.promises.rm(abs, { force: true });
  }
}

/**
 * Several copies of one media item uploaded side by side. All or nothing: when one fails, those that went up are
 * removed again and the first error is thrown. Returns the keys in the order given.
 */
export async function putCopies(
  ctx: Ctx,
  eventId: string,
  mediaId: string,
  items: { kind: CopyKind; body: Buffer | { file: string }; ext: string }[],
): Promise<string[]> {
  const done = await Promise.allSettled(items.map((i) => putCopy(ctx, eventId, mediaId, i.kind, i.body, i.ext)));
  const failed = done.find((d): d is PromiseRejectedResult => d.status === 'rejected');
  if (failed) {
    await forget(ctx, done.map((d) => (d.status === 'fulfilled' ? d.value : null)));
    throw failed.reason;
  }
  return done.map((d) => (d as PromiseFulfilledResult<string>).value);
}

/** Originals larger than this are fetched to a temp file instead of into memory. */
const IN_MEMORY_MAX = 200 * 1024 * 1024;

/**
 * Run fn on an original from OneDrive: in memory (a Buffer) when it fits, else through a temp file that is removed
 * afterwards. Nothing of it stays on this server.
 */
export async function withOriginal<T>(ctx: Ctx, itemId: string, fn: (input: Buffer | string) => Promise<T>, name = 'rebuild'): Promise<T> {
  let buf: Buffer | null = null;
  try {
    buf = await ctx.drive.readAll(itemId, IN_MEMORY_MAX);
  } catch (e) {
    if ((e as Error)?.name !== 'DriveTooLargeError') throw e;
  }
  if (buf) return fn(buf);
  const tmp = path.join(ctx.cfg.dataDir, 'tmp', `${name}-${itemId.replace(/[^\w-]/g, '_')}-${rand()}`);
  await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
  try {
    await ctx.drive.download(itemId, tmp);
    return await fn(tmp);
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

/**
 * A photo was hidden: its display copies get new names (OneDrive copies them server-side), the row points at the
 * new ones, and the old ones are deleted right away, photo by photo. A OneDrive link handed out before the hide then
 * stops working within a minute or two instead of at its own end (about an hour).
 *
 * A photo whose copies cannot be copied (OneDrive busy or down, a copy already gone) does not keep its old links
 * either: its old copies are deleted (or queued in copy_trash when OneDrive cannot be reached), and the rebuild job
 * makes new ones from the original (copies_missing). A hidden photo is never shown to students, so nobody waits for
 * them. One photo failing never stops the others.
 */
export async function rekeyCopies(ctx: Ctx, mediaIds: string[]): Promise<number> {
  const KIND = { thumb_key: 't', web_key: 'w', video_key: 'v' } as const;
  let n = 0;
  for (const id of mediaIds) {
    const row = (
      await ctx.db.query<{ event_id: string; thumb_key: string | null; web_key: string | null; video_key: string | null }>(
        `select event_id, thumb_key, web_key, video_key from media where id = $1 and hidden`,
        [id],
      )
    ).rows[0];
    if (!row) continue;
    const cols = (Object.keys(KIND) as (keyof typeof KIND)[]).filter((c) => isDriveKey(row[c]));
    if (!cols.length) continue;
    const old = cols.map((c) => row[c]!);
    const fresh: string[] = [];
    try {
      for (const c of cols) {
        const key = row[c]!;
        const folder = await copiesFolder(ctx, row.event_id, KIND[c]);
        fresh.push(keyOf(await ctx.drive.copy(itemOf(key), folder, `${id}-${rand()}.${extOf(key)}`)));
      }
      const params: unknown[] = [id];
      const sets = cols.map((c, i) => `${c} = $${params.push(fresh[i])}`);
      const guards = cols.map((c) => `${c} = $${params.push(row[c])}`);
      const done = await ctx.db.query(`update media set ${sets.join(', ')} where id = $1 and hidden and ${guards.join(' and ')}`, params);
      if (!done.rowCount) await forget(ctx, fresh);
      else {
        n++;
        await forget(ctx, old); // now, not after the whole batch (the trigger queued them too; one removed counts as done)
      }
    } catch (e) {
      await forget(ctx, fresh).catch(() => {});
      const marked = await ctx.db.query(`update media set copies_missing = true where id = $1 and hidden`, [id]).catch(() => ({ rowCount: 0 }));
      if (marked.rowCount) await forget(ctx, old).catch(() => {});
      if (!(e instanceof DriveNotFoundError)) ctx.log(`a hidden photo's copies could not get new names (${(e as Error).message}): the old ones are deleted and made again`);
    }
    await purgeUrls(ctx, old.map(itemOf));
  }
  await emptyCopyTrash(ctx).catch(() => 0);
  return n;
}

/**
 * What every way of hiding a photo does next (Hide, an approved "Remove me", an approved report): the cached links
 * of its copies are forgotten at once (new requests already get 404), and its copies get new names in the background
 * (rekeyCopies), so a OneDrive link already handed out stops working too. Every hide path calls this.
 */
export async function afterHidden(ctx: Ctx, mediaIds: string[]): Promise<void> {
  if (!mediaIds.length) return;
  const rows = (
    await ctx.db.query<{ thumb_key: string | null; web_key: string | null; video_key: string | null }>(
      `select thumb_key, web_key, video_key from media where id = any($1::uuid[])`,
      [mediaIds],
    )
  ).rows;
  await purgeUrls(ctx, rows.flatMap((k) => [k.thumb_key, k.web_key, k.video_key]).filter(isDriveKey).map(itemOf));
  void track(ctx, rekeyCopies(ctx, mediaIds)).catch((e) => ctx.log(`could not give hidden photos new copies: ${(e as Error).message}`));
}
