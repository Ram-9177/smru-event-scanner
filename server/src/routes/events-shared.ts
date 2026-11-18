import type { Ctx } from '../context.js';
import { VISIBLE } from '../db/schema.js';
import { imageUrl } from '../lib/links.js';

/** Columns of an event with dates as plain YYYY-MM-DD text (no time-zone surprises). */
export const EVENT_COLS = `
  e.id, e.slug, e.title, to_char(e.starts_on, 'YYYY-MM-DD') as starts_on, to_char(e.ends_on, 'YYYY-MM-DD') as ends_on,
  e.venue, e.status, (e.album_passcode_hash is not null) as has_passcode, e.allow_download, e.face_enabled, e.face_expiry_at,
  e.listed, e.crowd_uploads, e.auto_approve, e.onedrive_folder_id, e.onedrive_folder_name, e.last_sync_at, e.sync_error,
  e.cover_media_id, e.created_at, e.campus_id, e.improve_photos,
  to_char(e.close_on, 'YYYY-MM-DD') as close_on, e.face_days, e.face_deleted_at, e.sync_failures,
  (select json_build_object('id', c.id, 'name', c.name, 'slug', c.slug) from campuses c where c.id = e.campus_id) as campus`;

/** What the one link shows for an event, by its state (see "Roles and the one permanent link" in the plan). */
export async function publicEvent(ctx: Ctx, e: any, mine = 0): Promise<any> {
  const open = e.status === 'live' || e.status === 'closed';
  let cover: string | null = null;
  let photos = 0;
  let strip: string[] = [];
  if (open) {
    photos = (await ctx.db.query<{ n: number }>(`select count(*)::int as n from media m where m.event_id = $1 and ${VISIBLE}`, [e.id])).rows[0].n;
    // A few frames for the event's strip of film: the chosen cover first, then the earliest photos.
    const first = await ctx.db.query<{ id: string }>(
      `select m.id from media m where m.event_id = $1 and ${VISIBLE}
        order by (m.id = $2) desc, m.taken_at nulls last, m.created_at, m.id limit 6`,
      [e.id, e.cover_media_id],
    );
    strip = first.rows.map((r) => imageUrl(ctx.cfg, r.id, 't'));
    cover = strip[0] ?? null;
  }
  const uploadsOn = e.crowd_uploads && !!e.onedrive_folder_id && (e.status === 'draft' || e.status === 'live');
  return {
    slug: e.slug,
    title: e.title,
    starts_on: e.starts_on,
    ends_on: e.ends_on,
    venue: e.venue,
    campus: e.campus ?? null,
    state: e.status, // draft = "Photos coming soon"
    cover,
    strip,
    photos,
    /** How many photos this phone's last selfie found in the event (0 when it has not searched). */
    mine: open ? mine : 0,
    options: {
      find: open && e.face_enabled,
      album: open,
      album_locked: open && e.has_passcode,
      upload: uploadsOn,
      download: e.allow_download,
    },
  };
}
