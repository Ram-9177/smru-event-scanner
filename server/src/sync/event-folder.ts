import type { Ctx } from '../context.js';
import { bad } from '../lib/http.js';
import { COPIES_FOLDER } from '../media/copies.js';

/** Characters OneDrive and Windows refuse in a folder name, plus # and % that break links. */
const BAD_CHARS = /[\\/:*?"<>|#%\u0000-\u001f]/g;

/** The folder name for an event: "2026-11-20 Annual Day", or just the title when there is no date. */
export function folderNameFor(e: { title: string; starts_on: string | null }): string {
  const raw = `${e.starts_on ? `${e.starts_on} ` : ''}${e.title}`;
  const clean = raw
    .replace(BAD_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '') // OneDrive refuses a name that ends in a dot or a space
    .slice(0, 100)
    .trim();
  return clean || 'Event';
}

export interface EventFolder {
  id: string;
  name: string;
  /** true when this call made the link; false when the event already had its folder. */
  created: boolean;
}

/**
 * Gives the event its OneDrive folder, inside the app's Event Photos folder, and links it.
 *   - an event that already has a folder keeps it
 *   - a folder of the same name that no other event uses is taken over (making the event again after a delete
 *     finds its photos again)
 *   - a folder of the same name that belongs to another event is left alone: the new one is "<name> (2)", and so on
 * Runs one at a time per event, so two clicks cannot make two folders.
 */
export async function ensureEventFolder(ctx: Ctx, eventId: string): Promise<EventFolder> {
  return ctx.eventLock.run(`folder:${eventId}`, async () => {
    const e = (
      await ctx.db.query<{ id: string; title: string; starts_on: string | null; status: string; onedrive_folder_id: string | null; onedrive_folder_name: string | null; campus_id: string | null }>(
        `select id, title, to_char(starts_on, 'YYYY-MM-DD') as starts_on, status, onedrive_folder_id, onedrive_folder_name, campus_id from events where id = $1 and org_id = $2`,
        [eventId, ctx.orgId],
      )
    ).rows[0];
    if (!e) throw bad(404, 'not_found', 'Event not found.');
    if (e.onedrive_folder_id) return { id: e.onedrive_folder_id, name: e.onedrive_folder_name ?? '', created: false };
    if (e.status === 'archived') throw bad(400, 'archived', 'An archived event gets no new folder. Set it Live first.');

    const st = await ctx.drive.status();
    if (!st.connected) {
      throw bad(409, st.needsReconnect ? 'reconnect' : 'not_connected', st.needsReconnect ? 'OneDrive needs to be connected again (Settings, OneDrive).' : 'OneDrive is not connected yet. A super admin connects it under Settings, OneDrive.');
    }

    // An event of a campus goes into that campus's folder: Event Photos > Hyderabad > 2026-11-20 Annual Day.
    const parent = e.campus_id ? await campusFolder(ctx, e.campus_id) : null;
    const base = folderNameFor(e);
    for (let n = 1; n <= 50; n++) {
      const name = n === 1 ? base : `${base} (${n})`;
      // A folder of that name may already be there (createFolder finds it): another event's, a campus's or People.
      if (!parent && isReservedFolder(name)) continue;
      const folder = await ctx.drive.createFolder(parent, name);
      if (await folderTaken(ctx, folder.id, { event: e.id })) continue;
      // Only link it if nobody linked a folder in the meantime (the sync tab is open in another window).
      const linked = await ctx.db.query(
        `update events set onedrive_folder_id = $2, onedrive_folder_name = $3, crowd_folder_id = null, sync_error = null where id = $1 and onedrive_folder_id is null`,
        [e.id, folder.id, folder.name],
      );
      if (!linked.rowCount) {
        const now = (await ctx.db.query<{ onedrive_folder_id: string; onedrive_folder_name: string }>(`select onedrive_folder_id, onedrive_folder_name from events where id = $1`, [e.id])).rows[0];
        return { id: now.onedrive_folder_id, name: now.onedrive_folder_name, created: false };
      }
      ctx.bump(e.id);
      return { id: folder.id, name: folder.name, created: true };
    }
    throw bad(409, 'folder_names', `Every folder named "${base}" up to "(50)" belongs to another event. Rename the event or pick a folder by hand.`);
  });
}

/** The campus's folder at the top of the app's OneDrive folder, made the first time an event of that campus needs it. */
export async function campusFolder(ctx: Ctx, campusId: string): Promise<string | null> {
  return ctx.eventLock.run(`campus-folder:${campusId}`, async () => {
    const c = await ctx.db.knex('campuses').select('id', 'name', 'drive_folder_id').where({ id: campusId }).first();
    if (!c) return null;
    if (c.drive_folder_id) {
      try {
        await ctx.drive.children(c.drive_folder_id, 1);
        return c.drive_folder_id as string;
      } catch (e) {
        if ((e as Error).name !== 'DriveNotFoundError') throw e; // the folder was deleted in OneDrive: make it again
      }
    }
    // A folder of that name that is an event's, another campus's or People is left alone: "<name> (2)", and so on.
    const base = folderNameFor({ title: c.name, starts_on: null });
    for (let n = 1; n <= 50; n++) {
      const name = n === 1 ? base : `${base} (${n})`;
      if (isReservedFolder(name)) continue;
      const folder = await ctx.drive.createFolder(null, name);
      if (await folderTaken(ctx, folder.id, { campus: c.id })) continue;
      await ctx.db.knex('campuses').where({ id: c.id }).update({ drive_folder_id: folder.id });
      return folder.id;
    }
    throw bad(409, 'folder_names', `Every folder named "${base}" up to "(50)" belongs to an event or another campus. Rename the campus.`);
  });
}

/** The People folder lives at the top of Event Photos (people/filing.ts): no event or campus may take it over. */
/**
 * Folders of the app's root that are never an event or a campus: People (the People folders) and the app's own
 * copies (_app copies (do not edit)). Case does not matter, as in OneDrive.
 */
export const isReservedFolder = (name: string) => ['people', COPIES_FOLDER.toLowerCase()].includes(name.trim().toLowerCase());

/** Is this folder already an event's folder or a campus's folder (other than the one asking)? */
async function folderTaken(ctx: Ctx, folderId: string, except: { event?: string; campus?: string }): Promise<boolean> {
  const hit = await ctx.db.query(
    `select 1 from events where onedrive_folder_id = $1 and id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000')
     union all
     select 1 from campuses where drive_folder_id = $1 and id <> coalesce($3::uuid, '00000000-0000-0000-0000-000000000000')
     limit 1`,
    [folderId, except.event ?? null, except.campus ?? null],
  );
  return hit.rows.length > 0;
}

export interface FolderChoice {
  id: string;
  /** The folder's own name. */
  name: string;
  /** What the picker shows: "Hyderabad › 2026-11-20 Annual Day" for a folder inside a campus's folder. */
  label: string;
  campus: string | null;
}

/**
 * The folders an event can be linked to: the folders at the top of Event Photos, and the folders inside each
 * campus's folder (where the events of a campus get theirs). A campus's own folder and the People folder are not
 * event folders, so they are left out.
 */
export async function eventFolderChoices(ctx: Ctx): Promise<FolderChoice[]> {
  const campuses = await ctx.db.knex('campuses').select('name', 'drive_folder_id').where({ org_id: ctx.orgId }).whereNotNull('drive_folder_id');
  const campusOf = new Map<string, string>(campuses.map((c: any) => [c.drive_folder_id, c.name]));
  const out: FolderChoice[] = [];
  for (const f of await ctx.drive.children(null)) {
    if (!f.isFolder || isReservedFolder(f.name)) continue;
    const campus = campusOf.get(f.id);
    if (!campus) {
      out.push({ id: f.id, name: f.name, label: f.name, campus: null });
      continue;
    }
    let inside: Awaited<ReturnType<Ctx['drive']['children']>> = [];
    try {
      inside = await ctx.drive.children(f.id);
    } catch (e) {
      if ((e as Error).name !== 'DriveNotFoundError') throw e;
    }
    for (const g of inside) if (g.isFolder) out.push({ id: g.id, name: g.name, label: `${f.name} › ${g.name}`, campus });
  }
  return out;
}
