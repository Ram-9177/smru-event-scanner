import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { bad } from './http.js';

/** The request's type, without parameters ("video/mp4"). */
export const mimeOf = (req: Request) => String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

/**
 * express.raw (the whole body in memory) for photos, but nothing for the types in `stream`: those requests keep their
 * body unread, for receiveToFile. So a 2 GB video never sits in the server's memory.
 */
export function rawUnless(stream: (mime: string) => boolean, limit: number): RequestHandler {
  const raw = express.raw({ type: () => true, limit });
  return (req: Request, res: Response, next: NextFunction) => (stream(mimeOf(req)) ? next() : raw(req, res, next));
}

/** express.raw run inside a handler: the body is read only once the handler has decided the request may go ahead. */
export function readRaw(req: Request, res: Response, limit: number): Promise<void> {
  const raw = express.raw({ type: () => true, limit });
  return new Promise((resolve, reject) => raw(req, res, (err?: unknown) => (err ? reject(err) : resolve())));
}

/**
 * A fixed number of places for work that holds memory, disk or a OneDrive connection (uploads being received,
 * Download all). take() gives a place, or null when all are taken; the place is given back once, however often
 * the returned function is called.
 */
export class Slots {
  private used = 0;
  constructor(readonly size: number) {}
  take(): (() => void) | null {
    if (this.used >= this.size) return null;
    this.used++;
    let back = false;
    return () => {
      if (back) return;
      back = true;
      this.used--;
    };
  }
  get inUse(): number {
    return this.used;
  }
}

/** Bytes free for this server's files on the disk that holds `dir` (Infinity when the system cannot say). */
export async function freeBytes(dir: string): Promise<number> {
  try {
    const s = await fs.promises.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity;
  }
}

/**
 * Stream the request body to a file, never more than maxBytes. A body that says it is larger is refused before a
 * byte is read (413); one that turns out larger while it arrives is cut off and its part-file removed.
 */
export async function receiveToFile(req: Request, dest: string, maxBytes: number, tooLarge: string): Promise<number> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw bad(413, 'too_large', tooLarge);
  let n = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > maxBytes) cb(bad(413, 'too_large', tooLarge));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(dest));
  } catch (e) {
    await fs.promises.rm(dest, { force: true });
    if ((e as any)?.status === 413) throw e;
    throw bad(400, 'upload_cut', 'The upload was cut off before the whole file arrived. Try again.');
  }
  if (Number.isFinite(declared) && declared !== n) {
    await fs.promises.rm(dest, { force: true });
    throw bad(400, 'upload_cut', 'The upload was cut off before the whole file arrived. Try again.');
  }
  return n;
}
