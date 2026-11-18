import fs from 'node:fs';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db/index.js';
import { DriveNotFoundError, mimeFromName, type DriveEntry } from '../drive/index.js';
import { sha256File } from '../lib/hashes.js';
import { findSameFile, finishUploadedVideo, probeVideo } from './video.js';
import { CROWD_FOLDER } from '../sync/sync.js';
import { randomToken } from '../lib/security.js';
import { findCopyForUpload, releaseCopies } from './duplicates.js';
import { finishPhoto } from './process.js';
import { prepare } from './prepare.js';

/** Photos taken in: JPEG, PNG, WebP, and iPhone HEIC/HEIF (read through ffmpeg; downloaded as full-quality JPEG). */
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
export const uploadTypeOk = (mime: string) => mime in EXT;

export type UploadResult = { result: 'added'; id: string; review: 'pending' | 'approved' } | { result: 'skipped' } | { result: 'limit' };

/** Who sent the photo: a student's phone (Add your photos), or an organiser in the admin console. */
export type Uploader = { kind: 'guest'; guestId: string; name: string | null } | { kind: 'organiser'; email: string; fileName: string | null };

/** A file name safe for OneDrive and Windows, from the name on the organiser's computer. */
function safeBase(fileName: string | null): string | null {
  if (!fileName) return null;
  const base = fileName.replace(/\.[^.]*$/, '');
  const clean = base
    .replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, 80)
    .trim();
  return clean || null;
}

/**
 * One photo from a student's phone (plan: "What the server does with each uploaded photo").
 *   1. the caller has checked the event, the file type and the phone's limit
 *   2. fix rotation, working copy, two fingerprints; a copy of any photo the event has stops here
 *   3. save the original into the Crowd uploads folder of the event's OneDrive folder
 *   4. answer the phone; display copies and faces are made in the background
 */
export async function ingestUpload(ctx: Ctx, event: any, guestId: string, data: Buffer, mime: string, uploaderName: string | null): Promise<UploadResult> {
  return ingest(ctx, event, data, mime, { kind: 'guest', guestId, name: uploaderName });
}

/**
 * One photo from an organiser, sent from the admin console. The same steps as a student's photo, except:
 * no per-phone limit, shown without review, and saved straight into the event's own OneDrive folder
 * (as if the organiser had put it there in OneDrive), under its own name plus a short code so it never
 * replaces another file of the same name. The caller has made sure the event has its folder.
 */
export async function ingestOrganiserPhoto(ctx: Ctx, event: any, data: Buffer, mime: string, email: string, fileName: string | null): Promise<UploadResult> {
  return ingest(ctx, event, data, mime, { kind: 'organiser', email, fileName });
}

/** The name the file gets in OneDrive: the organiser's own name (or the time, for a student) plus a short code. */
function fileNameFor(from: Uploader, ext: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const base = from.kind === 'guest' ? null : safeBase(from.fileName);
  return `${base ?? stamp}-${randomToken(4)}.${ext}`;
}

/**
 * Save the file of a reserved row into OneDrive (a student's into Crowd uploads, an organiser's straight into the
 * event folder) and remember where it is. If anything fails the row is removed again and the phone's count given back.
 * Returns the sync's row instead when a sync took the saved file in at that very moment; null otherwise.
 */
async function saveReserved(ctx: Ctx, event: any, mediaId: string, from: Uploader, put: (parentId: string) => Promise<DriveEntry>): Promise<UploadResult | null> {
  const { db } = ctx;
  const guest = from.kind === 'guest';
  try {
    const folder = async (fresh: boolean): Promise<string> => {
      if (!fresh && event.crowd_folder_id) return event.crowd_folder_id;
      const id = (await ctx.drive.createFolder(event.onedrive_folder_id, CROWD_FOLDER)).id;
      await db.query(`update events set crowd_folder_id = $2 where id = $1`, [event.id, id]);
      return id;
    };
    let saved: DriveEntry;
    if (!guest) {
      // Straight into the event folder. If that folder was deleted in OneDrive the organiser has to pick one again.
      saved = await put(event.onedrive_folder_id);
    } else {
      try {
        saved = await put(await folder(false));
      } catch (e) {
        // Someone deleted the Crowd uploads folder in OneDrive: make it again, once.
        if (!(e instanceof DriveNotFoundError) || !event.crowd_folder_id) throw e;
        saved = await put(await folder(true));
      }
    }
    try {
      await db.query(`update media set onedrive_item_id = $2, ctag = $3, name = $4 where id = $1`, [mediaId, saved.id, saved.ctag, saved.name]);
    } catch (e: any) {
      if (e?.code !== '23505') throw e;
      // A sync that ran at this very moment has already taken the saved file in: keep its row, drop ours.
      const theirs = (await db.query<{ id: string; review: 'pending' | 'approved' }>(`select id, review from media where event_id = $1 and onedrive_item_id = $2`, [event.id, saved.id])).rows[0];
      await db.query(`delete from media where id = $1`, [mediaId]);
      if (!theirs) throw e;
      return { result: 'added', id: theirs.id, review: theirs.review };
    }
    return null;
  } catch (e) {
    await db.tx(async (q) => {
      await q.query(`delete from media where id = $1`, [mediaId]);
      if (guest) await q.query(`update guests set upload_count = greatest(upload_count - 1, 0) where id = $1`, [from.guestId]);
    });
    throw e;
  }
}

/**
 * At start: uploads that a stopped server left half done.
 *   - with their file in OneDrive: back in the line ('found'), so the next sync finishes them
 *   - without: nothing was saved under that row, so it goes, a student's or an organiser's alike. A student's phone gets
 *     its upload back. (If the file did reach OneDrive after all, the next sync takes it in as a new file.)
 * Left behind, an organiser's row would stay 'processing' for good, refuse the same file again as a copy, and could
 * even be picked as the original over the real file when the sync finds it.
 */
export async function recoverInterruptedUploads(db: Queryable): Promise<{ requeued: number; removed: number }> {
  const requeued = (await db.query(`update media set status = 'found' where status = 'processing' and onedrive_item_id is not null`)).rowCount ?? 0;
  // An upload cut off before its file reached the drive saved nothing: its row goes. A row that other rows were
  // already marked copies of hands that over first (the first copy becomes the shown one), so nothing points at a
  // row that is gone. A student's upload that was rejected while it waited keeps its row: its fingerprints are
  // what refuse the same picture next time.
  const stuck = (
    await db.query<{ id: string; hidden: boolean }>(
      `select id, hidden from media where status = 'processing' and onedrive_item_id is null and review <> 'rejected' order by created_at`,
    )
  ).rows;
  for (const m of stuck) await releaseCopies(db, m.id, m.hidden);
  const removed = await db.query<{ n: number }>(
    `with gone as (
       delete from media where id = any($1::uuid[])
       returning source, uploader_guest_id
     ), back as (
       update guests g set upload_count = greatest(g.upload_count - x.n, 0)
         from (select uploader_guest_id, count(*)::int as n from gone where source = 'crowd' and uploader_guest_id is not null group by 1) x
        where g.id = x.uploader_guest_id
       returning g.id
     )
     select (select count(*)::int from gone) as n`,
    [stuck.map((m) => m.id)],
  );
  return { requeued, removed: removed.rows[0]?.n ?? 0 };
}

/** Videos students and organisers can send, and the extension each is saved with. */
const VIDEO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/3gpp': '3gp',
};
export const videoTypeOk = (mime: string) => mime in VIDEO_EXT;

/** A student's video, already streamed to a file on this server. The file is this function's from now on: it is always removed. */
export function ingestVideoUpload(ctx: Ctx, event: any, guestId: string, file: string, mime: string, uploaderName: string | null): Promise<UploadResult> {
  return ingestVideo(ctx, event, file, mime, { kind: 'guest', guestId, name: uploaderName });
}

/** An organiser's video from the admin console, already streamed to a file (always removed afterwards). */
export function ingestOrganiserVideo(ctx: Ctx, event: any, file: string, mime: string, email: string, fileName: string | null): Promise<UploadResult> {
  return ingestVideo(ctx, event, file, mime, { kind: 'organiser', email, fileName });
}

/**
 * One video, the same steps as a photo: read it (a file that is not a video stops here, BadVideoError),
 * the very same file as anything the event has is skipped, count and reserve the row, save the file into
 * OneDrive in pieces (uploadFile), answer; poster, preview and faces are made in the video line afterwards.
 */
async function ingestVideo(ctx: Ctx, event: any, file: string, mime: string, from: Uploader): Promise<UploadResult> {
  const { db, cfg } = ctx;
  let handedOff = false;
  try {
    const info = await probeVideo(cfg, file);
    const sha256 = await sha256File(file);
    const bytes = (await fs.promises.stat(file)).size;
    const guest = from.kind === 'guest';
    const review = !guest || event.auto_approve ? 'approved' : 'pending';
    const reserved = await ctx.eventLock.run(event.id, () =>
      db.tx(async (q) => {
        if (await findSameFile(q, event.id, sha256)) return 'skipped' as const;
        if (guest) {
          const counted = await q.query(`update guests set upload_count = upload_count + 1 where id = $1 and upload_count < $2`, [from.guestId, cfg.uploadsPerPhone]);
          if (!counted.rowCount) return 'limit' as const;
        }
        const row = await q.query<{ id: string }>(
          `insert into media (event_id, type, status, bytes, width, height, duration_ms, mime, taken_at, sha256, source, review, uploader_name, uploader_guest_id)
           values ($1, 'video', 'processing', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
          [event.id, bytes, info.width, info.height, info.durationMs, mime, info.takenAt ?? new Date(), sha256, guest ? 'crowd' : 'onedrive', review, guest ? from.name : null, guest ? from.guestId : null],
        );
        return { id: row.rows[0].id };
      }),
    );
    if (reserved === 'skipped' || reserved === 'limit') return { result: reserved };
    const name = fileNameFor(from, VIDEO_EXT[mime]);
    const raced = await saveReserved(ctx, event, reserved.id, from, (parentId) => ctx.drive.uploadFile(parentId, name, file, mime));
    if (raced) return raced;
    handedOff = true;
    finishUploadedVideo(ctx, event.id, reserved.id, file, info);
    return { result: 'added', id: reserved.id, review };
  } finally {
    if (!handedOff) await fs.promises.rm(file, { force: true });
  }
}

async function ingest(ctx: Ctx, event: any, data: Buffer, mime: string, from: Uploader): Promise<UploadResult> {
  const { db, cfg } = ctx;
  const prep = await prepare(data, cfg);
  const phash = await ctx.face.fingerprint(prep.work);
  const guest = from.kind === 'guest';
  const review = !guest || event.auto_approve ? 'approved' : 'pending';

  // Decide, count and reserve the row in one step, so two phones sending the same picture cannot both get in
  // and one phone sending many at once cannot pass its limit.
  const reserved = await ctx.eventLock.run(event.id, () =>
    db.tx(async (q) => {
      if (await findCopyForUpload(q, event.id, prep.sha256, phash, cfg.dupBits)) return 'skipped' as const;
      if (guest) {
        const counted = await q.query(`update guests set upload_count = upload_count + 1 where id = $1 and upload_count < $2`, [from.guestId, cfg.uploadsPerPhone]);
        if (!counted.rowCount) return 'limit' as const;
      }
      const row = await q.query<{ id: string }>(
        `insert into media (event_id, type, status, bytes, width, height, taken_at, sha256, phash, source, review, uploader_name, uploader_guest_id)
         values ($1, 'photo', 'processing', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [event.id, data.length, prep.width, prep.height, prep.takenAt ?? new Date(), prep.sha256, phash, guest ? 'crowd' : 'onedrive', review, guest ? from.name : null, guest ? from.guestId : null],
      );
      return { id: row.rows[0].id };
    }),
  );
  if (reserved === 'skipped' || reserved === 'limit') return { result: reserved };
  const mediaId = reserved.id;

  const name = fileNameFor(from, EXT[mime]);
  const type = mimeFromName(name) ?? mime;
  const raced = await saveReserved(ctx, event, mediaId, from, (parentId) => ctx.drive.upload(parentId, name, data, type));
  if (raced) return raced;

  // Display copies and faces from the bytes already in hand; the phone does not wait for this.
  void ctx.work
    .push(() => finishPhoto(ctx, event.id, mediaId, prep))
    .catch(async (e) => {
      ctx.log(`could not finish an uploaded photo: ${(e as Error).message}`);
      if (['FaceDownError', 'DriveDownError'].includes((e as Error)?.name)) {
        await db.query(`update media set status = 'found' where id = $1 and status = 'processing'`, [mediaId]).catch(() => {}); // the next sync finishes it (a photo shown already stays shown)
        return;
      }
      await db.query(`update media set status = 'failed', status_reason = $2 where id = $1 and status = 'processing'`, [mediaId, (e as Error).message.slice(0, 300)]).catch(() => {});
    });
  return { result: 'added', id: mediaId, review };
}
