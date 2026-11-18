import { toBuffer, type Queryable } from '../db/index.js';
import { bitsApart } from '../lib/hashes.js';

/**
 * The duplicate rules of the plan ("Which photo is shown").
 *
 *   - A student's upload that is the same file as, or looks like, any photo of the event is skipped.
 *   - The very same file twice in your folder: shown once, the later one is marked as a copy.
 *   - Your original arriving after a student's copy: yours is shown, the student's is marked as a copy.
 *   - Two of your own photos that only look alike both stay (burst shots).
 *
 * "Marked as a copy" = media.duplicate_of points at the photo that is shown, never at another copy.
 * Callers hold the event's lock, so two decisions for one event never interleave.
 */

/** Make `loser` a copy of `keeper`, and move the loser's own copies over too. */
export async function markCopy(q: Queryable, loserId: string, keeperId: string): Promise<void> {
  await q.query(`update media set duplicate_of = $2 where duplicate_of = $1`, [loserId, keeperId]);
  await q.query(`update media set duplicate_of = $2 where id = $1`, [loserId, keeperId]);
}

/**
 * Decide for one of YOUR files (from the OneDrive folder).
 * Returns the id of the photo it copies, or null when it is the one to show.
 * A student's photo it takes over from leaves the People folders when this one is filed: filing an item also
 * looks at its copies that are still in someone's folder (people/filing.ts, reconcile).
 */
export async function decideOfficial(q: Queryable, eventId: string, mediaId: string, sha256: string, phash: Buffer, dupBits: number): Promise<string | null> {
  // 1. The very same file is already there, from your own folder.
  const same = await q.query<{ id: string }>(
    `select id from media
      where event_id = $1 and id <> $2 and source = 'onedrive' and sha256 = $3
        and duplicate_of is null and status in ('processing', 'ready')
      order by created_at, id limit 1`,
    [eventId, mediaId, sha256],
  );
  if (same.rows[0]) return same.rows[0].id;

  // 2. Students' photos that are the same picture: yours wins.
  const crowd = await q.query<{ id: string; sha256: string | null; phash: Uint8Array | null; hidden: boolean }>(
    `select id, sha256, phash, hidden from media
      where event_id = $1 and id <> $2 and source = 'crowd' and duplicate_of is null and phash is not null
        and review <> 'rejected' and not keep_both`,
    [eventId, mediaId],
  );
  let takenDown = false;
  for (const row of crowd.rows) {
    if (row.sha256 === sha256 || bitsApart(phash, toBuffer(row.phash)!) <= dupBits) {
      await markCopy(q, row.id, mediaId);
      takenDown ||= row.hidden;
    }
  }
  // A picture an organiser took down stays down when your original of it arrives: Unhide brings it back.
  if (takenDown) await q.query(`update media set hidden = true where id = $1`, [mediaId]);
  return null;
}

/**
 * Decide for a STUDENT'S upload, before anything is saved.
 * Compares with every photo the event has: hidden, rejected and not-yet-reviewed ones count too,
 * so a photo that was taken down cannot come back as a copy.
 */
export async function findCopyForUpload(
  q: Queryable,
  eventId: string,
  sha256: string,
  phash: Buffer,
  dupBits: number,
  exceptId: string | null = null,
): Promise<{ id: string; bits: number } | null> {
  const rows = await q.query<{ id: string; sha256: string | null; phash: Uint8Array | null }>(
    `select id, sha256, phash from media where event_id = $1 and (phash is not null or sha256 is not null) and ($2::uuid is null or id <> $2::uuid)`,
    [eventId, exceptId],
  );
  let best: { id: string; bits: number } | null = null;
  for (const row of rows.rows) {
    if (row.sha256 === sha256) return { id: row.id, bits: 0 };
    if (!row.phash) continue;
    const bits = bitsApart(phash, toBuffer(row.phash)!);
    if (bits <= dupBits && (!best || bits < best.bits)) best = { id: row.id, bits };
  }
  return best;
}

/**
 * The photo `mediaId` is going away (its file was deleted, or its content changed).
 * Its best copy takes its place: your own files first, then the earliest.
 * A copy that was never processed in full goes back to 'found' so the worker processes it.
 * Returns the id of the photo that took over, if any.
 */
export async function releaseCopies(q: Queryable, mediaId: string, inheritHidden: boolean): Promise<string | null> {
  const copies = await q.query<{ id: string }>(
    `select id from media where duplicate_of = $1
      order by (source = 'onedrive') desc, created_at, id`,
    [mediaId],
  );
  if (!copies.rows.length) return null;
  const heir = copies.rows[0].id;
  await q.query(
    `update media set duplicate_of = null,
            hidden = hidden or $2,
            status = case when web_key is null and status = 'ready' then 'found' else status end
      where id = $1`,
    [heir, inheritHidden],
  );
  await q.query(`update media set duplicate_of = $2 where duplicate_of = $1`, [mediaId, heir]);
  return heir;
}
