import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';

/**
 * Photos and videos live only in OneDrive (media/copies.ts): this server keeps temp files for one job or one request.
 * Keys from before that (media/<event>/<id>_t.webp ...) are legacy: the rebuild job moves or remakes them.
 * A legacy scene description had no column: its file was found by the ids.
 */
export const legacySceneKey = (eventId: string, mediaId: string) => `media/${eventId}/${mediaId}_s.bin`;

export function tempPath(cfg: Pick<Config, 'dataDir'>, name: string): string {
  const dir = path.join(cfg.dataDir, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/**
 * The server's own temp files: uploads being received or waiting in the video line, downloads for processing,
 * previews being made, Download all and Save original. The command-line tools (adopt-*, check-*) are not in here.
 */
const SERVER_TEMP = /^(upload-|zip-|orig-|test-|rebuild-|clean-|full-|copy-)|\.(orig|again|video|preview\.mp4|part)$|\.clean\.\w+$/;

/**
 * At start: remove what a stopped server left in data/tmp. Every such file belonged to a request or a job that ended
 * with that process (a video that was waiting is downloaded again from OneDrive by the next sync). Only files older
 * than `before` go, so a command-line tool working at the same moment is never touched. Returns how many went.
 */
export function cleanTempDir(cfg: Pick<Config, 'dataDir'>, before: Date = new Date(), pattern: RegExp = SERVER_TEMP): number {
  const dir = path.join(cfg.dataDir, 'tmp');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // no temp folder yet
  }
  let n = 0;
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const abs = path.join(dir, name);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.mtimeMs >= before.getTime()) continue;
      fs.rmSync(abs, { force: true });
      n++;
    } catch {
      /* gone already */
    }
  }
  return n;
}

export type FileKind = 'photo' | 'video' | 'other';

/** iPhone photos (HEIC/HEIF) are photos too: they are read through ffmpeg, and downloaded as full-quality JPEG. */
export function classify(name: string): FileKind {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext)) return 'photo';
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp'].includes(ext)) return 'video';
  return 'other';
}

/** Photos and videos are taken in and processed; anything else is listed as skipped, with the reason. */
export const processable = (kind: FileKind): kind is 'photo' | 'video' => kind === 'photo' || kind === 'video';

export const SKIP_REASON: Record<Exclude<FileKind, 'photo' | 'video'>, string> = {
  other: 'Not a photo or video (JPG, PNG, WebP, HEIC, MP4, MOV, WebM, MKV, AVI, 3GP)',
};

/** iPhone photos: they are handed out as JPEG (most phones and computers cannot open HEIC). */
export const isHeicName = (name: string | null | undefined) => /\.(heic|heif)$/i.test(name ?? '');

/**
 * Temp files of one student or organiser request (Download all, Save original, a full-quality render, a copy on its
 * way to OneDrive, a location-free video copy). None of them lives for hours.
 */
const REQUEST_TEMP = /^(zip-|orig-|full-|copy-|clean-)/;

/**
 * Every hour: request temp files older than 6 hours (a request that never cleaned up after itself). Files of the
 * long jobs (an upload waiting in the video line, a video being processed or rebuilt, its preview) are never swept
 * while the server runs: a convocation video can wait for hours. What a stopped server left goes at start (cleanTempDir).
 */
export function sweepTempDir(cfg: Pick<Config, 'dataDir'>, maxAgeMs = 6 * 60 * 60_000): number {
  return cleanTempDir(cfg, new Date(Date.now() - maxAgeMs), REQUEST_TEMP);
}
