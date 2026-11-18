import { Router } from '../lib/router.js';
import { audit, type Ctx } from '../context.js';
import { GraphDrive } from '../drive/index.js';
import { plainMicrosoftError, type RootMode } from '../drive/graph.js';
import { signJwt, verifyJwt } from '../lib/jwt.js';
import { currentAdmin } from './auth.js';
import { finishMicrosoftSignIn, isSsoState } from './sso.js';

/**
 * Connect OneDrive: two browser navigations, not API calls.
 *   /admin/onedrive/connect   sends the super admin to Microsoft's sign-in page
 *   /admin/onedrive/callback  Microsoft comes back here with a one-time code (the redirect URI you registered)
 *
 * ?mode=folder asks for the wider permission (Files.ReadWrite) and uses a top-level folder named Event Photos.
 * The settings screen offers it when a Microsoft 365 does not open the app's own folder.
 */
export function onedriveRoutes(ctx: Ctx): Router {
  const r = Router();
  const back = (res: any, q: string) => res.redirect(`/admin/settings?${q}`);
  const fail = (res: any, reason: string) => back(res, 'onedrive=error&reason=' + encodeURIComponent(reason.slice(0, 400)));
  const modeOf = (v: unknown): RootMode => (v === 'folder' ? 'folder' : v === 'approot' ? 'approot' : ctx.cfg.ms.root);

  r.get('/connect', async (req, res) => {
    const user = await currentAdmin(ctx, req);
    if (!user) return res.redirect('/admin/login');
    if (user.role !== 'super_admin') return fail(res, 'Only a super admin can connect OneDrive.');
    if (!(ctx.drive instanceof GraphDrive)) return back(res, 'onedrive=local');
    const mode = modeOf(req.query.mode);
    // ?switch=1: the super admin means to move to another account (the events then need their folders picked again).
    res.redirect(ctx.drive.authUrl(signJwt(ctx.jwt, { u: user.id, m: mode, sw: req.query.switch === '1' ? 1 : 0 }, { audience: 'onedrive-state', ttlSeconds: 900 }), mode));
  });

  r.get('/callback', async (req, res) => {
    // The address registered in Entra serves both: connecting OneDrive, and signing in with Microsoft.
    if (isSsoState(req.query.state)) return finishMicrosoftSignIn(ctx, req, res);
    const user = await currentAdmin(ctx, req);
    const state = verifyJwt<{ u: string; m?: string; sw?: number }>(ctx.jwt, String(req.query.state ?? ''), 'onedrive-state');
    if (!user || !state || state.u !== user.id) return fail(res, 'Sign in to the admin console and press Connect OneDrive again.');
    if (!(ctx.drive instanceof GraphDrive)) return back(res, 'onedrive=local');
    if (req.query.error || !req.query.code) {
      return fail(res, plainMicrosoftError(String(req.query.error ?? ''), String(req.query.error_description ?? 'Microsoft did not return a code.'), ctx.cfg.ms.redirectUri));
    }
    const mode = modeOf(state.m);
    try {
      // While events have folders, a sign-in as a different account is refused unless the super admin chose to switch.
      const linked = (await ctx.db.query(`select 1 from events where org_id = $1 and onedrive_folder_id is not null limit 1`, [ctx.orgId])).rows.length > 0;
      const before = linked && !state.sw ? (await ctx.db.query<{ account_email: string | null }>(`select account_email from connections where org_id = $1`, [ctx.orgId])).rows[0]?.account_email ?? null : null;
      await ctx.drive.finishSignIn(String(req.query.code), mode, { keepAccount: before });
      await audit(ctx, user.email, 'onedrive.connect', null, { mode });
      back(res, 'onedrive=connected');
    } catch (e) {
      const err = e as Error;
      ctx.log(`OneDrive sign-in failed: ${err.message}`);
      if (err.name === 'AppFolderRefused') return back(res, 'onedrive=appfolder&reason=' + encodeURIComponent(err.message));
      if (err.name === 'WrongAccount') return back(res, `onedrive=account&mode=${mode}&reason=` + encodeURIComponent(err.message));
      fail(res, err.message);
    }
  });
  return r;
}
