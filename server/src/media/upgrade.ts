import type { Ctx } from '../context.js';
import { Queue } from '../lib/queue.js';
import { remakeCopies } from './process.js';

/**
 * Album copies made again from the originals. A shown photo needs it when
 *   - its copies are from before the album went WebP (.jpg), or
 *   - it has a fix (a look) and its copies were made with the other "Improve photos" setting than its event has now
 *     (media.copies_fixed): after a switch, or a switch that could not be finished (OneDrive down, a restart).
 * A photo without a fix looks the same either way, so a switch never remakes it.
 *
 * One pass (remakePending) finds them: after a switch, after a start (all events), and after each sync of an event
 * (so whatever was left over is finished as soon as OneDrive answers again). The work has its own line, one photo at
 * a time, apart from the photo workers: new photos found by a sync and students' uploads never wait behind a whole
 * album. Each photo is checked again when its turn comes, so switching twice quickly remakes nothing twice, and a
 * photo already waiting in the line is not added again. Faces, copies and what is hidden stay as they are.
 */
const remakeLine = new Queue(1);
/** Resolves when nothing is being remade or waiting to be. */
export const remakesIdle = () => remakeLine.idle();

const DRIVE_DOWN = ['DriveAuthError', 'DriveDownError', 'VideoToolsError'];
/** Photos waiting in the line (or being remade). */
const waiting = new Set<string>();

/** A photo whose original is gone, in an event that is no longer synced (closed, archived): the album keeps its copy. */
export const ORIGINAL_GONE = 'The original is no longer in OneDrive; the album keeps the copy it has.';

const NEEDS = `m.status = 'ready' and m.duplicate_of is null and m.type = 'photo' and m.review <> 'rejected' and m.onedrive_item_id is not null
  and m.status_reason is distinct from '${ORIGINAL_GONE.replace(/'/g, "''")}'
  and (m.web_key like '%.jpg' or (m.look is not null and m.copies_fixed is distinct from e.improve_photos))`;

async function stillNeeded(ctx: Ctx, id: string): Promise<boolean> {
  return (await ctx.db.query(`select 1 from media m join events e on e.id = m.event_id where m.id = $1 and ${NEEDS}`, [id])).rows.length > 0;
}

/**
 * Queue every photo that needs its album copies made again (of one event, or of all). Resolves when those queued by
 * this call are done; how many were remade, and whether OneDrive (or ffmpeg) could not be reached.
 */
export async function remakePending(ctx: Ctx, eventId: string | null = null): Promise<{ queued: number; done: number; down: boolean }> {
  const ids = (
    await ctx.db.query<{ id: string }>(
      `select m.id from media m join events e on e.id = m.event_id where ${NEEDS} and ($1::uuid is null or m.event_id = $1::uuid) order by m.created_at, m.id`,
      [eventId],
    )
  ).rows
    .map((x) => x.id)
    .filter((id) => !waiting.has(id));
  let down = false;
  let done = 0;
  for (const id of ids) waiting.add(id);
  await Promise.all(
    ids.map((id) =>
      remakeLine
        .push(async () => {
          if (down || !(await stillNeeded(ctx, id))) return;
          try {
            const r = await remakeCopies(ctx, id);
            if (r === 'ready') done++;
            if (r === 'gone') {
              // The original could not be fetched ("not found"). A synced event's next listing decides (the photo
              // leaves if its file is really gone); only an event that is no longer synced remembers it, so it is not
              // asked for again (sync clears the mark if the file is listed again).
              await ctx.db.query(
                `update media m set status_reason = $2 from events e where m.id = $1 and e.id = m.event_id and m.status = 'ready' and e.status in ('closed', 'archived')`,
                [id, ORIGINAL_GONE],
              );
            }
          } catch (e) {
            if (DRIVE_DOWN.includes((e as Error)?.name)) down = true; // the rest waits for the next pass
            else ctx.log(`could not make a photo's album copies again: ${(e as Error).message}`);
          }
        })
        .finally(() => waiting.delete(id)),
    ),
  );
  return { queued: ids.length, done, down };
}

/** "Improve photos" was switched for an event: its photos with a fix get their album copies made again. */
export function remakeEventCopies(ctx: Ctx, eventId: string): void {
  void remakePending(ctx, eventId).catch((e) => ctx.log(`could not make the album copies again: ${(e as Error).message}`));
}

/**
 * After a start: albums made before the app's copies went WebP (and before photos got their fix), and any switch left
 * unfinished, are brought up to date in the background. If OneDrive cannot be reached, the rest is done after the
 * next sync of each event (or the next start).
 */
export function upgradeOldCopies(ctx: Ctx): Promise<void> {
  return (async () => {
    const r = await remakePending(ctx, null);
    if (!r.queued) return;
    ctx.log(`album copies made again from the originals (lighter WebP, with the event's Improve photos setting): ${r.done} of ${r.queued}${r.down ? ' (OneDrive could not be reached: the rest after the next sync)' : ''}`);
  })().catch((e) => ctx.log(`could not make older photos lighter: ${(e as Error).message}`));
}
