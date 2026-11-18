import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { Response } from 'express';
import { Router } from '../lib/router.js';
import type { Ctx } from '../context.js';
import { VISIBLE } from '../db/schema.js';
import { DriveBusyError, DriveNotFoundError } from '../drive/types.js';
import { bad } from '../lib/http.js';
import { checkImageLink } from '../lib/links.js';
import { extOf, isDriveKey, isLegacyKey, itemOf, legacyPath, mimeOfExt } from '../media/copies.js';
import { copyUrl, hasFlag, markDown, markThrottled, purgeUrls } from '../media/copyurls.js';
import { kickRebuild, markHot } from '../media/rebuild.js';
import { makeViewCache } from '../media/viewcache.js';

/** OneDrive cannot be reached or needs signing in again: the album says photos cannot be loaded right now. */
const UNAVAILABLE = ['DriveDownError', 'DriveAuthError'];

/**
 * Thumbnails, web copies and video previews (full quality is the download). The copies live in OneDrive; this
 * route is the gate. Every link is signed and expires, and a student's link stops working the moment the photo is no
 * longer visible (hidden, rejected, a copy, its copies lost). Only after those checks:
 *   - the album (<img>, <video>): a 302 to a short-lived OneDrive download link, kept by the browser for 5 minutes
 *   - pipe=1 (the viewer's share and save, the console's "open"): the bytes stream through this server, with Range
 *   - a copy from before photos lived only in OneDrive: sent from this server if its file is still there, else
 *     "being prepared" (503) while the rebuild job makes it from the original
 */
export function imageRoutes(ctx: Ctx): Router {
  const { cfg } = ctx;
  const r = Router();
  let pipes = 0;
  /** Thumbnails and main-view copies, kept here up to IMG_CACHE_MB so the album opens fast; OneDrive stays the store. */
  const views = makeViewCache(ctx);

  const preparing = (res: Response) =>
    res
      .status(503)
      .set({ 'Retry-After': '20', 'Cache-Control': 'no-store' })
      .json({ error: 'copy_preparing', message: 'This photo is being prepared. It will appear in a moment.' });
  /** OneDrive is limiting requests for a few seconds: not an outage (no banner), only "try again" after its Retry-After. */
  const busy = (res: Response, e: DriveBusyError) =>
    res
      .status(503)
      .set({ 'Retry-After': String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))), 'Cache-Control': 'no-store' })
      .json({ error: 'busy', message: 'Many photos are being loaded right now. Try again in a moment.' });
  /** A student is waiting for this copy: the rebuild job makes it first (not while OneDrive is known to be down). */
  const wanted = async (id: string) => {
    await markHot(ctx, id);
    if (!(await hasFlag(ctx, 'drive:down'))) kickRebuild(ctx);
  };
  const unavailable = (res: Response) =>
    res
      .status(503)
      .set({ 'Retry-After': '30', 'Cache-Control': 'no-store' })
      .json({ error: 'images_unavailable', message: 'Photos cannot be loaded right now. Try again in a few minutes.' });

  r.get('/:id/:size', async (req, res) => {
    const { id, size } = req.params;
    const admin = req.query.a === '1';
    if (!/^[0-9a-f-]{36}$/.test(id) || !checkImageLink(cfg, id, size, String(req.query.e ?? ''), String(req.query.s ?? ''), admin)) {
      throw bad(403, 'link_expired', 'This image link has expired.');
    }
    // The permission check comes before any OneDrive link is looked up.
    const row = (
      await ctx.db.query<{ event_id: string; thumb_key: string | null; web_key: string | null; video_key: string | null }>(
        `select m.event_id, m.thumb_key, m.web_key, m.video_key from media m where m.id = $1 ${admin ? '' : `and ${VISIBLE}`}`,
        [id],
      )
    ).rows[0];
    const key = !row ? null : size === 'v' ? row.video_key : size === 'w' ? (row.web_key ?? row.thumb_key) : row.thumb_key;
    if (!key) throw bad(404, 'not_found', size === 'v' ? 'This video is not available.' : 'This photo is not available.');
    const kind = size === 'w' && !row!.web_key ? 't' : (size as 't' | 'w' | 'v');
    res.setHeader('X-Robots-Tag', 'noindex');

    // Only during the move to OneDrive: a copy kept on this server is sent while it is there.
    if (isLegacyKey(key)) {
      const abs = legacyPath(cfg, key);
      if (abs && fs.existsSync(abs)) {
        res.setHeader('Cache-Control', admin ? 'private, no-store' : 'private, max-age=300');
        res.type(size === 'v' ? 'mp4' : key.endsWith('.webp') ? 'webp' : 'jpeg');
        return new Promise<void>((resolve) =>
          res.sendFile(abs, { acceptRanges: true }, (err) => {
            if (err && !res.headersSent) preparing(res);
            resolve();
          }),
        );
      }
      await wanted(id);
      return preparing(res);
    }
    if (!isDriveKey(key)) throw bad(404, 'not_found', 'This photo is not available.');

    const pipe = req.query.pipe === '1' || (size === 'v' && cfg.videoVia === 'pipe');
    const cache = admin ? 'private, no-store' : `private, max-age=${cfg.imgRedirectMaxAge}`;
    if (kind !== 'v') {
      const local = views.get(key);
      if (local) {
        res.set({ 'Cache-Control': cache, 'X-Served-From': 'cache' });
        res.type(mimeOfExt(extOf(key)));
        return new Promise<void>((resolve) =>
          res.sendFile(local, { acceptRanges: true }, (err) => {
            if (err && !res.headersSent) res.status(503).set('Retry-After', '2').end();
            resolve();
          }),
        );
      }
    }
    try {
      if (!pipe) {
        const url = await copyUrl(ctx, key, { eventId: row!.event_id, kind });
        res.set({ 'Cache-Control': cache, 'Referrer-Policy': 'no-referrer' });
        return res.redirect(302, url);
      }
      if (pipes >= cfg.pipesAtOnce) {
        return res.status(503).set({ 'Retry-After': '5', 'Cache-Control': 'no-store' }).json({ error: 'busy', message: 'Many photos are being loaded right now. Try again in a moment.' });
      }
      pipes++;
      const stop = new AbortController();
      res.once('close', () => stop.abort());
      try {
        const url = ctx.drive.kind === 'graph' ? await copyUrl(ctx, key, { eventId: row!.event_id, kind }) : null;
        const got = await ctx.drive.read(itemOf(key), { url, range: typeof req.headers.range === 'string' ? req.headers.range : null, signal: stop.signal, patient: false });
        if (got.staleUrl) await purgeUrls(ctx, [itemOf(key)]); // the cached link stopped working early: not handed out again
        res.status(got.status);
        res.set({
          'Content-Type': size === 'v' ? 'video/mp4' : mimeOfExt(extOf(key)),
          'Accept-Ranges': 'bytes',
          'Cache-Control': cache,
        });
        if (got.size !== null) res.setHeader('Content-Length', String(got.size));
        if (got.contentRange) res.setHeader('Content-Range', got.contentRange);
        await new Promise<void>((resolve) => {
          const body = Readable.fromWeb(got.body as any);
          body.once('error', () => {
            res.destroy();
            resolve();
          });
          res.once('close', () => {
            body.destroy();
            resolve();
          });
          body.pipe(res);
        });
      } finally {
        pipes--;
      }
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      if (e instanceof DriveNotFoundError) {
        // Someone deleted the copy in OneDrive: it is made again from the original.
        await ctx.db.query(`update media set copies_missing = true where id = $1`, [id]);
        await purgeUrls(ctx, [itemOf(key)]);
        await wanted(id);
        return preparing(res);
      }
      if (e instanceof DriveBusyError) {
        await markThrottled(ctx, e);
        return busy(res, e);
      }
      if (UNAVAILABLE.includes((e as Error)?.name)) {
        await markDown(ctx);
        return unavailable(res);
      }
      if (/range asked for/.test((e as Error)?.message ?? '')) return res.status(416).end();
      throw e;
    }
  });
  return r;
}
