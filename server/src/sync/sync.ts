import type { Ctx } from '../context.js';
import { DriveNotFoundError, listTree } from '../drive/index.js';
import { classify, processable, SKIP_REASON } from '../media/files.js';
import { FaceDownError } from '../face/index.js';
import { processFound, removeMedia } from '../media/process.js';
import { ORIGINAL_GONE, remakePending } from '../media/upgrade.js';
import { kickRebuild } from '../media/rebuild.js';
import { inVideoLine, processFoundVideo } from '../media/video.js';
import { mimeFromName } from '../drive/index.js';

export const CROWD_FOLDER = 'Crowd uploads';
export const CLOSED_MESSAGE = 'A closed event is not synced, so its album stays as it is. Set the event to Live to sync it again.';

export interface SyncSummary {
  listed: number;
  added: number;
  changed: number;
  removed: number;
  processed: number;
  copies: number;
  failed: number;
}

/**
 * One sync of one event: read the folder, add what is new, re-do what changed,
 * remove what is gone, then process everything that is waiting.
 */
export async function syncEvent(ctx: Ctx, eventId: string): Promise<SyncSummary> {
  const { db, drive } = ctx;
  if (ctx.syncing.has(eventId)) throw new Error('A sync is already running for this event.');
  ctx.syncing.add(eventId);
  const sum: SyncSummary = { listed: 0, added: 0, changed: 0, removed: 0, processed: 0, copies: 0, failed: 0 };
  try {
    const event = (await db.query<any>(`select id, status, onedrive_folder_id, crowd_folder_id, auto_approve from events where id = $1`, [eventId])).rows[0];
    if (!event?.onedrive_folder_id) throw new Error('Pick the event folder first.');
    // A closed event's album lives on from its copies in OneDrive's app folder after the originals are moved or deleted (plan: Folder rules).
    // Syncing it would empty the album, so it is refused here, whoever asks.
    if (event.status === 'closed' || event.status === 'archived') throw new Error(CLOSED_MESSAGE);
    if (!(await ctx.face.health())) throw new FaceDownError('The face service is not running. Start it (npm run face); the next sync carries on from here.');

    // Read what we know BEFORE listing the folder, so a photo a student uploads during the sync is never mistaken for a deleted file.
    const known = await db.query<any>(`select id, onedrive_item_id, ctag, source, status, status_reason, name, section_id, review from media where event_id = $1 and onedrive_item_id is not null`, [eventId]);
    const tree = await listTree(drive, event.onedrive_folder_id);
    sum.listed = tree.files.length;

    // Subfolders become sections (shown as album sections from version 1.1).
    const sectionOf = new Map<string, string>();
    for (const [i, f] of tree.folders.entries()) {
      const s = await db.query<{ id: string }>(
        `insert into sections (event_id, title, onedrive_folder_id, sort) values ($1, $2, $3, $4)
         on conflict (event_id, onedrive_folder_id) do update set title = excluded.title, sort = excluded.sort returning id`,
        [eventId, f.name, f.id, i],
      );
      sectionOf.set(f.id, s.rows[0].id);
    }
    // The students' folder: remembered by its ID, forgotten when it is no longer there (an upload then makes it again).
    const crowdFolder = tree.folders.find((f) => f.name.toLowerCase() === CROWD_FOLDER.toLowerCase()) ?? null;
    if ((crowdFolder?.id ?? null) !== (event.crowd_folder_id ?? null)) {
      await db.query(`update events set crowd_folder_id = $2 where id = $1`, [eventId, crowdFolder?.id ?? null]);
    }

    const byItem = new Map<string, any>(known.rows.map((r) => [r.onedrive_item_id, r]));
    const seen = new Set<string>();
    const leftovers: any[] = []; // rejected uploads whose file the app could not delete earlier

    for (const file of tree.files) {
      const kind = classify(file.name);
      const section = sectionOf.get(file.folderId) ?? null;
      const row = byItem.get(file.id);
      if (!row) {
        const skip = processable(kind) ? null : SKIP_REASON[kind];
        // Anything that turns up in the Crowd uploads folder follows the students' rules: it waits for review
        // (unless the event approves by itself), and a copy of a photo that is already there is never shown.
        const inCrowd = !!crowdFolder && file.folderId === crowdFolder.id;
        await db.query(
          `insert into media (event_id, section_id, type, status, status_reason, name, bytes, onedrive_item_id, ctag, taken_at, source, review, mime)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           on conflict (event_id, onedrive_item_id) do nothing`,
          [
            eventId,
            section,
            kind === 'video' ? 'video' : 'photo',
            skip ? 'skipped' : 'found',
            skip,
            file.name,
            file.size,
            file.id,
            file.ctag,
            file.takenAt ?? file.modifiedAt,
            inCrowd ? 'crowd' : 'onedrive',
            inCrowd && !event.auto_approve ? 'pending' : 'approved',
            file.mime ?? mimeFromName(file.name),
          ],
        );
        sum.added++;
        continue;
      }
      seen.add(row.id);
      if (row.review === 'rejected') {
        leftovers.push(row);
        continue;
      }
      // Listed again: an original once marked as gone is there after all.
      if (row.status_reason === ORIGINAL_GONE) await db.query(`update media set status_reason = null where id = $1 and status_reason = $2`, [row.id, ORIGINAL_GONE]);
      if (row.status === 'skipped' && processable(kind)) {
        // Listed as skipped by an earlier version of the app that could not read this kind of file (iPhone HEIC
        // photos): it can now, so the file is taken in.
        await db.query(`update media set status = 'found', status_reason = null, type = $2, ctag = $3, bytes = $4, name = $5, section_id = $6 where id = $1 and status = 'skipped'`, [
          row.id,
          kind,
          file.ctag,
          file.size,
          file.name,
          section,
        ]);
        sum.changed++;
      } else if ((row.source === 'onedrive' || row.ctag) && row.ctag !== file.ctag && processable(kind)) {
        // The content tag differs: process the file again. A student's photo too, when an organiser edits it in
        // Crowd uploads (to paint someone out, say): the album and the downloads follow the edit (processFound drops
        // the full-quality copies of the earlier content).
        await db.query(`update media set ctag = $2, bytes = $3, name = $4, section_id = $5, status = 'found' where id = $1 and status <> 'processing'`, [row.id, file.ctag, file.size, file.name, section]);
        sum.changed++;
      } else if (row.name !== file.name || row.section_id !== section) {
        await db.query(`update media set name = $2, section_id = $3 where id = $1`, [row.id, file.name, section]); // renamed or moved: same file
      }
    }

    // Files that are no longer in the folder leave the album.
    for (const row of known.rows) {
      if (seen.has(row.id)) continue;
      if (row.review === 'rejected') {
        // A rejected upload whose file is gone: the row stays, so the same picture is still refused if it is sent again.
        await db.query(`update media set onedrive_item_id = null, ctag = null where id = $1`, [row.id]);
        continue;
      }
      await removeMedia(ctx, row.id);
      sum.removed++;
    }
    for (const row of leftovers) {
      try {
        await drive.remove(row.onedrive_item_id);
        await db.query(`update media set onedrive_item_id = null, ctag = null where id = $1`, [row.id]);
      } catch (e) {
        ctx.log(`a rejected upload is still in the Crowd uploads folder: ${(e as Error).message}`);
      }
    }

    // Process everything that is waiting. A copy that takes over shows up here as 'found' too.
    // Photos go through the photo workers, videos through their own line (one at a time), side by side.
    let videoTools: Error | null = null;
    for (let round = 0; round < 5; round++) {
      const todo = await db.query<{ id: string; type: string }>(`select id, type from media where event_id = $1 and status = 'found' and type in ('photo', 'video') order by created_at, id`, [eventId]);
      if (!todo.rows.length) break;
      let progress = 0;
      // OneDrive needing a reconnect, or the face service stopping, ends the round at once: the photos not started yet stay waiting.
      let stop: unknown = null;
      const results = await Promise.all(
        todo.rows.map((r) => {
          const job = async () => {
            if (stop) return 'waiting' as const;
            try {
              return r.type === 'video' ? await processFoundVideo(ctx, r.id) : await processFound(ctx, r.id);
            } catch (e) {
              // ffmpeg missing holds back only the videos: they wait ('found') and the photos carry on.
              if ((e as Error)?.name === 'VideoToolsError') {
                videoTools ??= e as Error;
                return 'gone' as const;
              }
              stop ??= e;
              return 'waiting' as const;
            }
          };
          return r.type === 'video' ? inVideoLine(job) : ctx.work.push(job);
        }),
      );
      if (stop) throw stop;
      for (const r of results) {
        if (r === 'ready') sum.processed++;
        else if (r === 'copy') sum.copies++;
        else if (r === 'failed') sum.failed++;
        if (r !== 'gone') progress++;
      }
      if (!progress) break; // only files the drive could not hand over just now: they wait for the next sync
    }
    const toolsMissing = videoTools as Error | null; // set inside the jobs above
    if (toolsMissing) ctx.log(`videos wait: ${toolsMissing.message}`);

    await db.query(`update events set last_sync_at = now(), sync_error = null, sync_failures = 0 where id = $1`, [eventId]);
    ctx.bump(eventId);
    // Album copies left to be made again (an Improve photos switch that met OneDrive down, a restart): in the background.
    void remakePending(ctx, eventId).catch((e) => ctx.log(`could not make album copies again: ${(e as Error).message}`));
    kickRebuild(ctx); // copies missing in OneDrive (or still on this Mac) are made now that OneDrive answers
    return sum;
  } catch (e) {
    const msg =
      e instanceof DriveNotFoundError ? 'The event folder is no longer in OneDrive.' : (e as Error)?.name === 'DriveAuthError' ? 'Reconnect OneDrive.' : (e as Error).message;
    if (msg !== CLOSED_MESSAGE) {
      // Two failures in a row raise the "Sync is failing" alert (alerts/alerts.ts). A closed event and the face
      // service being down are not the sync's fault: they are not counted (face_down has its own alert).
      const counted = !(e instanceof FaceDownError) && (e as Error)?.name !== 'FaceDownError';
      await db.query(`update events set sync_error = $2${counted ? ', sync_failures = sync_failures + 1' : ''} where id = $1`, [eventId, msg.slice(0, 300)]);
    }
    throw e;
  } finally {
    ctx.syncing.delete(eventId);
  }
}

/** Start a sync in the background (Sync now). Errors are kept on the event for the sync screen. */
export function startSync(ctx: Ctx, eventId: string): boolean {
  if (ctx.syncing.has(eventId)) return false;
  syncEvent(ctx, eventId).catch((e) => ctx.log(`sync failed: ${(e as Error).message}`));
  return true;
}

/** Every minute, sync the Draft and Live events whose last sync is older than the interval. */
export function startScheduler(ctx: Ctx): NodeJS.Timeout {
  const tick = async () => {
    try {
      const due = await ctx.db.query<{ id: string }>(
        `select id from events
          where status in ('draft', 'live') and onedrive_folder_id is not null
            and (last_sync_at is null or last_sync_at < now() - ($1 || ' minutes')::interval)`,
        [String(ctx.cfg.syncIntervalMin)],
      );
      for (const e of due.rows) startSync(ctx, e.id);
    } catch (e) {
      ctx.log(`scheduler: ${(e as Error).message}`);
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  void tick();
  return timer;
}
