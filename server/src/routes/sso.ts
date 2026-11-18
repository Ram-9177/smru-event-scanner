import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import * as oidc from 'openid-client';
import { audit, type Ctx } from '../context.js';
import { readCookie } from '../lib/http.js';
import { Router } from '../lib/router.js';
import { safeEqual, sha256Hex } from '../lib/security.js';
import { signedIn, type AdminUser } from './auth.js';

/**
 * Sign in with Microsoft (OpenID Connect, authorization code + PKCE), with the same Entra app as the OneDrive
 * connection and only for its tenant. The Microsoft account must belong to someone already in Team (same email
 * address); nobody gets an account by signing in. The first time, the account's Microsoft id is remembered, so a
 * later change of email address in Microsoft 365 still finds the same person.
 *
 *   GET /auth/microsoft              -> Microsoft's sign-in page
 *   (Microsoft comes back to the redirect URI: /admin/onedrive/callback unless MS_SSO_REDIRECT_URI says otherwise;
 *    the state says it is a sign-in, see finishMicrosoftSignIn)
 */
export const SSO_STATE_PREFIX = 'sso.';
const stateKey = (state: string) => `sso:${state}`;
/**
 * The browser that starts a sign-in gets a short cookie with a hash of its state, and the sign-in only finishes in
 * that browser. Without it, someone could start a sign-in with their own Microsoft account, stop before the last
 * step, and send that link to someone else, who would then be signed in as them without noticing.
 */
const BROWSER_COOKIE = 'ep_sso';
const browserCookie = (req: Request, value: string, maxAge: number) =>
  `${BROWSER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

let discovered: { key: string; config: Promise<oidc.Configuration> } | null = null;

function oidcConfig(ctx: Ctx): Promise<oidc.Configuration> {
  const { ms } = ctx.cfg;
  const issuer = `${ms.loginBase}/${ms.tenantId}/v2.0`;
  const key = `${issuer}|${ms.clientId}`;
  if (!discovered || discovered.key !== key) {
    const insecure = issuer.startsWith('http://') && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(issuer); // only the test stand-in
    const config = oidc.discovery(new URL(issuer), ms.clientId, ms.clientSecret, undefined, insecure ? { execute: [oidc.allowInsecureRequests] } : undefined);
    config.catch(() => {
      if (discovered?.config === config) discovered = null; // try again next time
    });
    discovered = { key, config };
  }
  return discovered.config;
}

const fail = (res: Response, message: string) => res.redirect(`/admin?sso_error=${encodeURIComponent(message.slice(0, 300))}`);

export function ssoRoutes(ctx: Ctx) {
  const r = Router();

  r.get('/', async (req, res) => {
    if (!ctx.cfg.sso.enabled) return fail(res, 'Sign in with Microsoft is not set up here. Use your email and password.');
    // Microsoft always comes back to the registered address. Start there too, so the browser cookie that ties the
    // sign-in to this browser is set on the same address (the console may be open on localhost or another name).
    const home = new URL(ctx.cfg.sso.redirectUri);
    if (req.get('host') && req.get('host') !== home.host) return res.redirect(`${home.origin}/auth/microsoft`);
    let config: oidc.Configuration;
    try {
      config = await oidcConfig(ctx);
    } catch (e) {
      ctx.log(`Microsoft sign-in: could not read Microsoft's settings: ${(e as Error).message}`);
      return fail(res, 'Microsoft cannot be reached right now. Try again in a minute, or use your email and password.');
    }
    const state = SSO_STATE_PREFIX + crypto.randomBytes(24).toString('base64url');
    const verifier = oidc.randomPKCECodeVerifier();
    const nonce = oidc.randomNonce();
    await ctx.redis.set(stateKey(state), JSON.stringify({ verifier, nonce }), 'EX', 600);
    // Lax, not Strict: Microsoft sends the browser back with a link from another site, and Strict would drop it.
    res.append('Set-Cookie', browserCookie(req, sha256Hex(state), 600));
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: ctx.cfg.sso.redirectUri,
      scope: 'openid profile email',
      response_type: 'code',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      prompt: 'select_account',
    });
    res.redirect(url.href);
  });

  // For an Entra app that registers this address instead of the OneDrive one (MS_SSO_REDIRECT_URI).
  r.get('/callback', (req, res) => finishMicrosoftSignIn(ctx, req, res));
  return r;
}

export const isSsoState = (state: unknown) => typeof state === 'string' && state.startsWith(SSO_STATE_PREFIX);

/** Microsoft came back with a code for a sign-in: check it, find the team member, open the session. */
export async function finishMicrosoftSignIn(ctx: Ctx, req: Request, res: Response): Promise<void> {
  const state = String(req.query.state ?? '');
  const saved = isSsoState(state) ? await ctx.redis.getdel(stateKey(state)) : null; // one use only
  if (!saved) return fail(res, 'That sign-in took too long or was already used. Press Sign in with Microsoft again.');
  const started = readCookie(req, BROWSER_COOKIE) ?? '';
  res.append('Set-Cookie', browserCookie(req, '', 0)); // used once either way
  if (!safeEqual(started, sha256Hex(state))) {
    ctx.log('Microsoft sign-in refused: it was finished in a different browser from the one that started it');
    return fail(res, 'That sign-in was started in another browser. Press Sign in with Microsoft here and try again.');
  }
  if (req.query.error) {
    const why = String(req.query.error_description ?? req.query.error).split(/\r?\n/)[0];
    return fail(res, req.query.error === 'access_denied' ? 'The Microsoft sign-in was cancelled.' : `Microsoft said: ${why}`);
  }
  const { verifier, nonce } = JSON.parse(saved) as { verifier: string; nonce: string };
  let claims: oidc.IDToken;
  try {
    const config = await oidcConfig(ctx);
    const current = new URL(ctx.cfg.sso.redirectUri);
    current.search = new URL(req.originalUrl, 'http://x').search;
    const tokens = await oidc.authorizationCodeGrant(config, current, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
    claims = tokens.claims()!;
  } catch (e) {
    ctx.log(`Microsoft sign-in failed: ${(e as Error).message}`);
    return fail(res, 'Microsoft did not confirm the sign-in. Try again, or use your email and password.');
  }
  if (claims.tid !== ctx.cfg.ms.tenantId) return fail(res, 'That Microsoft account is not from this college. Use your college account.');

  const oid = String(claims.oid ?? claims.sub);
  const email = String(claims.email ?? claims.preferred_username ?? '').trim().toLowerCase();
  const { knex } = ctx.db;
  type Row = AdminUser & { password_hash: string; ms_oid: string | null };
  const cols = ['id', 'email', 'role', 'password_hash', 'ms_oid'];
  let u = (await knex('users').select(cols).where({ ms_oid: oid }).first()) as Row | undefined;
  if (!u && email) {
    u = (await knex('users').select(cols).whereRaw('lower(email) = ?', [email]).first()) as Row | undefined;
    if (u && u.ms_oid && u.ms_oid !== oid) u = undefined; // that team member is already tied to another Microsoft account
    if (u) await knex('users').where({ id: u.id }).update({ ms_oid: oid });
  }
  if (!u) {
    await audit(ctx, email || oid, 'login.microsoft.refused');
    return fail(res, `${email || 'This Microsoft account'} is not in the team. Ask a super admin to add this email address in Team.`);
  }
  await signedIn(ctx, req, res, u, 'microsoft');
  res.redirect('/admin');
}
