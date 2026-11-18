import path from 'node:path';
import type { Ctx } from '../context.js';
import { toBuffer } from '../db/index.js';
import { VISIBLE } from '../db/schema.js';
import { bufferToVector } from '../face/index.js';
import type { DriveEntry } from '../drive/index.js';
import { folderNameFor } from '../sync/event-folder.js';

/**
 * The People folders: the university's main people (Chairman, CEO, COO, Vice Chancellor ...) each get a folder in
 * OneDrive, and every shown photo or video they are in is copied into it, sorted by how many people are in it:
 *
 *   Event Photos > People > Dr. A. Rao - Chairman > Solo | Duo | Group > 2026-11-20 Annual Day - IMG_0042.jpg
 *
 * A person is recognised from the reference photos added in People (face vectors, the same model as the search).
 * The copy is a OneDrive copy of the original, so the full quality is kept and nothing is uploaded again.
 * A photo that stops being shown (hidden, rejected, marked as a copy) leaves the folders again.
 */
export type Kind = 'solo' | 'duo' | 'group';
export const KIND_FOLDER: Record<Kind, string> = { solo: 'Solo', duo: 'Duo', group: 'Group' };
export const PEOPLE_FOLDER = 'People';

/** Filing must be sure: measured, the same person scores 0.73-0.95 and others under 0.31. */
export const PEOPLE_MATCH = 0.5;
/**
 * Who counts when deciding Solo / Duo / Group: faces at least this share of the largest face's width. People far
 * in the background of a solo portrait do not make it a group photo.
 */
export const MAIN_FACE_SHARE = 0.35;
const MIN_FACE_PX = 24;

interface Ref {
  person_id: string;
  vector: Float32Array;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

async function loadRefs(ctx: Ctx, onlyPerson?: string): Promise<Ref[]> {
  const q = ctx.db
    .knex('person_refs as r')
    .join('people as p', 'p.id', 'r.person_id')
    .select('r.person_id', 'r.embedding')
    .where('p.org_id', ctx.orgId)
    .andWhere('r.model', ctx.face.model);
  if (onlyPerson) q.andWhere('r.person_id', onlyPerson);
  return (await q).map((r: any) => ({ person_id: r.person_id, vector: bufferToVector(toBuffer(r.embedding)!) }));
}

/**
 * Who is in one item, and how each of them is in it, from its faces. Solo / Duo / Group counts only the main
 * faces (MAIN_FACE_SHARE). A person seen only far in the background is in the photo but is not its subject, so for
 * them it is a Group photo: someone else's portrait never lands in their Solo folder.
 */
export function whoIsIn(faces: { vector: Float32Array; w: number }[], refs: Ref[]): Map<string, { kind: Kind; similarity: number }> {
  const found = new Map<string, { kind: Kind; similarity: number; main: boolean }>();
  const usable = faces.filter((f) => f.w >= MIN_FACE_PX);
  if (!usable.length || !refs.length) return new Map();
  const widest = Math.max(...usable.map((f) => f.w));
  const isMain = (f: { w: number }) => f.w >= widest * MAIN_FACE_SHARE;
  const main = usable.filter(isMain).length;
  const kind: Kind = main <= 1 ? 'solo' : main === 2 ? 'duo' : 'group';
  for (const f of usable) {
    const front = isMain(f);
    for (const r of refs) {
      const s = dot(f.vector, r.vector);
      if (s < PEOPLE_MATCH) continue;
      const had = found.get(r.person_id);
      // A match among the main faces counts before one in the background; then the closest match.
      if (!had || (front && !had.main) || (front === had.main && s > had.similarity)) found.set(r.person_id, { kind: front ? kind : 'group', similarity: s, main: front });
    }
  }
  return new Map([...found].map(([id, w]) => [id, { kind: w.kind, similarity: w.similarity }]));
}

interface MediaRow {
  id: string;
  event_id: string;
  name: string | null;
  type: string;
  onedrive_item_id: string | null;
  ctag: string | null;
  bytes: number | null;
  visible: boolean;
  archived: boolean;
  starts_on: string | null;
  title: string;
}

async function mediaRow(ctx: Ctx, id: string): Promise<MediaRow | undefined> {
  return (
    await ctx.db.query<MediaRow>(
      `select m.id, m.event_id, m.name, m.type, m.onedrive_item_id, m.ctag, m.bytes, ${VISIBLE} as visible, (e.status = 'archived') as archived,
              to_char(e.starts_on, 'YYYY-MM-DD') as starts_on, e.title
         from media m join events e on e.id = m.event_id
        where m.id = $1 and e.org_id = $2`,
      [id, ctx.orgId],
    )
  ).rows[0];
}

async function facesOf(ctx: Ctx, mediaId: string): Promise<{ vector: Float32Array; w: number }[]> {
  const rows = await ctx.db.knex('faces').select('embedding', 'box_w').where({ media_id: mediaId, model: ctx.face.model });
  return (rows as any[]).map((r) => ({ vector: bufferToVector(toBuffer(r.embedding)!), w: r.box_w }));
}

/**
 * The items to look at for a change to these: the items themselves, the photo shown in place of one that is a copy
 * (Hide on a copy hides that one), and copies of them that are still in someone's folder (a student's photo that
 * became a copy when your original of it arrived leaves the folders when your original is filed).
 */
async function withRelated(ctx: Ctx, mediaIds: string[]): Promise<string[]> {
  if (!mediaIds.length) return [];
  const more = await ctx.db.query<{ id: string }>(
    `select duplicate_of as id from media where id = any($1::uuid[]) and duplicate_of is not null
     union
     select m.id from media m where m.duplicate_of = any($1::uuid[]) and exists (select 1 from person_media pm where pm.media_id = m.id)`,
    [mediaIds],
  );
  return [...new Set([...mediaIds, ...more.rows.map((r) => r.id)])];
}

/** The person's folder and its Solo / Duo / Group folders in OneDrive, made when first needed. */
async function kindFolder(ctx: Ctx, personId: string, kind: Kind): Promise<string> {
  const p = await ctx.db.knex('people').where({ id: personId }).first();
  const known = (p.drive_kind_folders ?? {}) as Record<string, string>;
  if (known[kind]) return known[kind];
  const people = await ctx.drive.createFolder(null, PEOPLE_FOLDER);
  const name = personFolderName(p);
  const mine = await ctx.drive.createFolder(people.id, name);
  const sub = await ctx.drive.createFolder(mine.id, KIND_FOLDER[kind]);
  const kinds = { ...known, [kind]: sub.id };
  await ctx.db.knex('people').where({ id: personId }).update({ drive_folder_id: mine.id, drive_folder_name: mine.name, drive_kind_folders: JSON.stringify(kinds) });
  return sub.id;
}

export const personFolderName = (p: { name: string; role: string }) => folderNameFor({ title: p.role ? `${p.name} - ${p.role}` : p.name, starts_on: null });

/** "2026-11-20 Annual Day - IMG_0042.jpg": the event comes first, so a person's folder sorts by date. */
function copyName(m: MediaRow): string {
  const ext = path.extname(m.name ?? '') || (m.type === 'video' ? '.mp4' : '.jpg');
  const base = path.basename(m.name ?? m.id, path.extname(m.name ?? '')).slice(0, 80);
  return `${folderNameFor({ title: `${m.title} - ${base}`, starts_on: m.starts_on })}${ext.toLowerCase()}`;
}

const isNotFound = (e: unknown) => (e as Error)?.name === 'DriveNotFoundError';
/** OneDrive needs reconnecting or cannot be reached: everything after this would fail too, so the work stops here. */
const isDriveDown = (e: unknown) => ['DriveAuthError', 'DriveDownError'].includes((e as Error)?.name);

/** What is in a person's Solo / Duo / Group folders, read once per run. */
type Listing = Map<string, DriveEntry[]>;

/**
 * Remove a copy from a People folder. If OneDrive cannot do it now, the copy's id is kept in people_trash and
 * removed later (emptyPeopleTrash), so no copy is ever forgotten. Throws only if the database fails.
 */
async function dropCopy(ctx: Ctx, itemId: string | null, listing?: Listing): Promise<void> {
  if (!itemId) return;
  for (const list of listing?.values() ?? []) {
    const i = list.findIndex((e) => e.id === itemId);
    if (i >= 0) list.splice(i, 1);
  }
  try {
    await ctx.drive.remove(itemId);
  } catch (e) {
    if (isNotFound(e)) return; // someone deleted it in OneDrive already: fine
    ctx.log(`People folders: a copy could not be removed now, it is tried again later: ${(e as Error).message}`);
    await ctx.db.knex('people_trash').insert({ drive_item_id: itemId, org_id: ctx.orgId, last_error: (e as Error).message }).onConflict('drive_item_id').ignore();
  }
}

/** The files in one Solo / Duo / Group folder (null when the folder is gone). */
async function filesIn(ctx: Ctx, folderId: string, listing: Listing): Promise<DriveEntry[] | null> {
  const known = listing.get(folderId);
  if (known) return known;
  try {
    const list = (await ctx.drive.children(folderId)).filter((e) => !e.isFolder);
    listing.set(folderId, list);
    return list;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Copy the original into the person's folder. A copy of it that is already there and that no row knows about
 * (the person was removed and added again) is taken over instead of copying it a second time.
 * Returns null when there is nothing to copy: the original is no longer in OneDrive (a closed event's photos may
 * have been moved). The item is then tried again by the next change or by "File again".
 */
async function copyInto(ctx: Ctx, personId: string, kind: Kind, m: MediaRow, listing: Listing): Promise<string | null> {
  if (!m.onedrive_item_id) return null;
  const name = copyName(m);
  let folder = await kindFolder(ctx, personId, kind);
  let files = await filesIn(ctx, folder, listing);
  if (!files) {
    // The person's folder was deleted or moved in OneDrive: make it again.
    await ctx.db.knex('people').where({ id: personId }).update({ drive_kind_folders: '{}' });
    folder = await kindFolder(ctx, personId, kind);
    files = (await filesIn(ctx, folder, listing)) ?? [];
  }
  for (const f of files) {
    if (f.name.toLowerCase() !== name.toLowerCase()) continue;
    if (m.bytes && f.size && Number(m.bytes) !== f.size) continue;
    if (await ctx.db.knex('person_media').where({ drive_item_id: f.id }).first()) continue; // another photo's copy
    if (await ctx.db.knex('people_trash').where({ drive_item_id: f.id }).first()) continue; // an old copy waiting to be removed
    return f.id;
  }
  try {
    const made = await ctx.drive.copy(m.onedrive_item_id, folder, name);
    files.push(made);
    return made.id;
  } catch (e) {
    if (isNotFound(e)) return null; // the folder is there (it was just read), so the original is what is missing
    throw e;
  }
}

/**
 * Bring the People folders in step for these items: add the people found in them, remove the ones who are no
 * longer there (or whose item is no longer shown), move an item whose Solo / Duo / Group changed, and copy again
 * an item whose original changed in OneDrive. onlyPerson limits the work to one person (after their reference
 * photos changed).
 *
 * Each item is read fresh while its lock is held, so an item hidden or removed while a long run is under way is
 * never filed from an old reading. One item that cannot be filed does not stop the others.
 */
export async function reconcile(ctx: Ctx, mediaIds: string[], onlyPerson?: string): Promise<{ filed: number; removed: number }> {
  const refs = await loadRefs(ctx, onlyPerson);
  const listing: Listing = new Map();
  let filed = 0;
  let removed = 0;
  for (const id of await withRelated(ctx, mediaIds)) {
    try {
      await ctx.eventLock.run(`people:${id}`, async () => {
        const m = await mediaRow(ctx, id);
        if (!m) return; // removed meanwhile (its copies went with it)
        // An archived event has no face data any more, so nobody can be recognised in it: its copies stay as they are.
        // A photo of it that is hidden still leaves the folders.
        if (m.archived && m.visible) return;
        const want = m.visible ? whoIsIn(await facesOf(ctx, m.id), refs) : new Map<string, { kind: Kind; similarity: number }>();
        const q = ctx.db.knex('person_media').where({ media_id: m.id });
        if (onlyPerson) q.andWhere({ person_id: onlyPerson });
        const have = (await q) as { person_id: string; kind: Kind; drive_item_id: string | null }[];
        for (const h of have) {
          const w = want.get(h.person_id);
          if (w && w.kind === h.kind) continue;
          await dropCopy(ctx, h.drive_item_id, listing);
          await ctx.db.knex('person_media').where({ person_id: h.person_id, media_id: m.id }).delete();
          if (!w) removed++;
        }
        for (const [personId, w] of want) {
          const where = { person_id: personId, media_id: m.id };
          const row = await ctx.db.knex('person_media').where(where).first();
          if (row?.drive_item_id) {
            if ((row.source_ctag ?? null) === (m.ctag ?? null)) {
              await ctx.db.knex('person_media').where(where).update({ similarity: w.similarity });
              continue;
            }
            // The original changed in OneDrive (an edited version): the old copy makes way for a fresh one.
            await dropCopy(ctx, row.drive_item_id, listing);
            await ctx.db.knex('person_media').where(where).update({ drive_item_id: null, filed_at: null });
          }
          if (!row) {
            try {
              await ctx.db.knex('person_media').insert({ ...where, kind: w.kind, similarity: w.similarity });
            } catch (e) {
              if ((e as { code?: string }).code === '23503') return; // the item was removed a moment ago
              throw e;
            }
          }
          const itemId = await copyInto(ctx, personId, w.kind, m, listing);
          const n = await ctx.db
            .knex('person_media')
            .where(where)
            .update({ drive_item_id: itemId, drive_folder_kind: w.kind, similarity: w.similarity, source_ctag: m.ctag, filed_at: itemId ? ctx.db.knex.fn.now() : null });
          if (!n) {
            await dropCopy(ctx, itemId, listing); // the item was removed while it was being copied
            return;
          }
          if (itemId) filed++;
        }
      });
    } catch (e) {
      if (isDriveDown(e)) throw e;
      ctx.log(`People folders: one item could not be filed, the others carry on: ${(e as Error).message}`);
    }
  }
  return { filed, removed };
}

/** Called after an item changes (media/after.ts). Nothing to do while nobody is set up in People. */
export async function filePeopleFor(ctx: Ctx, mediaIds: string[]): Promise<void> {
  const anyone = await ctx.db.knex('people').where({ org_id: ctx.orgId }).first();
  if (!anyone && !(await trashWaiting(ctx))) return;
  const st = await ctx.drive.status();
  if (!st.connected) return; // filed when OneDrive is back, by the next change or "File again"
  emptyPeopleTrashLater(ctx);
  if (anyone) await reconcile(ctx, mediaIds);
}

/** Look through every event for one person (new reference photos, or "File again"). */
export async function refilePerson(ctx: Ctx, personId: string): Promise<{ filed: number; removed: number }> {
  await emptyPeopleTrash(ctx);
  // An archived event is left out: it has no face data any more, and its copies stay as they are.
  const ids = (
    await ctx.db.query<{ id: string }>(
      `select m.id from media m join events e on e.id = m.event_id
        where e.org_id = $1 and ((${VISIBLE} and e.status <> 'archived') or m.id in (select media_id from person_media where person_id = $2))
        order by m.created_at`,
      [ctx.orgId, personId],
    )
  ).rows.map((r) => r.id);
  let filed = 0;
  let removed = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const r = await reconcile(ctx, ids.slice(i, i + 200), personId);
    filed += r.filed;
    removed += r.removed;
  }
  return { filed, removed };
}

/**
 * The same Solo / Duo / Group rule as SQL, for a media row aliased "m": the faces at least MAIN_FACE_SHARE of
 * the widest face in it. Used for the tabs on a student's results.
 */
export const KIND_SQL = `(select case when count(*) <= 1 then 'solo' when count(*) = 2 then 'duo' else 'group' end
   from faces f
  where f.media_id = m.id and f.box_w >= ${MIN_FACE_PX}
    and f.box_w >= ${MAIN_FACE_SHARE} * (select max(f2.box_w) from faces f2 where f2.media_id = m.id))`;

/**
 * Before an item is removed for good: its copies leave the People folders. Runs under the item's lock, so it waits
 * for a filing of the item that is under way. A copy OneDrive cannot remove now is kept in people_trash and removed
 * later. Never throws.
 */
export async function removePeopleCopies(ctx: Ctx, mediaId: string): Promise<void> {
  try {
    await ctx.eventLock.run(`people:${mediaId}`, async () => {
      const rows = (await ctx.db.knex('person_media').select('person_id', 'drive_item_id').where({ media_id: mediaId })) as { person_id: string; drive_item_id: string | null }[];
      for (const r of rows) {
        await dropCopy(ctx, r.drive_item_id);
        await ctx.db.knex('person_media').where({ person_id: r.person_id, media_id: mediaId }).delete();
      }
    });
  } catch (e) {
    // The rows are still there; when the media row goes, the database moves their copies to people_trash.
    ctx.log(`People folders: could not remove the copies of a removed item: ${(e as Error).message}`);
  }
}

/** A copy that still cannot be removed after this many tries is given up (it is logged). */
const TRASH_TRIES = 10;

const trashOfOrg = (ctx: Ctx) =>
  ctx.db
    .knex('people_trash')
    .where((q) => q.where({ org_id: ctx.orgId }).orWhereNull('org_id'))
    .andWhere('tries', '<', TRASH_TRIES);
const trashWaiting = async (ctx: Ctx) => !!(await trashOfOrg(ctx).first());

/**
 * Remove the copies waiting in people_trash (their photo left the app, or OneDrive could not remove them at the
 * time). Stops when OneDrive cannot be reached; the rest wait for the next time. Returns how many were removed.
 */
export async function emptyPeopleTrash(ctx: Ctx): Promise<number> {
  return ctx.eventLock.run('people-trash', async () => {
    let done = 0;
    const tried = new Set<string>(); // a copy that failed is tried once per run
    for (;;) {
      const rows = (await trashOfOrg(ctx).whereNotIn('drive_item_id', [...tried]).orderBy('created_at').limit(100)) as { drive_item_id: string; tries: number }[];
      if (!rows.length) break;
      for (const r of rows) {
        try {
          await ctx.drive.remove(r.drive_item_id);
        } catch (e) {
          if (!isNotFound(e)) {
            const tries = r.tries + 1;
            if (tries >= TRASH_TRIES) ctx.log(`People folders: gave up removing an old copy (${r.drive_item_id}): ${(e as Error).message}`);
            await ctx.db.knex('people_trash').where({ drive_item_id: r.drive_item_id }).update({ tries, last_error: (e as Error).message });
            if (isDriveDown(e)) return done;
            tried.add(r.drive_item_id);
            continue;
          }
        }
        await ctx.db.knex('people_trash').where({ drive_item_id: r.drive_item_id }).delete();
        done++;
      }
    }
    return done;
  });
}

const trashQueued = new WeakSet<Ctx>();
/** emptyPeopleTrash in the background (the photo work line), once at a time. Never throws. */
export function emptyPeopleTrashLater(ctx: Ctx): void {
  if (trashQueued.has(ctx)) return;
  trashQueued.add(ctx);
  void ctx.work
    .push(async () => {
      trashQueued.delete(ctx);
      if (!(await trashWaiting(ctx))) return;
      if (!(await ctx.drive.status()).connected) return;
      await emptyPeopleTrash(ctx);
    })
    .catch((e) => {
      trashQueued.delete(ctx);
      ctx.log(`People folders: could not remove old copies yet: ${(e as Error).message}`);
    });
}
