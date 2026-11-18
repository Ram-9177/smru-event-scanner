import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Ctx } from './context.js';
import { bad, errorHandler } from './lib/http.js';
import { adminRoutes } from './routes/admin.js';
import { imageRoutes } from './routes/images.js';
import { localDriveRoutes } from './routes/localdrive.js';
import { onedriveRoutes } from './routes/onedrive.js';
import { publicRoutes } from './routes/public.js';
import { ssoRoutes } from './routes/sso.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The whole HTTP app. Tests build it with a test context and never open a port. */
export function createApp(ctx: Ctx, opts: { webDir?: string } = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Only a proxy we trust (by default one on this computer) may set the visitor's address and https. If any
  // caller could, X-Forwarded-For would give every guess a fresh address and the sign-in limit would never apply.
  app.set('trust proxy', ctx.cfg.trustProxy);
  // Query strings stay flat (?a=1&b=2), as the routes expect: no nested objects or arrays from ?a[b]=1.
  app.set('query parser', 'simple');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow'); // event pages stay out of search engines
    next();
  });

  app.use('/api', express.json({ limit: '200kb' }));
  app.use('/api/admin', adminRoutes(ctx));
  app.use('/api', publicRoutes(ctx));
  app.use('/api', (_req, _res, next) => next(bad(404, 'not_found', 'No such route.')));
  app.use('/admin/onedrive', onedriveRoutes(ctx));
  app.use('/auth/microsoft', ssoRoutes(ctx));
  app.use('/img', imageRoutes(ctx));
  // The stand-in drive's download links (development and tests): OneDrive's own links are served by Microsoft.
  if (ctx.drive.kind === 'local') app.use('/_drive', localDriveRoutes(ctx));

  // The built web app, if it is there (npm run build). In development Vite serves it instead.
  const webDir = opts.webDir ?? path.resolve(here, '../../web/dist');
  if (fs.existsSync(path.join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|img\/|auth\/|_drive\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  app.use(errorHandler(ctx.log));
  return app;
}
