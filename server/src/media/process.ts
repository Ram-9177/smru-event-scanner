import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db/index.js';
import { DriveNotFoundError } from '../drive/index.js';
import { vectorToBuffer, type FoundFace } from '../face/index.js';
import { decideOfficial, findCopyForUpload, releaseCopies } from './duplicates.js';
import { describeScene, decideBurst } from './bursts.js';
import { mediaChanged } from './after.js';
import { removePeopleCopies } from '../people/filing.js';
import { isHeicName, legacySceneKey, tempPath } from './files.js';
import { displayCopy, prepare, sceneCopy, type Look, type Prepared } from './prepare.js';
import { dropUnwanted, videoToolsReady, VideoToolsError } from './video.js';
import { dropFullCopies } from './fullcopy.js';
import { emptyCopyTrashSoon, forget, putCopies, putCopy, removeLegacy } from './copies.js';
import { purgeKeys } from './copyurls.js';

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function insertFaces(q: Queryable, eventId: string, mediaId: string, faces: FoundFace[], model: string): Promise<void> {
  for (let i = 0; i < faces.length; i += 50) {
    const chunk = faces.slice(i, i + 50);
    const values: string[] = [];
    const params: unknown[] = [eventId, mediaId, model];
    chunk.forEach((f, k) => {
      const b = 4 + k * 6;
      values.push(`($1, $2, $${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $3)`);
      params.push(vectorToBuffer(f.vector), Math.round(f.x), Math.round(f.y), Math.round(f.w), Math.round(f.h), f.score);
    });
    await q.query(`insert into faces (event_id, media_id, embedding, box_x, box_y, box_w, box_h, det_score, model) values ${values.join(', ')}`, params);
  }
}

/** The fix an event's photos get, if the event has "Improve photos" on (it is on unless an organiser turns it off). */
export async function lookToApply(q: Queryable, eventId: string, look: Look | null): Promise<Look | null> {
  if (!look) return null;
  const on = (await q.query<{ improve_photos: boolean }>(`select improve_photos from events where id = $1`, [eventId])).rows[0]?.improve_photos;
  return on === false ? null : look;
}

/** Display copies (into OneDrive) and face vectors for a photo that is going to be shown. */
export async function finishPhoto(ctx: Ctx, eventId: string, mediaId: string, prep: Prepared): Promise<void> {
  const { cfg, db } = ctx;
  // Light copies for the album (WebP), with the photo's fix; the original keeps the full quality for downloads.
  const look = await lookToApply(db, eventId, prep.look);
  const before = (await db.query<{ thumb_key: string | null; web_key: string | null; sha256: string | null }>(`select thumb_key, web_key, sha256 from media where id = $1`, [mediaId])).rows[0];
  const [t, w] = await Promise.all([displayCopy(prep.work, cfg.thumbMaxPx, 72, look), displayCopy(prep.work, cfg.webMaxPx, 80, look)]);
  const [tKey, wKey] = await putCopies(ctx, eventId, mediaId, [
    { kind: 't', body: t, ext: 'webp' },
    { kind: 'w', body: w, ext: 'webp' },
  ]);
  let settled = false;
  try {
    const faces = await ctx.face.faces(prep.work, cfg.minFacePx);
    // A student's photo rejected (or a row removed) while this ran: nothing is written back. The copies it replaces
    // are queued for deletion by the database (copy_trash) in the same transaction.
    const kept = await db.tx(async (q) => {
      const done = await q.query(
        `update media set status = 'ready', status_reason = null, thumb_key = $2, web_key = $3, face_count = $4, look = $5, copies_fixed = $6,
                sha256 = $7, processed_at = now(), copies_missing = false, copies_lost = false, copies_tries = 0, copies_error = null
          where id = $1 and status in ('processing', 'ready') and review <> 'rejected'`,
        [mediaId, tKey, wKey, faces.length, prep.look ? JSON.stringify(prep.look) : null, look != null, prep.sha256],
      );
      if (!done.rowCount) return false;
      await q.query(`delete from faces where media_id = $1`, [mediaId]);
      await insertFaces(q, eventId, mediaId, faces, ctx.face.model);
      return true;
    });
    settled = true;
    if (!kept) {
      await dropUnwanted(ctx, mediaId, [tKey, wKey]);
      return;
    }
  } finally {
    if (!settled) await forget(ctx, [tKey, wKey]); // never reached the database: nothing is left in OneDrive
  }
  emptyCopyTrashSoon(ctx);
  await purgeKeys(ctx, [before?.thumb_key, before?.web_key]);
  // Copies kept on this server before photos lived only in OneDrive.
  await removeLegacy(cfg, [before?.thumb_key, before?.web_key]);
  // Read again from an original that changed (edited in OneDrive): full-quality copies of the earlier one go.
  if (before?.sha256 && before.sha256 !== prep.sha256) await dropFullCopies(ctx, [mediaId]);
  ctx.bump(eventId);
  // The same shot taken twice (burst shots): only the better one stays shown. Never stops the photo from showing.
  // Its scene is always described (from the neutral copy, while the bytes are here), so "Look for duplicates" can
  // compare it later even when the rule is off now. The photo is shown already: nothing here takes it back.
  let described = false;
  try {
    await describeScene(ctx, eventId, mediaId, await sceneCopy(prep.work));
    described = true;
  } catch (e) {
    ctx.log(`could not describe a photo for duplicates (it is described when it is next compared): ${reasonOf(e)}`);
  }
  if (described && cfg.burstDuplicates) {
    try {
      await decideBurst(ctx, eventId, mediaId);
    } catch (e) {
      if ((e as Error)?.name === 'FaceDownError') throw e; // the sync stops and tries again; the photo stays shown
      ctx.log(`could not compare a photo for duplicates: ${reasonOf(e)}`);
    }
  }
  await mediaChanged(ctx, [mediaId]);
}

/**
 * Process one of your files that the sync job found: download once, fix rotation,
 * fingerprints, duplicate decision, then display copies and faces if it is the one to show.
 */
export async function processFound(ctx: Ctx, mediaId: string): Promise<'ready' | 'copy' | 'failed' | 'gone'> {
  const { cfg, db } = ctx;
  // An iPhone (HEIC) photo needs ffmpeg: without it, it is not downloaded at all and waits (as 'found'), as a video does.
  const waiting = (await db.query<{ name: string | null }>(`select name from media where id = $1 and status = 'found' and type = 'photo'`, [mediaId])).rows[0];
  if (waiting && isHeicName(waiting.name) && !(await videoToolsReady(cfg))) {
    await db.query(`update media set status_reason = $2 where id = $1 and status = 'found'`, [mediaId, 'Waiting: ffmpeg is not installed on the server, so iPhone (HEIC) photos cannot be read yet.']);
    throw new VideoToolsError(`${cfg.ffmpegPath} was not found: it is needed to read iPhone (HEIC) photos. Install ffmpeg, or set FFMPEG_PATH.`);
  }
  const row = (
    await db.query<any>(`update media set status = 'processing', status_reason = null where id = $1 and status = 'found' and type = 'photo' returning *`, [mediaId])
  ).rows[0];
  if (!row) return 'gone';
  const tmp = tempPath(cfg, `${row.id}.orig`);
  try {
    await ctx.drive.download(row.onedrive_item_id, tmp);
    const prep = await prepare(tmp, cfg);
    // Its content changed since it was last read: full-quality copies of the earlier content go.
    if (row.sha256 && row.sha256 !== prep.sha256) await dropFullCopies(ctx, [row.id]);
    if (row.source === 'crowd' && row.sha256) {
      // A student's photo whose finishing was interrupted: its duplicate decision was made at upload.
      await finishPhoto(ctx, row.event_id, row.id, prep);
      return 'ready';
    }
    const phash = await ctx.face.fingerprint(prep.work);
    if (row.source === 'crowd') {
      // A file that turned up in the Crowd uploads folder by itself: the same rule as an upload.
      // If it copies any photo of the event (hidden and rejected ones count), it is marked as a copy and never shown.
      const keeper = await ctx.eventLock.run(row.event_id, () =>
        db.tx(async (q) => {
          const hit = await findCopyForUpload(q, row.event_id, prep.sha256, phash, cfg.dupBits, row.id);
          const of = hit ? ((await q.query<{ id: string }>(`select coalesce(duplicate_of, id) as id from media where id = $1`, [hit.id])).rows[0]?.id ?? hit.id) : null;
          await q.query(
            `update media set sha256 = $2, phash = $3, width = $4, height = $5, taken_at = coalesce($6, taken_at), duplicate_of = $7 where id = $1`,
            [row.id, prep.sha256, phash, prep.width, prep.height, prep.takenAt, of],
          );
          return of;
        }),
      );
      if (keeper) return await finishCopy(ctx, row, prep);
      await finishPhoto(ctx, row.event_id, row.id, prep);
      return 'ready';
    }
    let demoted: string[] = [];
    const copyOf = await ctx.eventLock.run(row.event_id, () =>
      db.tx(async (q) => {
        const heir = await releaseCopies(q, row.id, false); // copies of this file's earlier content, if it changed
        const of = row.keep_both ? null : await decideOfficial(q, row.event_id, row.id, prep.sha256, phash, cfg.dupBits);
        await q.query(
          `update media set sha256 = $2, phash = $3, width = $4, height = $5, taken_at = coalesce($6, taken_at), duplicate_of = $7 where id = $1`,
          [row.id, prep.sha256, phash, prep.width, prep.height, prep.takenAt, of],
        );
        // Its earlier copies went to the heir above, so what points at it now are students' photos it just took over
        // from (decideOfficial marked them as copies): they leave the People folders.
        demoted = (await q.query<{ id: string }>(`select id from media where duplicate_of = $1`, [row.id])).rows.map((x) => x.id);
        if (heir) demoted.push(heir);
        return of;
      }),
    );
    if (demoted.length) {
      ctx.bump(row.event_id);
      await mediaChanged(ctx, demoted);
    }
    if (copyOf) return await finishCopy(ctx, row, prep);
    await finishPhoto(ctx, row.event_id, row.id, prep);
    return 'ready';
  } catch (e) {
    if (e instanceof DriveNotFoundError) {
      // The drive listed this file a moment ago and now says it is not there. It may have been deleted in between,
      // or the drive may be mistaken for a moment. Nothing is removed here: the row waits, and the next sync's
      // listing decides. (Removing it now would also forget that the photo was hidden, if it comes back.)
      await db.query(`update media set status = 'found' where id = $1 and status = 'processing'`, [row.id]);
      return 'gone';
    }
    if (['DriveAuthError', 'DriveDownError', 'FaceDownError', 'VideoToolsError'].includes((e as Error)?.name)) {
      // Nothing is wrong with this photo: OneDrive needs reconnecting or cannot be reached, the face service is not running,
      // or ffmpeg (needed for an iPhone HEIC photo) is not installed. It waits for the next sync. (A photo that was
      // shown already, before the step that failed, stays shown.)
      await db.query(`update media set status = 'found' where id = $1 and status = 'processing'`, [row.id]);
      throw e;
    }
    await db.query(`update media set status = 'failed', status_reason = $2 where id = $1 and status = 'processing'`, [row.id, reasonOf(e)]);
    ctx.log(`could not process ${row.name}: ${reasonOf(e)}`);
    return 'failed';
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

/** A copy keeps a thumbnail for the Media manager and stops there: no web copy, no scene, no faces. */
async function finishCopy(ctx: Ctx, row: any, prep: Prepared): Promise<'copy'> {
  const { cfg, db } = ctx;
  const tKey = await putCopy(ctx, row.event_id, row.id, 't', await displayCopy(prep.work, cfg.thumbMaxPx, 72, await lookToApply(db, row.event_id, prep.look)), 'webp');
  try {
    await db.tx(async (q) => {
      await q.query(`delete from faces where media_id = $1`, [row.id]);
      // The web copy and the scene description it had go (the database queues them for deletion).
      await q.query(
        `update media set status = 'ready', thumb_key = $2, web_key = null, scene_key = null, face_count = null, processed_at = now(),
                copies_missing = false, copies_lost = false, copies_tries = 0, copies_error = null where id = $1`,
        [row.id, tKey],
      );
    });
  } catch (e) {
    await forget(ctx, [tKey]);
    throw e;
  }
  emptyCopyTrashSoon(ctx);
  await purgeKeys(ctx, [row.web_key, row.thumb_key]);
  await removeLegacy(cfg, [row.web_key, row.thumb_key, legacySceneKey(row.event_id, row.id)]);
  ctx.bump(row.event_id);
  // A photo that was shown (and filed) before its content changed into a copy leaves the People folders.
  await mediaChanged(ctx, [row.id]);
  return 'copy';
}

/**
 * Read one shown photo again: fresh display copies and face vectors, nothing else changes
 * (not what is hidden, not which photo is a copy of which). Used by "Read every photo again".
 */
export async function rereadPhoto(ctx: Ctx, mediaId: string): Promise<'ready' | 'gone' | 'skipped'> {
  const row = (await ctx.db.query<any>(`select id, event_id, onedrive_item_id from media where id = $1 and status = 'ready' and duplicate_of is null and type = 'photo'`, [mediaId])).rows[0];
  if (!row?.onedrive_item_id) return 'skipped';
  const tmp = tempPath(ctx.cfg, `${row.id}-${randomUUID()}.again`); // its own name: another job may be reading this photo
  try {
    await ctx.drive.download(row.onedrive_item_id, tmp);
    await finishPhoto(ctx, row.event_id, row.id, await prepare(tmp, ctx.cfg));
    return 'ready';
  } catch (e) {
    if (e instanceof DriveNotFoundError) return 'gone'; // the original is no longer in OneDrive: what the app has stays as it is
    throw e;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

/**
 * Make a shown photo's album copies again from its original, with or without its fix (after "Improve photos" was
 * switched, or to bring an older album to WebP). Faces, copies and what is hidden stay exactly as they are.
 */
export async function remakeCopies(ctx: Ctx, mediaId: string): Promise<'ready' | 'gone' | 'skipped'> {
  const { cfg, db } = ctx;
  const SHOWN = `status = 'ready' and duplicate_of is null and type = 'photo' and review <> 'rejected'`;
  const row = (
    await db.query<any>(`select id, event_id, onedrive_item_id, thumb_key, web_key, scene_key, sharpness, sha256, processed_at::text as processed_at from media where id = $1 and ${SHOWN}`, [mediaId])
  ).rows[0];
  if (!row?.onedrive_item_id) return 'skipped';
  const tmp = tempPath(cfg, `${row.id}-${randomUUID()}.again`); // its own name: another job may be reading this photo
  let fresh: string[] = [];
  let taken = false;
  try {
    await ctx.drive.download(row.onedrive_item_id, tmp);
    const prep = await prepare(tmp, cfg);
    const look = await lookToApply(db, row.event_id, prep.look);
    // New files under new names: the row's copies are never overwritten by ones it may not take.
    fresh = await putCopies(ctx, row.event_id, row.id, [
      { kind: 't', body: await displayCopy(prep.work, cfg.thumbMaxPx, 72, look), ext: 'webp' },
      { kind: 'w', body: await displayCopy(prep.work, cfg.webMaxPx, 80, look), ext: 'webp' },
    ]);
    // Onto the row in one step with the check that it is still the same shown photo (not rejected, not a copy, not
    // removed, and not processed again from new content meanwhile): the event lock is what those changes take too.
    const done = await ctx.eventLock.run(row.event_id, async () => {
      const n = await db.query(
        `update media set thumb_key = $3, web_key = $4, look = $5, copies_fixed = $6, sha256 = $7, copies_missing = false
          where id = $1 and ${SHOWN} and processed_at::text is not distinct from $2`,
        [row.id, row.processed_at /* as text: exact to the microsecond */, fresh[0], fresh[1], prep.look ? JSON.stringify(prep.look) : null, look != null, prep.sha256],
      );
      return n.rowCount > 0;
    });
    if (!done) return 'skipped'; // it became a copy, was rejected or left meanwhile: its own keys are looked after by that change
    taken = true;
    emptyCopyTrashSoon(ctx); // the copies it replaced
    await purgeKeys(ctx, [row.thumb_key, row.web_key]);
    await removeLegacy(cfg, [row.thumb_key, row.web_key]);
    if (row.sha256 && row.sha256 !== prep.sha256) await dropFullCopies(ctx, [row.id]); // edited in OneDrive since
    // An older photo without its scene description gets one from the original (never from the fixed WebP copy).
    // Optional: the copies are remade whatever happens here.
    if (row.sharpness == null || !row.scene_key) {
      try {
        await describeScene(ctx, row.event_id, row.id, await sceneCopy(prep.work));
      } catch (e) {
        ctx.log(`could not describe a photo for duplicates: ${reasonOf(e)}`);
      }
    }
    // Faces are unchanged: the event's face index stays as it is (no ctx.bump).
    return 'ready';
  } catch (e) {
    if (e instanceof DriveNotFoundError) return 'gone';
    throw e;
  } finally {
    await fs.promises.rm(tmp, { force: true });
    if (!taken) await forget(ctx, fresh); // not taken (the photo changed meanwhile, or this failed): nothing is left
  }
}

/** Remove a photo from the app (its file is gone from the folder). Its copy, if it has one, takes its place. */
export async function removeMedia(ctx: Ctx, mediaId: string): Promise<string | null> {
  const { db, cfg } = ctx;
  const row = (await db.query<any>(`select id, event_id, hidden, thumb_key, web_key, video_key, scene_key, clean_key from media where id = $1`, [mediaId])).rows[0];
  if (!row) return null;
  // Its copies leave the People folders first (the rows that remember them go with the media row).
  await removePeopleCopies(ctx, row.id);
  const heir = await ctx.eventLock.run(row.event_id, () =>
    db.tx(async (q) => {
      const h = await releaseCopies(q, row.id, row.hidden);
      await q.query(`update events set cover_media_id = null where cover_media_id = $1`, [row.id]);
      await q.query(`delete from media where id = $1`, [row.id]);
      return h;
    }),
  );
  // Its copies in OneDrive were queued for deletion with the row (and its full copies with theirs).
  await dropFullCopies(ctx, [row.id]);
  emptyCopyTrashSoon(ctx);
  await purgeKeys(ctx, [row.thumb_key, row.web_key, row.video_key]);
  await removeLegacy(cfg, [row.thumb_key, row.web_key, row.video_key, legacySceneKey(row.event_id, row.id)]);
  ctx.bump(row.event_id);
  if (heir) await mediaChanged(ctx, [heir]); // the copy that is shown now takes its place in the People folders
  return heir;
}
