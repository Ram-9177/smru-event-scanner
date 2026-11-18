import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Config } from '../config.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db/index.js';
import { DriveNotFoundError } from '../drive/index.js';
import { vectorToBuffer, type FoundFace } from '../face/index.js';
import { sha256File } from '../lib/hashes.js';
import { Queue } from '../lib/queue.js';
import { mediaChanged } from './after.js';
import { markCopy, releaseCopies } from './duplicates.js';
import { legacySceneKey, tempPath } from './files.js';
import { displayCopy } from './prepare.js';
import { emptyCopyTrashSoon, extOf, forget, putCopies, putCopy, removeLegacy, track } from './copies.js';
import { purgeKeys } from './copyurls.js';
import { cleanVideoCopy } from './videocopy.js';
import { freeBytes } from '../lib/receive.js';
import { hdrFilters, hdrOf, type Hdr } from './hdr.js';
import os from 'node:os';

/**
 * Videos, the same as photos (plan: videos):
 *   - ffprobe reads how long the video is, its size and which way up it is
 *   - a poster frame (near 1 s) becomes the same thumbnail and web copy a photo has
 *   - a light MP4 every browser plays (H.264 + AAC, at most 1280 x 720, 30 fps, 2.5 Mbit/s) is the "video" the album plays
 *   - frames every 2 s (at most 60, spread evenly) go through the face engine; one person seen in several
 *     frames is stored once, with the best view of the face and where in the video it was (faces.at_ms)
 *   - the very same file twice in one event is shown once (sha256); the burst rule is for photos only
 * Videos have their own line of work, one at a time, so a long video never holds up photos.
 */

const videoQueue = new Queue(1);
/** Resolves when no video is being processed or waiting. */
export const videosIdle = () => videoQueue.idle();

/** The file is not a video that can be read. Its message is the plain reason shown in the Media manager. */
export class BadVideoError extends Error {
  constructor(message = 'This file could not be read as a video.') {
    super(message);
    this.name = 'BadVideoError';
  }
}

/** ffmpeg or ffprobe is not there. Nothing is wrong with the video: it waits for the next sync. */
export class VideoToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoToolsError';
  }
}

/** The video is longer than VIDEO_MAX_MINUTES. Refused before anything is saved; its message says why in plain words. */
export class VideoTooLongError extends Error {
  constructor(public maxMinutes: number) {
    const longest = maxMinutes >= 1 ? `${Math.round(maxMinutes)} minute${Math.round(maxMinutes) === 1 ? '' : 's'}` : `${Math.round(maxMinutes * 60)} seconds`;
    super(`This video is longer than ${longest}. Send a shorter clip.`);
    this.name = 'VideoTooLongError';
  }
}

/** Trouble that is not the file's fault: the row waits ('found') and the next sync carries on. */
const WAITS = ['DriveAuthError', 'DriveDownError', 'FaceDownError', 'VideoToolsError'];
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

type Tools = Pick<Config, 'ffmpegPath' | 'ffprobePath'> & Partial<Pick<Config, 'videoMaxMinutes'>>;

/** The longest stretch of a video that is ever worked on, in milliseconds (VIDEO_MAX_MINUTES; 30 minutes when not set). */
const maxMs = (cfg: Tools) => (cfg.videoMaxMinutes && cfg.videoMaxMinutes > 0 ? cfg.videoMaxMinutes : 30) * 60_000;

const toolsSeen = new Map<string, { ok: boolean; at: number }>();
/**
 * ffprobe and ffmpeg are there. Asked once a minute at most, so a server without them does not download every waiting
 * video again from OneDrive on each sync only to find it cannot read it.
 */
export async function videoToolsReady(cfg: Tools): Promise<boolean> {
  const key = `${cfg.ffprobePath}|${cfg.ffmpegPath}`;
  const seen = toolsSeen.get(key);
  if (seen && Date.now() - seen.at < 60_000) return seen.ok;
  let ok = true;
  for (const cmd of [cfg.ffprobePath, cfg.ffmpegPath]) {
    try {
      await run(cmd, ['-hide_banner', '-version'], 15_000);
    } catch (e) {
      if (e instanceof VideoToolsError) ok = false;
    }
  }
  toolsSeen.set(key, { ok, at: Date.now() });
  return ok;
}

/** Run ffmpeg or ffprobe with an argument list (never through a shell). `low`: at a lower priority than the server. */
function run(cmd: string, args: string[], timeoutMs: number, low = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' });
    if (low && child.pid) {
      try {
        os.setPriority(child.pid, 10); // a long encode never takes the CPU from requests, syncs and the face engine
      } catch {
        /* not allowed here: it runs at the normal priority */
      }
    }
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 20_000) err += c.toString();
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'ENOENT' ? new VideoToolsError(`${cmd} was not found. Install ffmpeg, or set FFMPEG_PATH and FFPROBE_PATH.`) : e);
    });
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(Buffer.concat(out));
      const last = err.trim().split('\n').filter(Boolean).at(-1) ?? '';
      reject(new Error(signal ? `${path.basename(cmd)} took too long` : `${path.basename(cmd)} failed: ${last.slice(0, 200)}`));
    });
  });
}

export interface VideoInfo {
  durationMs: number;
  /** Size as shown, upright (a phone video filmed standing up is taller than wide). */
  width: number;
  height: number;
  takenAt: Date | null;
  hasAudio: boolean;
  /** HDR video (an iPhone's HLG, or PQ): turned into the normal picture for the poster, the preview and the faces. */
  hdr?: Hdr | null;
}

/** What the file says about itself. A file that is not a video throws BadVideoError. */
export async function probeVideo(cfg: Tools, file: string): Promise<VideoInfo> {
  let out: Buffer;
  try {
    out = await run(cfg.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60_000);
  } catch (e) {
    if (e instanceof VideoToolsError) throw e;
    throw new BadVideoError();
  }
  let j: any;
  try {
    j = JSON.parse(out.toString());
  } catch {
    throw new BadVideoError();
  }
  const format = String(j.format?.format_name ?? '');
  // A picture named .mp4 is read by ffprobe as a one-frame "video": it is not one.
  if (/image2|_pipe$|^(png|gif|webp)/.test(format)) throw new BadVideoError();
  const v = (j.streams ?? []).find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v || !(v.width > 0) || !(v.height > 0)) throw new BadVideoError();
  const seconds = Number(j.format?.duration) || Number(v.duration) || 0;
  if (!(seconds > 0)) throw new BadVideoError('This video has no length that can be read.');
  // One very long video would hold the single video line for hours (and every event's videos wait behind it).
  if (seconds * 1000 > maxMs(cfg) + 1000) throw new VideoTooLongError(maxMs(cfg) / 60_000);
  const rotation = Number((v.side_data_list ?? []).find((d: any) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0) || 0;
  const turn = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
  const sideways = turn === 90 || turn === 270;
  const when = j.format?.tags?.creation_time ?? v.tags?.creation_time;
  const takenAt = when ? new Date(when) : null;
  return {
    durationMs: Math.round(seconds * 1000),
    width: sideways ? v.height : v.width,
    height: sideways ? v.width : v.height,
    takenAt: takenAt && !Number.isNaN(takenAt.getTime()) && takenAt.getUTCFullYear() >= 1990 ? takenAt : null,
    hasAudio: (j.streams ?? []).some((s: any) => s.codec_type === 'audio'),
    hdr: hdrOf(v.color_transfer),
  };
}

/** Width and height (even numbers) that fit inside long x short, never larger than the video itself. */
function fit(w: number, h: number, long: number, short = long): [number, number] {
  const s = Math.min(1, long / Math.max(w, h), short / Math.min(w, h));
  const even = (n: number) => Math.max(2, Math.round((n * s) / 2) * 2);
  return [even(w), even(h)];
}

/** One frame at a time in the video, upright, scaled to w x h, as a JPEG. null when there is no frame there. */
async function frameAt(cfg: Tools, file: string, atSec: number, w: number, h: number, pickGood = false, hdr: Hdr | null = null): Promise<Buffer | null> {
  const png = await run(
    cfg.ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', Math.max(0, atSec).toFixed(3),
      '-i', file,
      '-map', '0:V:0', '-an', '-sn', '-dn',
      // "thumbnail" picks the most typical of the next frames: no black frame or blur from a fade.
      '-vf', `${pickGood ? 'thumbnail=24,' : ''}scale=${w}:${h}${hdr ? `,${hdrFilters(hdr, 'rgb24')}` : ''}`,
      '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1',
    ],
    60_000,
  );
  if (!png.length) return null;
  return sharp(png).jpeg({ quality: 90 }).toBuffer();
}

/** The poster: a good frame near 1 s (10% in for a very short video). The thumbnail and web copy come from it. */
export async function poster(cfg: Config, file: string, info: VideoInfo): Promise<Buffer> {
  const seconds = info.durationMs / 1000;
  const [w, h] = fit(info.width, info.height, Math.min(cfg.workMaxPx, 1920));
  const at = seconds >= 2 ? 1 : seconds * 0.1;
  const tries: [number, boolean][] = [[at, true], [at, false], [0, false]];
  for (const [t, good] of tries) {
    try {
      const jpeg = await frameAt(cfg, file, t, w, h, good, info.hdr ?? null);
      if (jpeg) return jpeg;
    } catch (e) {
      if (e instanceof VideoToolsError) throw e;
    }
  }
  throw new BadVideoError('No picture could be taken from this video.');
}

/** Up to this length a preview is encoded carefully (x264 "medium"); a longer recording quickly ("veryfast"). */
const CAREFUL_PREVIEW_MS = 10 * 60_000;

/**
 * The MP4 every browser plays, made light for phones: H.264 at most 1280 x 720 and 30 frames a second, quality-led
 * (CRF 27) but never above 2.5 Mbit/s, AAC sound at 96 kbit/s, metadata stripped, ready to stream; an HDR video is
 * turned into the normal picture (hdr.ts). A clip of up to 10 minutes is encoded carefully; a long recording (a
 * convocation of hours) quickly, so the video line is not held for most of a day, and always at a low priority with
 * at most 4 threads. The original in OneDrive keeps the full quality: that is what "Download" gives.
 */
export async function makePreview(cfg: Tools, file: string, info: VideoInfo, dest: string): Promise<void> {
  const [w, h] = fit(info.width, info.height, 1280, 720);
  // Careful for a short clip; quick for a long one, and for a 4K one of more than 3 minutes (a 4K60 HDR iPhone clip
  // takes about 3x its length on "medium" with the HDR step, at the low priority it runs at).
  const big = info.width * info.height > 1920 * 1088;
  const careful = info.durationMs <= CAREFUL_PREVIEW_MS && !(big && info.durationMs > 3 * 60_000);
  const picture = info.hdr
    ? `scale=${w}:${h}:flags=lanczos,${hdrFilters(info.hdr, 'yuv420p')}`
    : `scale=${w}:${h}:flags=lanczos:out_range=tv,format=yuv420p`;
  const tags = info.hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : [];
  try {
    await run(
      cfg.ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', file,
        '-map', '0:V:0', '-map', '0:a:0?', '-sn', '-dn',
        '-map_metadata', '-1', '-map_chapters', '-1', // no GPS position or camera details in what students get
        // A sharp scaler, and the usual (limited) range every player expects.
        '-vf', picture, '-color_range', 'tv', ...tags,
        '-c:v', 'libx264', '-preset', careful ? 'medium' : 'veryfast', '-crf', '27', '-maxrate', '2500k', '-bufsize', '5000k', '-profile:v', 'high', '-fpsmax', '30', '-threads', '4',
        '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
        '-movflags', '+faststart',
        // Never more than the longest video taken in, even when the file says it is shorter than it is.
        '-t', String(Math.round(maxMs(cfg) / 1000)),
        '-f', 'mp4', dest,
      ],
      // Room for a busy server (the encode runs at a low priority): 8x the length for a careful or HDR encode, 4x else.
      Math.max(10 * 60_000, Math.min(info.durationMs, maxMs(cfg)) * (careful || info.hdr ? 8 : 4)),
      true,
    );
  } catch (e) {
    if (e instanceof VideoToolsError) throw e;
    throw new BadVideoError(`This video could not be converted for playing in the album (${reasonOf(e).slice(0, 120)}).`);
  }
}

export interface SeenFace {
  face: FoundFace;
  /** Where in the video, in milliseconds. */
  atMs: number;
  /** Which sampled frame (two faces of one frame are never the same person). */
  frame: number;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += a[k] * b[k];
  return s;
};
const weight = (f: SeenFace) => f.face.w * f.face.h * f.face.score;

/**
 * The same person across frames is one person: a face joins the person it is most like (cosine >= min against
 * any face already theirs, never two faces from one frame). Each person keeps their best face: the largest
 * box x score, with where it was seen.
 */
export function mergePeople(found: SeenFace[], min = 0.6): SeenFace[] {
  const people: { best: SeenFace; members: SeenFace[] }[] = [];
  for (const f of found) {
    let pick: (typeof people)[number] | null = null;
    let pickScore = -Infinity;
    for (const p of people) {
      if (p.members.some((m) => m.frame === f.frame)) continue;
      let s = -Infinity;
      for (const m of p.members) s = Math.max(s, dot(m.face.vector, f.face.vector));
      if (s >= min && s > pickScore) {
        pick = p;
        pickScore = s;
      }
    }
    if (!pick) people.push({ best: f, members: [f] });
    else {
      pick.members.push(f);
      if (weight(f) > weight(pick.best)) pick.best = f;
    }
  }
  return people.map((p) => p.best);
}

/** Frames every 2 s (at most 60, spread evenly over a long video) through the face engine, then one face per person. */
async function videoFaces(ctx: Ctx, file: string, info: VideoInfo): Promise<SeenFace[]> {
  const { cfg } = ctx;
  const seconds = Math.min(info.durationMs, maxMs(cfg)) / 1000;
  const n = Math.max(1, Math.min(60, Math.ceil(seconds / 2)));
  const step = seconds / n;
  const [w, h] = fit(info.width, info.height, Math.min(cfg.workMaxPx, 1920));
  const found: SeenFace[] = [];
  for (let i = 0; i < n; i++) {
    const at = (i + 0.5) * step;
    let jpeg: Buffer | null = null;
    try {
      jpeg = await frameAt(cfg, file, at, w, h, false, info.hdr ?? null);
    } catch (e) {
      if (e instanceof VideoToolsError) throw e;
      continue; // a damaged stretch of the video: the other frames still count
    }
    if (!jpeg) continue;
    for (const face of await ctx.face.faces(jpeg, cfg.minFacePx)) found.push({ face, atMs: Math.round(at * 1000), frame: i });
  }
  return mergePeople(found);
}

async function insertVideoFaces(q: Queryable, eventId: string, mediaId: string, faces: SeenFace[], model: string): Promise<void> {
  for (let i = 0; i < faces.length; i += 50) {
    const chunk = faces.slice(i, i + 50);
    const values: string[] = [];
    const params: unknown[] = [eventId, mediaId, model];
    chunk.forEach((s, k) => {
      const b = 4 + k * 7;
      values.push(`($1, $2, $${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $3, $${b + 6})`);
      const f = s.face;
      params.push(vectorToBuffer(f.vector), Math.round(f.x), Math.round(f.y), Math.round(f.w), Math.round(f.h), f.score, s.atMs);
    });
    await q.query(`insert into faces (event_id, media_id, embedding, box_x, box_y, box_w, box_h, det_score, model, at_ms) values ${values.join(', ')}`, params);
  }
}

/** Poster, preview (both into OneDrive) and faces for a video that is going to be shown; then its location-free copy. */
export async function finishVideo(ctx: Ctx, eventId: string, mediaId: string, file: string, info: VideoInfo): Promise<void> {
  const { cfg, db } = ctx;
  const before = (await db.query<{ thumb_key: string | null; web_key: string | null; video_key: string | null }>(`select thumb_key, web_key, video_key from media where id = $1`, [mediaId])).rows[0];
  const work = await poster(cfg, file, info);
  const tmp = tempPath(cfg, `${mediaId}-${Date.now()}.preview.mp4`);
  let keys: string[];
  try {
    await makePreview(cfg, file, info, tmp);
    keys = await putCopies(ctx, eventId, mediaId, [
      { kind: 't', body: await displayCopy(work, cfg.thumbMaxPx, 72), ext: 'webp' },
      { kind: 'w', body: await displayCopy(work, cfg.webMaxPx, 80), ext: 'webp' },
      { kind: 'v', body: { file: tmp }, ext: 'mp4' },
    ]);
  } finally {
    await fs.promises.rm(tmp, { force: true }); // the preview lives in OneDrive now
  }
  const [tKey, wKey, vKey] = keys;
  let settled = false;
  try {
    const people = await videoFaces(ctx, file, info);
    // The video may have been rejected (or removed) while it waited in the video line: then nothing is written back.
    const kept = await db.tx(async (q) => {
      const done = await q.query(
        `update media set status = 'ready', status_reason = null, thumb_key = $2, web_key = $3, video_key = $4, face_count = $5,
                duration_ms = $6, width = $7, height = $8, processed_at = now(),
                copies_missing = false, copies_lost = false, copies_tries = 0, copies_error = null, clean_tries = 0
          where id = $1 and status = 'processing' and review <> 'rejected'`,
        [mediaId, tKey, wKey, vKey, people.length, info.durationMs, info.width, info.height],
      );
      if (!done.rowCount) return false;
      await q.query(`delete from faces where media_id = $1`, [mediaId]);
      await insertVideoFaces(q, eventId, mediaId, people, ctx.face.model);
      return true;
    });
    settled = true;
    if (!kept) {
      await dropUnwanted(ctx, mediaId, keys);
      return;
    }
  } finally {
    if (!settled) await forget(ctx, keys);
  }
  emptyCopyTrashSoon(ctx);
  await purgeKeys(ctx, [before?.thumb_key, before?.web_key, before?.video_key]);
  await removeLegacy(cfg, [before?.thumb_key, before?.web_key, before?.video_key]);
  ctx.bump(eventId);
  await mediaChanged(ctx, [mediaId]);
  // The copy students download: made now, while the original is on this server. Never un-shows the video.
  const name = (await db.query<{ name: string | null }>(`select name from media where id = $1`, [mediaId])).rows[0]?.name ?? '';
  await track(ctx, makeCleanCopy(ctx, mediaId, file, extOfName(name))).catch((e) => ctx.log(`could not keep a location-free copy of a video: ${reasonOf(e)}`));
}

/** The extension of a file name ("clip.MOV" -> "mov"); mp4 when it has none. */
export const extOfName = (name: string) => /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() ?? 'mp4';

/**
 * The location-free copy of a shown video (videocopy.ts: the same video and sound, no metadata), kept in OneDrive
 * (<event>/clean) for Save original and Download all, so a download never needs the original on this server again.
 * Made from `file`, the original already here. Skipped (the rebuild job makes it later) when the event is archived,
 * when this Mac has too little room for the copy, or when OneDrive is nearly full. Returns its key, or null.
 */
export async function makeCleanCopy(ctx: Ctx, mediaId: string, file: string, ext: string): Promise<string | null> {
  const { cfg, db } = ctx;
  if (!cfg.cleanVideoCopies) return null;
  const row = (
    await db.query<{ event_id: string; processed_at: string; status: string }>(
      `select m.event_id, m.processed_at::text as processed_at, e.status from media m join events e on e.id = m.event_id
        where m.id = $1 and m.status = 'ready' and m.review <> 'rejected' and m.duplicate_of is null and m.type = 'video'`,
      [mediaId],
    )
  ).rows[0];
  if (!row || row.status === 'archived') return null;
  const size = (await fs.promises.stat(file)).size;
  if ((await freeBytes(path.dirname(tempPath(cfg, 'x')))) < size * 1.1 + 512 * 1024 * 1024) {
    ctx.log('a location-free video copy waits: the server has too little room for it right now');
    return null;
  }
  const st = await ctx.drive.status().catch(() => null);
  if (st?.quota && (st.quota.remaining < size * 2 || st.quota.remaining < st.quota.total * 0.05)) {
    ctx.log('a location-free video copy is not kept: OneDrive is nearly full');
    return null;
  }
  const clean = await cleanVideoCopy(cfg, file, ext);
  try {
    const key = await putCopy(ctx, row.event_id, mediaId, 'clean', { file: clean }, extOf(clean));
    const n = await db.query(
      `update media set clean_key = $2 where id = $1 and status = 'ready' and review <> 'rejected' and processed_at::text is not distinct from $3`,
      [mediaId, key, row.processed_at],
    );
    if (!n.rowCount) {
      await forget(ctx, [key]);
      return null;
    }
    emptyCopyTrashSoon(ctx); // an earlier clean copy, if it had one
    return key;
  } finally {
    await fs.promises.rm(clean, { force: true });
  }
}

/**
 * The item's last step found it no longer wanted. The copies just uploaded never reached the database, so they go
 * again; a rejected one stops counting as "processing" (no copies, no faces, as reject left it).
 */
export async function dropUnwanted(ctx: Ctx, mediaId: string, keys: string[]): Promise<void> {
  await forget(ctx, keys);
  const now = (await ctx.db.query<{ review: string }>(`select review from media where id = $1`, [mediaId])).rows[0];
  if (now?.review === 'rejected') await ctx.db.query(`update media set status = 'ready', processed_at = now() where id = $1 and status = 'processing' and review = 'rejected'`, [mediaId]);
}

/** A copy keeps a thumbnail for the Media manager and stops there: no web copy, no preview, no faces. */
async function finishCopy(ctx: Ctx, row: any, file: string, info: VideoInfo): Promise<'copy'> {
  const { cfg, db } = ctx;
  const tKey = await putCopy(ctx, row.event_id, row.id, 't', await displayCopy(await poster(cfg, file, info), cfg.thumbMaxPx, 72), 'webp');
  try {
    await db.tx(async (q) => {
      await q.query(`delete from faces where media_id = $1`, [row.id]);
      await q.query(
        `update media set status = 'ready', status_reason = null, thumb_key = $2, web_key = null, video_key = null, scene_key = null, clean_key = null,
                face_count = null, processed_at = now(), copies_missing = false, copies_lost = false, copies_tries = 0, copies_error = null, clean_tries = 0 where id = $1`,
        [row.id, tKey],
      );
    });
  } catch (e) {
    await forget(ctx, [tKey]);
    throw e;
  }
  emptyCopyTrashSoon(ctx);
  await purgeKeys(ctx, [row.thumb_key, row.web_key, row.video_key]);
  await removeLegacy(cfg, [row.thumb_key, row.web_key, row.video_key, legacySceneKey(row.event_id, row.id)]);
  ctx.bump(row.event_id);
  await mediaChanged(ctx, [row.id]);
  return 'copy';
}

/**
 * Decide for one of YOUR videos (from the OneDrive folder). Returns the id of the video it copies, or null when it
 * is the one to show; `demoted` = students' uploads of the very same file, now marked as copies of it.
 */
export async function decideOfficialVideo(q: Queryable, eventId: string, mediaId: string, sha256: string): Promise<{ of: string | null; demoted: string[] }> {
  const same = await q.query<{ id: string }>(
    `select id from media
      where event_id = $1 and id <> $2 and source = 'onedrive' and sha256 = $3
        and duplicate_of is null and status in ('processing', 'ready')
      order by created_at, id limit 1`,
    [eventId, mediaId, sha256],
  );
  if (same.rows[0]) return { of: same.rows[0].id, demoted: [] };
  const crowd = await q.query<{ id: string; hidden: boolean }>(
    `select id, hidden from media
      where event_id = $1 and id <> $2 and source = 'crowd' and duplicate_of is null and sha256 = $3
        and review <> 'rejected' and not keep_both`,
    [eventId, mediaId, sha256],
  );
  for (const row of crowd.rows) await markCopy(q, row.id, mediaId);
  // A video an organiser took down stays down when your original of it arrives.
  if (crowd.rows.some((r) => r.hidden)) await q.query(`update media set hidden = true where id = $1`, [mediaId]);
  return { of: null, demoted: crowd.rows.map((r) => r.id) };
}

/** The video a student's upload is the very same file as (any video or photo of the event, hidden and rejected ones too). */
export async function findSameFile(q: Queryable, eventId: string, sha256: string, exceptId: string | null = null): Promise<string | null> {
  const r = await q.query<{ id: string }>(
    `select coalesce(duplicate_of, id) as id from media where event_id = $1 and sha256 = $2 and ($3::uuid is null or id <> $3::uuid) order by created_at, id limit 1`,
    [eventId, sha256, exceptId],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * Process one video the sync job found (the same steps as processFound for a photo): download once,
 * read it, the duplicate decision, then poster, preview and faces if it is the one to show.
 */
export async function processFoundVideo(ctx: Ctx, mediaId: string): Promise<'ready' | 'copy' | 'failed' | 'gone'> {
  const { cfg, db } = ctx;
  // Without ffmpeg the video cannot be read: it is not downloaded at all, and it waits (as 'found') for the tools.
  if (!(await videoToolsReady(cfg))) {
    await db.query(`update media set status_reason = $2 where id = $1 and status = 'found'`, [mediaId, 'Waiting: ffmpeg is not installed on the server, so videos cannot be read yet.']);
    throw new VideoToolsError(`${cfg.ffprobePath} was not found. Install ffmpeg, or set FFMPEG_PATH and FFPROBE_PATH.`);
  }
  const row = (
    await db.query<any>(`update media set status = 'processing', status_reason = null where id = $1 and status = 'found' and type = 'video' returning *`, [mediaId])
  ).rows[0];
  if (!row) return 'gone';
  const tmp = tempPath(cfg, `${row.id}-${Date.now()}.video`);
  try {
    await ctx.drive.download(row.onedrive_item_id, tmp);
    const sha256 = await sha256File(tmp);
    const info = await probeVideo(cfg, tmp);
    const facts = [info.width, info.height, info.durationMs, info.takenAt, row.mime ?? null];
    const record = `sha256 = $2, width = $3, height = $4, duration_ms = $5, taken_at = coalesce($6, taken_at), mime = coalesce(mime, $7), duplicate_of = $8`;
    if (row.source === 'crowd' && row.sha256) {
      // A student's video whose finishing was interrupted: its duplicate decision was made at upload.
      await finishVideo(ctx, row.event_id, row.id, tmp, info);
      return 'ready';
    }
    let copyOf: string | null;
    let demoted: string[] = [];
    if (row.source === 'crowd') {
      // A file that turned up in the Crowd uploads folder by itself: the same file as anything the event has is a copy.
      copyOf = await ctx.eventLock.run(row.event_id, () =>
        db.tx(async (q) => {
          const of = await findSameFile(q, row.event_id, sha256, row.id);
          await q.query(`update media set ${record} where id = $1`, [row.id, sha256, ...facts, of]);
          return of;
        }),
      );
    } else {
      copyOf = await ctx.eventLock.run(row.event_id, () =>
        db.tx(async (q) => {
          await releaseCopies(q, row.id, false); // copies of this file's earlier content, if it changed
          const d = row.keep_both ? { of: null, demoted: [] } : await decideOfficialVideo(q, row.event_id, row.id, sha256);
          demoted = d.demoted;
          await q.query(`update media set ${record} where id = $1`, [row.id, sha256, ...facts, d.of]);
          return d.of;
        }),
      );
    }
    if (demoted.length) {
      ctx.bump(row.event_id);
      await mediaChanged(ctx, demoted);
    }
    if (copyOf) return await finishCopy(ctx, row, tmp, info);
    await finishVideo(ctx, row.event_id, row.id, tmp, info);
    return 'ready';
  } catch (e) {
    if (e instanceof DriveNotFoundError) {
      // Listed a moment ago and now not there: the row waits and the next sync's listing decides (as for photos).
      await db.query(`update media set status = 'found' where id = $1`, [row.id]);
      return 'gone';
    }
    if (WAITS.includes((e as Error)?.name)) {
      await db.query(`update media set status = 'found' where id = $1`, [row.id]);
      throw e;
    }
    await db.query(`update media set status = 'failed', status_reason = $2 where id = $1`, [row.id, reasonOf(e)]);
    ctx.log(`could not process the video ${row.name}: ${reasonOf(e)}`);
    return 'failed';
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

/** Run a job in the video line (one at a time, apart from the photo workers). The sync job waits for it like for a photo. */
export function inVideoLine<T>(job: () => Promise<T>): Promise<T> {
  return videoQueue.push(job);
}

/**
 * Finish an uploaded video in the background, from the file already on this server (it is removed afterwards).
 * Trouble that is not the file's fault leaves it 'found': the next sync downloads it from OneDrive and finishes it.
 */
export function finishUploadedVideo(ctx: Ctx, eventId: string, mediaId: string, file: string, info: VideoInfo): void {
  void videoQueue
    .push(async () => {
      try {
        await finishVideo(ctx, eventId, mediaId, file, info);
      } catch (e) {
        ctx.log(`could not finish an uploaded video: ${reasonOf(e)}`);
        const waits = WAITS.includes((e as Error)?.name);
        await ctx.db
          .query(waits ? `update media set status = 'found' where id = $1` : `update media set status = 'failed', status_reason = $2 where id = $1`, waits ? [mediaId] : [mediaId, reasonOf(e)])
          .catch(() => {});
      } finally {
        await fs.promises.rm(file, { force: true });
      }
    })
    .catch(() => {});
}
