/**
 * Signing in to the admin console: RS256 JWT sessions, bcrypt passwords (older scrypt ones still work and are
 * saved again), Redis-backed limits and sign-out, forgotten passwords by email (Nodemailer), team invitations,
 * and Sign in with Microsoft (OpenID Connect) against the imitation of Microsoft's endpoints.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trustProxyFrom } from '../src/config.js';
import { hashPassword } from '../src/lib/security.js';
import { ADMIN, makeHarness, type Harness } from './helpers/harness.js';
import { startMockGraph, type MockGraph } from './helpers/mock-graph.js';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(() => h.close());

const cookieOf = (res: request.Response) => String(([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ep_admin=')) ?? '');
const tokenOf = (res: request.Response) => decodeURIComponent(cookieOf(res).split(';')[0].slice('ep_admin='.length));
const login = (email = ADMIN.email, password = ADMIN.password) => request(h.app).post('/api/admin/login').send({ email, password });
const me = (token: string) => request(h.app).get('/api/admin/me').set('cookie', `ep_admin=${encodeURIComponent(token)}`);
/** The reset email is sent after the answer has gone: wait for it. */
async function nextMail(h: Harness, before: number, ms = 5000) {
  for (const end = Date.now() + ms; h.mail.length <= before; ) {
    if (Date.now() > end) throw new Error('no email came');
    await new Promise((r) => setTimeout(r, 20));
  }
  return h.mail[before];
}
const linkIn = (text: string) => /https:\/\/photos\.college\.test\/admin\/reset\?token=([\w-]+)/.exec(text)?.[1] ?? '';

describe('the session token', () => {
  it('is a JWT signed with RS256, for the admin console only', async () => {
    const res = await login().expect(200);
    const token = tokenOf(res);
    const decoded = jwt.decode(token, { complete: true })!;
    expect(decoded.header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: h.ctx.jwt.kid });
    const claims = jwt.verify(token, h.ctx.jwt.publicKey, { algorithms: ['RS256'] }) as jwt.JwtPayload;
    expect(claims).toMatchObject({ aud: 'admin', iss: 'https://photos.college.test', role: 'super_admin' });
    expect(claims.exp! - claims.iat!).toBe(12 * 3600);
    expect(cookieOf(res)).toMatch(/HttpOnly; SameSite=Lax/);
    await me(token).expect(200);
  });

  it('refuses forged tokens: another key, HS256 with the public key, alg none, another purpose', async () => {
    const good = jwt.decode(tokenOf(await login().expect(200))) as jwt.JwtPayload;
    const { publicKey: _p, privateKey: other } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const claims = { sub: good.sub, role: 'super_admin', k: good.k, aud: 'admin', iss: 'https://photos.college.test' };
    await me(jwt.sign(claims, other, { algorithm: 'RS256', expiresIn: 60 })).expect(401);
    const pem = h.ctx.jwt.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await me(jwt.sign(claims, pem, { algorithm: 'HS256', expiresIn: 60 })).expect(401);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    await me(none).expect(401);
    const zip = jwt.sign({ ...claims, aud: 'zip' }, h.ctx.jwt.privateKey, { algorithm: 'RS256', expiresIn: 60 });
    await me(zip).expect(401);
  });

  it('signing out revokes that token in Redis, even though it has not expired', async () => {
    const token = tokenOf(await login().expect(200));
    await me(token).expect(200);
    await request(h.app).post('/api/admin/logout').set('cookie', `ep_admin=${encodeURIComponent(token)}`).expect(200);
    await me(token).expect(401);
    const jti = (jwt.decode(token) as jwt.JwtPayload).jti!;
    expect(await h.ctx.redis.ttl(`revoked:${jti}`)).toBeGreaterThan(12 * 3600 - 60);
  });
});

describe('passwords', () => {
  it('are stored with bcrypt', async () => {
    const row = await h.ctx.db.knex('users').where({ email: ADMIN.email }).first();
    expect(row.password_hash).toMatch(/^\$2[aby]\$12\$/);
  });

  it('an older scrypt password still signs in, and is saved again with bcrypt', async () => {
    const salt = crypto.randomBytes(16);
    const old = `scrypt$16384$${salt.toString('base64url')}$${crypto.scryptSync('an-old-scrypt-password', salt, 32, { N: 16384 }).toString('base64url')}`;
    await h.ctx.db.knex('users').insert({ org_id: h.ctx.orgId, email: 'old@college.test', password_hash: old, role: 'organiser' });
    await login('old@college.test', 'an-old-scrypt-password').expect(200);
    const row = await h.ctx.db.knex('users').where({ email: 'old@college.test' }).first();
    expect(row.password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(row.last_sign_in_at).toBeInstanceOf(Date);
    await login('old@college.test', 'an-old-scrypt-password').expect(200);
  });

  it('five wrong passwords and that address waits, even with the right one (counted in Redis)', async () => {
    await h.ctx.db.knex('users').insert({ org_id: h.ctx.orgId, email: 'slow@college.test', password_hash: await (await import('../src/lib/security.js')).hashPassword('the-right-password'), role: 'organiser' });
    for (let i = 0; i < 5; i++) await login('slow@college.test', 'wrong-password').expect(401);
    await login('slow@college.test', 'the-right-password').expect(429);
    const keys = await h.ctx.redis.keys(`${h.ctx.cfg.redisPrefix}limit:login:*slow@college.test`);
    expect(keys).toHaveLength(1);
  });

  it('forgotten password: an email with a one-time link that sets a new one', async () => {
    const before = h.mail.length;
    await request(h.app).post('/api/admin/password/forgot').send({ email: 'nobody@college.test' }).expect(200, { ok: true });
    expect(h.mail.length).toBe(before); // same answer, no email: the form does not tell who has an account

    const asked = h.mail.length;
    await request(h.app).post('/api/admin/password/forgot').send({ email: 'Old@College.test' }).expect(200, { ok: true });
    const mail = await nextMail(h, asked);
    expect(mail).toMatchObject({ to: 'old@college.test', subject: 'Reset your Event Photos password' });
    const token = linkIn(mail.text);
    expect(token.length).toBeGreaterThan(30);
    expect(await h.ctx.redis.ttl(`reset:${crypto.createHash('sha256').update(token).digest('hex')}`)).toBeGreaterThan(29 * 60);

    const signedIn = tokenOf(await login('old@college.test', 'an-old-scrypt-password').expect(200));
    await request(h.app).post('/api/admin/password/reset').send({ token, password: 'short' }).expect(400);
    await request(h.app).post('/api/admin/password/reset').send({ token, password: 'a-brand-new-password' }).expect(200);
    await request(h.app).post('/api/admin/password/reset').send({ token, password: 'a-second-new-password' }).expect(400, { error: 'invalid_token', message: 'This link has expired or was already used. Ask for a new one.' });
    await me(signedIn).expect(401); // the reset ends every session
    await login('old@college.test', 'an-old-scrypt-password').expect(401);
    await login('old@college.test', 'a-brand-new-password').expect(200);
  });
});

describe('adding someone to the team', () => {
  it('emails them where to sign in and a link to choose their own password; the typed password is never emailed', async () => {
    const res = await h.admin.post('/api/admin/team').send({ email: 'new.organiser@college.test', password: 'temporary-password-1' }).expect(201);
    expect(res.body).toMatchObject({ emailed: true, member: { email: 'new.organiser@college.test', role: 'organiser' } });
    const mail = h.mail.at(-1)!;
    expect(mail.to).toBe('new.organiser@college.test');
    expect(mail.text).toContain('https://photos.college.test/admin');
    expect(mail.text).not.toContain('temporary-password-1');
    await request(h.app).post('/api/admin/password/reset').send({ token: linkIn(mail.text), password: 'my-own-chosen-password' }).expect(200);
    await login('new.organiser@college.test', 'my-own-chosen-password').expect(200);
    const team = (await h.admin.get('/api/admin/team').expect(200)).body.team;
    expect(team.find((m: any) => m.email === 'new.organiser@college.test').last_sign_in_at).toBeTruthy();
  });

  it('Sign in with Microsoft is off when the Microsoft app is not set up', async () => {
    await request(h.app).get('/api/admin/auth/options').expect(200, { microsoft: false });
    const res = await request(h.app).get('/auth/microsoft').expect(302);
    expect(res.headers.location).toMatch(/^\/admin\?sso_error=/);
  });
});

describe('Sign in with Microsoft (OpenID Connect)', () => {
  let s: Harness;
  let mock: MockGraph;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-sso-'));
  const REDIRECT = 'https://photos.college.test/admin/onedrive/callback';

  beforeAll(async () => {
    mock = await startMockGraph(path.join(root, 'onedrive'));
    s = await makeHarness(
      {
        drive: 'graph',
        ms: {
          tenantId: 'college-tenant',
          clientId: 'client-1',
          clientSecret: 'mock-secret',
          redirectUri: REDIRECT,
          scope: 'offline_access User.Read Files.ReadWrite',
          root: 'folder',
          rootFolderName: 'Event Photos',
          rootLink: '',
          graphBase: mock.graphBase,
          loginBase: mock.loginBase,
        },
        sso: { enabled: true, redirectUri: REDIRECT },
      },
      { driveDir: mock.dir },
    );
  });
  afterAll(async () => {
    await s.close();
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The browser's trip: our app -> Microsoft -> back to the registered address -> our app. */
  async function signIn(agent = request.agent(s.app)) {
    const go = await agent.get('/auth/microsoft').set('host', 'photos.college.test').expect(302);
    const toMicrosoft = new URL(go.headers.location);
    const atMicrosoft = await fetch(toMicrosoft, { redirect: 'manual' });
    const back = new URL(atMicrosoft.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    const done = await agent.get(`/admin/onedrive/callback${back.search}`).expect(302);
    return { agent, toMicrosoft, back, done };
  }

  it('says the button can be shown', async () => {
    await request(s.app).get('/api/admin/auth/options').expect(200, { microsoft: true });
  });

  it('sends the browser to Microsoft with PKCE, a nonce and a one-time state', async () => {
    const go = await request(s.app).get('/auth/microsoft').set('host', 'photos.college.test').expect(302);
    const u = new URL(go.headers.location);
    expect(`${u.origin}${u.pathname}`).toBe(`${mock.loginBase}/college-tenant/oauth2/v2.0/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: 'client-1', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid profile email', code_challenge_method: 'S256' });
    expect(u.searchParams.get('state')).toMatch(/^sso\./);
    expect(u.searchParams.get('nonce')).toBeTruthy();
    expect(u.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
  });

  it('signs in a team member by their Microsoft account, and remembers the account', async () => {
    mock.signInAs(ADMIN.email.toUpperCase());
    const { agent, done } = await signIn();
    expect(done.headers.location).toBe('/admin');
    const who = (await agent.get('/api/admin/me').expect(200)).body.user;
    expect(who).toMatchObject({ email: ADMIN.email, role: 'super_admin' });
    const row = await s.ctx.db.knex('users').where({ email: ADMIN.email }).first();
    expect(row.ms_oid).toBe(`oid-${ADMIN.email.toUpperCase()}`);
    const audit = (await s.admin.get('/api/admin/audit').expect(200)).body;
    expect(JSON.stringify(audit)).toContain('login.microsoft');
  });

  it('refuses a Microsoft account that is not in the team', async () => {
    mock.signInAs('stranger@college.test');
    const { agent, done } = await signIn();
    const msg = new URL(done.headers.location, 'http://x').searchParams.get('sso_error');
    expect(msg).toBe('stranger@college.test is not in the team. Ask a super admin to add this email address in Team.');
    await agent.get('/api/admin/me').expect(401);
  });

  it('refuses an ID token from another directory', async () => {
    mock.signInAs(ADMIN.email);
    mock.tenantInToken('another-college');
    try {
      const { done } = await signIn();
      expect(new URL(done.headers.location, 'http://x').searchParams.get('sso_error')).toMatch(/not from this college/);
    } finally {
      mock.tenantInToken(null);
    }
  });

  it('a state works once: replaying the callback is refused', async () => {
    mock.signInAs(ADMIN.email);
    const { back } = await signIn();
    const again = await request(s.app).get(`/admin/onedrive/callback${back.search}`).expect(302);
    expect(new URL(again.headers.location, 'http://x').searchParams.get('sso_error')).toMatch(/too long or was already used/);
  });

  it('a sign-in only finishes in the browser that started it (someone else\'s half-done sign-in link is refused)', async () => {
    // Someone in the team starts a sign-in with their own Microsoft account and stops at the last step...
    mock.signInAs('second.member@college.test');
    await s.ctx.db.knex('users').insert({ org_id: s.ctx.orgId, email: 'second.member@college.test', password_hash: await hashPassword('second-member-pass'), role: 'organiser' });
    const theirs = request.agent(s.app);
    const go = await theirs.get('/auth/microsoft').set('host', 'photos.college.test').expect(302);
    expect(String(go.headers['set-cookie'])).toMatch(/ep_sso=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600/);
    const back = new URL((await fetch(new URL(go.headers.location), { redirect: 'manual' })).headers.get('location')!);
    // ...and sends the link to a signed-in super admin.
    const victim = request.agent(s.app);
    await victim.post('/api/admin/login').send(ADMIN).expect(200);
    const done = await victim.get(`/admin/onedrive/callback${back.search}`).expect(302);
    expect(new URL(done.headers.location, 'http://x').searchParams.get('sso_error')).toBe('That sign-in was started in another browser. Press Sign in with Microsoft here and try again.');
    expect((await victim.get('/api/admin/me').expect(200)).body.user.email).toBe(ADMIN.email);
  });

  it('a cancelled Microsoft sign-in says so', async () => {
    mock.cancelSignIn(true);
    try {
      const { done } = await signIn();
      expect(new URL(done.headers.location, 'http://x').searchParams.get('sso_error')).toBe('The Microsoft sign-in was cancelled.');
    } finally {
      mock.cancelSignIn(false);
    }
  });

  it('the OneDrive connection still works through the same callback address', async () => {
    const go = await s.admin.get('/admin/onedrive/connect').expect(302);
    const atMicrosoft = await fetch(new URL(go.headers.location), { redirect: 'manual' });
    const cb = new URL(atMicrosoft.headers.get('location')!);
    const back = await s.admin.get(`/admin/onedrive/callback${cb.search}`).expect(302);
    expect(new URL(back.headers.location, 'http://x').searchParams.get('onedrive')).toBe('connected');
  });
});

describe('sign-in limits hold up against tries sent all at once, and against made-up addresses', () => {
  const addUser = async (hh: Harness, email: string, password: string, role = 'organiser') =>
    hh.ctx.db.knex('users').insert({ org_id: hh.ctx.orgId, email, password_hash: await hashPassword(password), role });

  it('twenty wrong passwords sent at the same moment: only five are checked, the rest wait', async () => {
    await addUser(h, 'burst@college.test', 'the-right-password');
    const codes = (await Promise.all(Array.from({ length: 20 }, () => login('burst@college.test', 'wrong-password')))).map((r) => r.status);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(15);
    await login('burst@college.test', 'the-right-password').expect(429);
  });

  it('a made-up X-Forwarded-For from someone who is not our proxy does not give a fresh limit', async () => {
    expect(trustProxyFrom(undefined)).toBe('loopback');
    expect(trustProxyFrom('10.0.0.5, 10.0.0.6')).toBe('10.0.0.5, 10.0.0.6');
    expect(trustProxyFrom('2')).toBe(2);
    expect(trustProxyFrom('false')).toBe(false);
    expect(h.app.get('trust proxy')).toBe('loopback');
    // A server whose proxy is elsewhere: the test client is not that proxy, so its X-Forwarded-For is ignored.
    const far = await makeHarness({ trustProxy: '10.9.9.9' });
    try {
      await addUser(far, 'spoof@college.test', 'the-right-password');
      for (let i = 0; i < 5; i++) await request(far.app).post('/api/admin/login').set('x-forwarded-for', `1.2.3.${i}`).send({ email: 'spoof@college.test', password: 'wrong-password' }).expect(401);
      await request(far.app).post('/api/admin/login').set('x-forwarded-for', '1.2.3.99').send({ email: 'spoof@college.test', password: 'the-right-password' }).expect(429);
    } finally {
      await far.close();
    }
  });

  it('one account from many addresses: after twenty wrong passwords it waits, wherever the tries come from', async () => {
    await addUser(h, 'many@college.test', 'the-right-password');
    const from = (ip: string, password: string) => request(h.app).post('/api/admin/login').set('x-forwarded-for', ip).send({ email: 'many@college.test', password });
    for (let i = 0; i < 20; i++) await from(`10.1.0.${i}`, 'wrong-password').expect(401);
    const res = await from('10.1.0.200', 'the-right-password').expect(429);
    expect(res.body.message).toBe('Too many wrong passwords for this account. Wait 15 minutes and try again.');
  });

  it('a right password does not wipe out the wrong ones counted for the account', async () => {
    await addUser(h, 'mixed@college.test', 'the-right-password');
    const from = (ip: string, password: string) => request(h.app).post('/api/admin/login').set('x-forwarded-for', ip).send({ email: 'mixed@college.test', password });
    for (let i = 0; i < 10; i++) await from(`10.2.0.${i}`, 'wrong-password').expect(401);
    await from('10.2.0.100', 'the-right-password').expect(200);
    expect(Number(await h.ctx.redis.get('limit:login-account:mixed@college.test'))).toBe(10);
  });
});

describe('the time an answer takes does not tell who has an account', () => {
  const timed = async (fn: () => Promise<unknown>) => {
    const t = performance.now();
    await fn();
    return performance.now() - t;
  };

  it('signing in with an unknown email takes about as long as a wrong password', async () => {
    await login('warm-up@college.test', 'whatever').expect(401); // the first one also makes the stand-in hash
    const unknown = await timed(() => login('nobody-here@college.test', 'wrong-password').expect(401));
    const known = await timed(() => login(ADMIN.email, 'wrong-password').expect(401));
    expect(unknown).toBeGreaterThan(known / 3);
  });

  it('forgot password answers at once, even when the mail server is slow', async () => {
    const send = h.ctx.mailer.send;
    h.ctx.mailer.send = async (m) => {
      await new Promise((r) => setTimeout(r, 1500));
      return send(m);
    };
    try {
      const before = h.mail.length;
      const took = await timed(() => request(h.app).post('/api/admin/password/forgot').send({ email: ADMIN.email }).expect(200, { ok: true }));
      expect(took).toBeLessThan(1000);
      expect((await nextMail(h, before)).to).toBe(ADMIN.email);
    } finally {
      h.ctx.mailer.send = send;
    }
  });
});

describe('changing my password', () => {
  it('five wrong current passwords and the account waits, even with the right one', async () => {
    await h.ctx.db.knex('users').insert({ org_id: h.ctx.orgId, email: 'changer@college.test', password_hash: await hashPassword('the-right-password'), role: 'organiser' });
    const agent = request.agent(h.app);
    await agent.post('/api/admin/login').send({ email: 'changer@college.test', password: 'the-right-password' }).expect(200);
    const change = (current: string) => agent.post('/api/admin/password').send({ current, password: 'a-brand-new-password' });
    const codes = (await Promise.all(Array.from({ length: 8 }, () => change('wrong-password')))).map((r) => r.status);
    expect(codes.filter((c) => c === 403)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(3);
    const res = await change('the-right-password').expect(429);
    expect(res.body.message).toBe('Too many wrong passwords. Wait 15 minutes and try again.');
  });
});

describe('the last super admin', () => {
  it('two super admins demoting each other at the same moment: one of them stays super admin', async () => {
    const t = await makeHarness();
    try {
      await t.admin.post('/api/admin/team').send({ email: 'second@college.test', password: 'second-password-1', role: 'super_admin' }).expect(201);
      const second = request.agent(t.app);
      await second.post('/api/admin/login').send({ email: 'second@college.test', password: 'second-password-1' }).expect(200);
      const ids = Object.fromEntries((await t.ctx.db.knex('users').select('id', 'email')).map((u: any) => [u.email, u.id]));
      // A new password with the demotion: its slow hashing used to sit between the check and the change.
      const [a, b] = await Promise.all([
        t.admin.patch(`/api/admin/team/${ids['second@college.test']}`).send({ role: 'organiser', password: 'another-password-1' }),
        second.patch(`/api/admin/team/${ids[ADMIN.email]}`).send({ role: 'organiser', password: 'another-password-2' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 400]);
      expect([a.body.error, b.body.error]).toContain('last_super_admin');
      const supers = await t.ctx.db.knex('users').where({ role: 'super_admin' }).count<{ n: number }[]>({ n: '*' });
      expect(Number(supers[0].n)).toBe(1);
    } finally {
      await t.close();
    }
  });

  it('removing and demoting at the same moment cannot leave nobody either', async () => {
    const t = await makeHarness();
    try {
      await t.admin.post('/api/admin/team').send({ email: 'second@college.test', password: 'second-password-1', role: 'super_admin' }).expect(201);
      const second = request.agent(t.app);
      await second.post('/api/admin/login').send({ email: 'second@college.test', password: 'second-password-1' }).expect(200);
      const ids = Object.fromEntries((await t.ctx.db.knex('users').select('id', 'email')).map((u: any) => [u.email, u.id]));
      const [a, b] = await Promise.all([
        t.admin.patch(`/api/admin/team/${ids['second@college.test']}`).send({ role: 'organiser', password: 'another-password-1' }),
        second.delete(`/api/admin/team/${ids[ADMIN.email]}`),
      ]);
      expect([a.status, b.status].filter((c) => c === 200)).toHaveLength(1); // the other is refused (or finds its account gone)
      const supers = await t.ctx.db.knex('users').where({ role: 'super_admin' }).count<{ n: number }[]>({ n: '*' });
      expect(Number(supers[0].n)).toBe(1);
    } finally {
      await t.close();
    }
  });
});

describe('Sign in with Microsoft from another address', () => {
  it('a console opened on another address is sent to the registered one first, so the browser cookie lands where Microsoft comes back', async () => {
    const s = await makeHarness({ sso: { enabled: true, redirectUri: 'https://photos.college.test/admin/onedrive/callback' }, ms: { tenantId: 't', clientId: 'c', clientSecret: 's', redirectUri: 'https://photos.college.test/admin/onedrive/callback', scope: '', root: 'folder', rootFolderName: 'Event Photos', rootLink: '', graphBase: 'http://127.0.0.1:9/v1.0', loginBase: 'http://127.0.0.1:9' } });
    try {
      const go = await request(s.app).get('/auth/microsoft').set('host', 'localhost:3000').expect(302);
      expect(go.headers.location).toBe('https://photos.college.test/auth/microsoft');
    } finally {
      await s.close();
    }
  });
});
