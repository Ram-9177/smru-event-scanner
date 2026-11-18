import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { bad, parse, readCookie } from '../lib/http.js';
import { signJwt, verifyJwt } from '../lib/jwt.js';
import { Limiter } from '../lib/redis.js';
import { Router } from '../lib/router.js';
import { checkPassword, hashPassword, needsRehash, PASSWORD_MAX_BYTES, sha256Hex } from '../lib/security.js';

export interface AdminUser {
  id: string;
  email: string;
  role: 'super_admin' | 'organiser';
}

const COOKIE = 'ep_admin';
const HOURS = 12;
const AUDIENCE = 'admin';
/** Ties a session to the password it was opened with: a new password ends every older session. */
const stamp = (passwordHash: string) => sha256Hex(passwordHash).slice(0, 16);
const revokedKey = (jti: string) => `revoked:${jti}`;
const resetKey = (token: string) => `reset:${sha256Hex(token)}`;

/** A new password: at least 10 characters, and no more than bcrypt reads. */
export const NewPassword = z
  .string()
  .min(10, 'use at least 10 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= PASSWORD_MAX_BYTES, `use at most ${PASSWORD_MAX_BYTES} characters`);

/**
 * The admin session is a JWT (RS256) in an HttpOnly cookie. The cookie is HTTPS-only whenever the sign-in came
 * over HTTPS (directly, or through a proxy that passes X-Forwarded-Proto). Over plain http, as on localhost, it still works.
 */
export function setAdminCookie(ctx: Ctx, req: Request, res: Response, user: AdminUser, passwordHash: string): void {
  const token = signJwt(ctx.jwt, { role: user.role, k: stamp(passwordHash) }, { audience: AUDIENCE, subject: user.id, ttlSeconds: HOURS * 3600 });
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${HOURS * 3600}${req.secure ? '; Secure' : ''}`);
}

/** Sign out: the token is put on Redis's revoked list until it would have expired, and the cookie is cleared. */
export async function clearAdminCookie(ctx: Ctx, req: Request, res: Response): Promise<void> {
  const s = verifyJwt(ctx.jwt, readCookie(req, COOKIE), AUDIENCE);
  if (s) {
    const left = Math.max(1, s.exp - Math.floor(Date.now() / 1000));
    await ctx.redis.set(revokedKey(s.jti), '1', 'EX', left);
  }
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * The signed-in organiser, looked up on every request: an account that was removed, or whose password was
 * changed, is signed out at once and not when its token runs out; so is a token that was signed out.
 */
export async function currentAdmin(ctx: Ctx, req: Request): Promise<AdminUser | null> {
  const s = verifyJwt<{ k: string }>(ctx.jwt, readCookie(req, COOKIE), AUDIENCE);
  if (!s?.sub || !s.k) return null;
  if (await ctx.redis.exists(revokedKey(s.jti))) return null;
  const u = (await ctx.db.query<{ id: string; email: string; role: AdminUser['role']; password_hash: string }>(`select id, email, role, password_hash from users where id = $1`, [s.sub])).rows[0];
  if (!u || stamp(u.password_hash) !== s.k) return null;
  return { id: u.id, email: u.email, role: u.role };
}

/** Only signed-in organisers pass. The cookie is SameSite=Lax, so other sites cannot post with it. */
export function requireAdmin(ctx: Ctx) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await currentAdmin(ctx, req);
      if (!user) return next(bad(401, 'sign_in', 'Please sign in.'));
      res.locals.admin = user;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Team and the OneDrive connection belong to the super admin (plan: Roles). */
export function requireSuper(_req: Request, res: Response, next: NextFunction): void {
  if ((res.locals.admin as AdminUser | undefined)?.role === 'super_admin') return next();
  next(bad(403, 'super_admin_only', 'Only a super admin can do this.'));
}

/** Sign the person in after a right password or a Microsoft sign-in. */
export async function signedIn(ctx: Ctx, req: Request, res: Response, u: AdminUser & { password_hash: string }, how: 'password' | 'microsoft'): Promise<void> {
  await ctx.db.knex('users').where({ id: u.id }).update({ last_sign_in_at: ctx.db.knex.fn.now() });
  setAdminCookie(ctx, req, res, { id: u.id, email: u.email, role: u.role }, u.password_hash);
  await audit(ctx, u.email, how === 'microsoft' ? 'login.microsoft' : 'login');
}

/**
 * A one-time link to set a password: the token goes in the email, Redis keeps only its hash, for `ttl` seconds.
 * It is tied to the password at the time it was made, so it stops working once the password changes.
 */
export async function makeSetPasswordLink(ctx: Ctx, user: { id: string; password_hash: string }, ttlSeconds: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await ctx.redis.set(resetKey(token), JSON.stringify({ id: user.id, k: stamp(user.password_hash) }), 'EX', ttlSeconds);
  return `${ctx.cfg.publicUrl}/admin/reset?token=${token}`;
}

/** Sign in, sign out, forgotten password. Mounted on /api/admin before the signed-in-only routes. */
export function authRoutes(ctx: Ctx) {
  const { db, cfg } = ctx;
  const r = Router();
  // Five wrong passwords for one address from one place: wait a minute.
  const logins = new Limiter(ctx.redis, 'login', 5, 60);
  // And for one address from anywhere: twenty wrong passwords in 15 minutes, however many places they come from.
  const accountLogins = new Limiter(ctx.redis, 'login-account', 20, 15 * 60);
  // Reset emails: at most five an hour per address, so nobody can flood someone's inbox.
  const resets = new Limiter(ctx.redis, 'forgot', 5, 3600);

  r.get('/auth/options', (_req, res) => {
    res.json({ microsoft: cfg.sso.enabled });
  });

  r.post('/login', async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().trim().toLowerCase().min(3).max(200), password: z.string().min(1).max(500) }), req.body);
    const key = `${req.ip}|${email}`;
    // Every try is counted before the password is checked, so tries sent all at once are counted too.
    if (!(await logins.allow(key))) throw bad(429, 'slow_down', 'Too many tries. Wait a minute and try again.');
    if (!(await accountLogins.allow(email))) throw bad(429, 'slow_down', 'Too many wrong passwords for this account. Wait 15 minutes and try again.');
    let u = (await db.knex('users').select('id', 'email', 'role', 'password_hash').where({ email }).first()) as (AdminUser & { password_hash: string }) | undefined;
    // An unknown email still costs one bcrypt check, so the answer takes as long as a wrong password.
    if (!(await checkPassword(password, u?.password_hash)) || !u) throw bad(401, 'wrong_login', 'Wrong email or password.');
    await logins.clear(key);
    await accountLogins.giveBack(email); // a right password is not a wrong one; the account's other wrong tries still count
    if (needsRehash(u.password_hash)) {
      // Saved again with bcrypt. Older sessions of this account end, as with any password change.
      const password_hash = await hashPassword(password);
      await db.knex('users').where({ id: u.id }).update({ password_hash });
      u = { ...u, password_hash };
    }
    await signedIn(ctx, req, res, u, 'password');
    res.json({ user: { id: u.id, email: u.email, role: u.role } });
  });

  r.post('/logout', async (req, res) => {
    await clearAdminCookie(ctx, req, res);
    res.json({ ok: true });
  });

  /**
   * Always the same answer, so the form does not tell who has an account: and in the same time. The email is
   * made and sent after the answer has gone, so a slow mail server does not show which addresses are real.
   */
  r.post('/password/forgot', async (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email('that is not an email address').max(200) }), req.body);
    const u = (await resets.allow(email)) ? ((await db.knex('users').select('id', 'email', 'password_hash').where({ email }).first()) as { id: string; email: string; password_hash: string } | undefined) : undefined;
    res.json({ ok: true });
    if (u) sendResetEmail(u).catch((e) => ctx.log(`password reset email for ${u.email} failed: ${(e as Error).message}`));
  });

  async function sendResetEmail(u: { id: string; email: string; password_hash: string }): Promise<void> {
    const link = await makeSetPasswordLink(ctx, u, 30 * 60);
    const org = (await db.knex('orgs').select('name').where({ id: ctx.orgId }).first())?.name ?? cfg.orgName;
    await ctx.mailer.send({
      to: u.email,
      subject: 'Reset your Event Photos password',
      text: [
        'Hello,',
        '',
        `Someone asked to reset the password of the Event Photos account ${u.email} (${org}).`,
        '',
        'Set a new password here. The link works once, for 30 minutes:',
        link,
        '',
        "If this wasn't you, ignore this email. Your password stays as it is.",
      ].join('\n'),
    });
    await audit(ctx, u.email, 'password.forgot');
  }

  r.post('/password/reset', async (req, res) => {
    const b = parse(z.object({ token: z.string().min(20).max(200), password: NewPassword }), req.body);
    const raw = await ctx.redis.getdel(resetKey(b.token)); // one use only
    const saved = raw ? (JSON.parse(raw) as { id: string; k: string }) : null;
    const u = saved ? ((await db.knex('users').select('id', 'email', 'password_hash').where({ id: saved.id }).first()) as { id: string; email: string; password_hash: string } | undefined) : undefined;
    if (!saved || !u || stamp(u.password_hash) !== saved.k) throw bad(400, 'invalid_token', 'This link has expired or was already used. Ask for a new one.');
    await db.knex('users').where({ id: u.id }).update({ password_hash: await hashPassword(b.password) }); // every session of the account ends
    await audit(ctx, u.email, 'password.reset');
    res.json({ ok: true });
  });

  return r;
}
