import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { makePhoto, PERSON, type TestFace } from './photos.js';

/** Shared makers for the OneDrive-copies tests: videos, photos with a place in them, and readers. */
const tool = (name: string, env: string | undefined) => env || (fs.existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
export const FFMPEG = tool('ffmpeg', process.env.FFMPEG_PATH);
export const FFPROBE = tool('ffprobe', process.env.FFPROBE_PATH);
/** Where the test videos were "filmed". */
export const GPS = '+17.3850+078.4867/';

/** A small MP4: one picture per second (640 x 360), with a silent sound track, and where it was filmed. */
export async function makeVideo(seed: number, seconds: TestFace[][]): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-vid-'));
  try {
    for (const [i, faces] of seconds.entries()) {
      fs.writeFileSync(path.join(dir, `f-${String(i + 1).padStart(3, '0')}.jpg`), await makePhoto(seed + i, faces, { w: 640, h: 360 }));
    }
    const out = path.join(dir, 'out.mp4');
    const r = spawnSync(FFMPEG, [
      '-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(dir, 'f-%03d.jpg'),
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-map', '0:v', '-map', '1:a', '-shortest',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', '10', '-c:a', 'aac',
      '-metadata', `location=${GPS}`, '-metadata', `com.apple.quicktime.location.ISO6709=${GPS}`, '-movflags', 'use_metadata_tags', out,
    ]);
    if (r.status !== 0) throw new Error(`ffmpeg could not make the test video: ${r.stderr}`);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function probe(file: string): any {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  return JSON.parse(r.stdout.toString());
}
export function probeBytes(data: Buffer): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-probe-'));
  try {
    const f = path.join(dir, 'x.mp4');
    fs.writeFileSync(f, data);
    return probe(f);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
export const placeTags = (j: any) => JSON.stringify([j.format?.tags, ...(j.streams ?? []).map((x: any) => x.tags)]).match(/location|iso6709|17\.3850/gi) ?? [];

/** A well-exposed phone photo with its camera and where it was taken: the album shows it unchanged. */
export const withGps = async (seed: number, faces: TestFace[] = [{ person: PERSON.red }]) =>
  sharp(await makePhoto(seed, faces))
    .composite([
      { input: { create: { width: 800, height: 24, channels: 3, background: '#000000' } }, top: 0, left: 0 },
      { input: { create: { width: 800, height: 24, channels: 3, background: '#ffffff' } }, top: 576, left: 0 },
    ])
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'Phone 9' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '17/1 23/1 1234/100', GPSLongitudeRef: 'E', GPSLongitude: '78/1 29/1 5678/100' },
    })
    .jpeg({ quality: 92 })
    .toBuffer();

/** A dark, flat photo: the album shows it with its fix (a look), so downloads are made full quality. */
export const flatDark = async (seed: number, faces: TestFace[] = [{ person: PERSON.red }]) =>
  sharp({ create: { width: 1200, height: 900, channels: 3, background: '#3c3c3c' } })
    .composite([
      { input: { create: { width: 600, height: 450, channels: 3, background: '#6e6a66' } }, top: 120, left: 80 },
      { input: { create: { width: 133, height: 133, channels: 3, background: '#1e1e1e' } }, top: 700, left: 1000 },
      { input: await makePhoto(seed, faces, { w: 400, h: 300 }), top: 520, left: 700 },
    ])
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'Phone 9' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '17/1 23/1 1234/100', GPSLongitudeRef: 'E', GPSLongitude: '78/1 29/1 5678/100' },
    })
    .jpeg({ quality: 92 })
    .toBuffer();

/** supertest: the body as bytes, whatever its type. */
export const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
