import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { Queue } from '../lib/queue.js';

/**
 * A video a student downloads (Save original, Download all) without where it was filmed. Phones write the place into
 * the file: an iPhone as com.apple.quicktime.location.ISO6709 (and a timed-metadata track), Android as ©xyz /
 * "location". The original in OneDrive is never changed, so the video is put into a new container on this server:
 * the same video and sound, not encoded again (ffmpeg -c copy: as fast as copying the file, full quality), with no
 * metadata at all (no place, no date, no camera), no chapters and no data or subtitle tracks. Its turn (a portrait
 * video's rotation) stays. Before it is handed over, ffprobe must find nothing that names a place; otherwise it is not
 * handed over at all (the caller gives the album's preview MP4 instead, which never has metadata).
 *
 * Two at a time per server: each reads and writes the whole video on this disk.
 */

const line = new Queue(2);

/** Container for each extension the app takes in; the copy keeps the original's own. */
const FORMAT: Record<string, string> = { mp4: 'mp4', m4v: 'mp4', mov: 'mov', '3gp': '3gp', mkv: 'matroska', webm: 'webm', avi: 'avi' };
const FASTSTART = new Set(['mp4', 'mov', '3gp']);
/** Anything in a tag's name or value that could say where. */
const PLACE = /location|iso6709|©xyz|\bxyz\b|gps|latitude|longitude/i;

type Tools = Pick<Config, 'ffmpegPath' | 'ffprobePath'>;

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      if (out.length < 4_000_000) out += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 8000) err += c.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) =>
      code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} ${signal ? 'took too long' : `failed: ${err.trim().split('\n').at(-1)?.slice(0, 200) ?? ''}`}`)),
    );
  });
}

/** True when ffprobe finds no tag (of the file or of any track) that names a place. */
async function placeFree(cfg: Tools, file: string): Promise<boolean> {
  const j = JSON.parse(await run(cfg.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], 120_000));
  const tags = [j.format?.tags, ...(j.streams ?? []).map((s: any) => s.tags), ...(j.chapters ?? []).map((c: any) => c.tags)].filter(Boolean);
  if ((j.chapters ?? []).length) return false;
  return tags.every((t: Record<string, unknown>) => Object.entries(t).every(([k, v]) => !PLACE.test(k) && !PLACE.test(String(v))));
}

/**
 * The location-free copy of the video in `file` (its original extension `ext`), written next to it as
 * <file>.clean.<ext>. Throws when it cannot be made or still names a place (the half-made copy is removed).
 */
export function cleanVideoCopy(cfg: Tools, file: string, ext: string): Promise<string> {
  const e = ext.toLowerCase();
  const format = FORMAT[e] ?? 'mp4';
  const out = `${file}.clean.${FORMAT[e] ? e : 'mp4'}`;
  return line.push(async () => {
    try {
      const size = (await fs.promises.stat(file)).size;
      await run(
        cfg.ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-i', file,
          '-map', '0:V', '-map', '0:a?', '-c', 'copy',
          '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1',
          '-dn', '-sn',
          ...(FASTSTART.has(format) ? ['-movflags', '+faststart'] : []),
          '-f', format, out,
        ],
        // Copying, not encoding: about the time of reading and writing the file twice, with room for a slow disk.
        Math.max(5 * 60_000, Math.ceil(size / (20 * 1024 * 1024)) * 1000 * 4),
      );
      if (!(await placeFree(cfg, out))) throw new Error('the video still names a place after its metadata was removed');
      return out;
    } catch (err) {
      await fs.promises.rm(out, { force: true });
      throw err;
    }
  });
}
