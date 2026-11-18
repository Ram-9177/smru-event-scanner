import type { Ctx } from '../context.js';
import { LocalDrive } from '../drive/local.js';
import { bad } from '../lib/http.js';
import { Router } from '../lib/router.js';

/**
 * The stand-in drive's download links (/_drive/<id>?e=&s=), mounted only when the drive is the local folder
 * (development, tests, demo). They behave like OneDrive's pre-authenticated links: signed, about an hour long, and
 * answering Range requests, so the album takes exactly the same path (302 to the copy) as with OneDrive.
 */
export function localDriveRoutes(ctx: Ctx): Router {
  const r = Router();
  r.get('/:id', async (req, res) => {
    const drive = ctx.drive;
    if (!(drive instanceof LocalDrive)) throw bad(404, 'not_found', 'No such route.');
    const id = String(req.params.id);
    if (!drive.checkUrl(id, String(req.query.e ?? ''), String(req.query.s ?? ''))) throw bad(403, 'link_expired', 'This link has expired.');
    let abs: string;
    try {
      abs = drive.pathOf(id);
    } catch {
      throw bad(404, 'not_found', 'This file is not there.');
    }
    await new Promise<void>((resolve) => {
      res.sendFile(abs, { acceptRanges: true, dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=3600' } }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: 'not_found', message: 'This file is not there.' });
        resolve();
      });
    });
  });
  return r;
}
