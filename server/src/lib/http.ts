import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

/** An error with an HTTP status and a short code the web app can act on. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message || code);
  }
}

export const bad = (status: number, code: string, message?: string) => new HttpError(status, code, message);

/** Validate a request body (or query) against a zod schema; a mismatch becomes a 400. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw bad(400, 'invalid_input', `${first.path.join('.') || 'input'}: ${first.message}`);
  }
  return r.data;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function errorHandler(log: (msg: string, extra?: unknown) => void) {
  return (err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'too_large', message: 'That file is too large.' });
      return;
    }
    if (err?.name === 'DriveAuthError') {
      res.status(409).json({ error: 'reconnect_onedrive', message: err.message });
      return;
    }
    if (err?.name === 'DriveNotFoundError') {
      res.status(404).json({ error: 'not_in_onedrive', message: "That file or folder is no longer in OneDrive. If it is the app's own folder, press Connect again in Settings." });
      return;
    }
    if (err?.name === 'DriveDownError') {
      log(err.message);
      res.status(503).json({ error: 'busy', message: 'OneDrive cannot be reached right now. Try again in a few minutes.' });
      return;
    }
    if (err?.name === 'FaceTimeoutError') {
      // One picture took too long (the photo itself is marked failed by the photo work; a selfie can just be tried again).
      res.status(503).json({ error: 'busy', message: 'That took too long. Try again with another photo.' });
      return;
    }
    if (err?.name === 'FaceDownError') {
      log(err.message);
      res.status(503).json({ error: 'busy', message: 'The photo service is not answering right now. Try again in a few minutes.' });
      return;
    }
    if (err?.name === 'BadImageError') {
      // the face engine could not read the picture (not an image, a format it does not know, or far too large)
      res.status(400).json({ error: 'bad_photo', message: 'That photo could not be read. Try a JPG or PNG photo.' });
      return;
    }
    log('unhandled error', err);
    res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server.' });
  };
}

export function slugify(text: string): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'event';
}
