import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { LocalDrive } from '../../src/drive/local.js';

/**
 * A small imitation of the Microsoft endpoints the app uses, built from Microsoft's documentation:
 * the token endpoint (a refresh token is replaced on every use), the app folder, listing with paging,
 * the 302 download link, upload in one request, create folder and delete.
 * It can also expire tokens, throttle (429 + Retry-After), refuse a refresh, cut connections, answer 5xx,
 * break download links and refuse the app folder (as a Microsoft 365 that does not allow it), to test those paths.
 */
export interface MockGraph {
  base: string;
  graphBase: string;
  loginBase: string;
  dir: string;
  /** Requests seen, as "METHOD /path". */
  log: string[];
  expireAccessTokens(): void;
  revokeSignIn(): void;
  throttleNext(n: number, retryAfter?: string): void;
  /** How long download links handed out from now on work, in seconds (their tempauth exp). Default 3600. */
  linkLife(seconds: number): void;
  /** Answer permanentDelete with this status (e.g. 405, as consumer OneDrive does). null = it works (204). */
  refusePermanentDelete(status: number | null): void;
  /** Range headers seen on download-link fetches, in order. */
  ranges: (string | null)[];
  /** True if a download link was ever fetched with an Authorization header (it must not be). */
  leakedToken(): boolean;
  refreshCount(): number;
  /** The next n Graph requests get no answer at all: the connection is cut. */
  dropNext(n: number): void;
  /** The next n Graph requests are answered with this status (500, 502, 504). */
  failNext(n: number, status: number): void;
  /** The next n fetches of a download link fail: 'drop' cuts the connection, a number answers with that status. */
  breakDownloads(n: number, how: 'drop' | number): void;
  /** Answer the app-folder call with this status, as a Microsoft 365 that does not allow it would. null = allow again. */
  refuseAppFolder(status: number | null): void;
  /** The account the next sign-in is for. */
  signInAs(email: string): void;
  /** The person presses Cancel on Microsoft's permission screen. */
  cancelSignIn(on: boolean): void;
  /** Answer the next n download requests with 404, as OneDrive can for a file it listed a moment ago. */
  loseNext(n: number): void;
  /** The scope sent with each token request, in order. */
  scopes: string[];
  /** Microsoft's directory (tenant) id put in the next sign-in's ID token; default: the tenant in the address. */
  tenantInToken(tid: string | null): void;
  /** The next copy's monitor URL reports "failed" instead of finishing. */
  failNextCopy(): void;
  /**
   * The next copy's monitor says "inProgress" for this many polls before "completed" (the file itself is made at
   * once, as OneDrive goes on copying whether anyone watches). moving = its percentage rises with each poll.
   */
  slowNextCopy(polls: number, moving?: boolean): void;
  /** Every copy monitor URL handed out so far answers 404 from now on (they expire). */
  expireCopyMonitors(): void;
  /** Every copy still "inProgress" reports "completed" at its next poll. */
  finishCopies(): void;
  /** The piece that completes the next upload session is taken in full, but its answer is lost (the connection is cut). */
  loseLastChunkAnswer(): void;
  /** The next n chunks sent to an upload session are answered with this status (500, 503, 429). */
  failChunks(n: number, status: number): void;
  /** The next n chunks are only half taken: the answer's nextExpectedRanges says where to go on. */
  shortChunks(n: number): void;
  close(): Promise<void>;
}

export async function startMockGraph(dir: string, opts: { pageSize?: number; clientSecret?: string; port?: number; shares?: Record<string, string> } = {}): Promise<MockGraph> {
  fs.mkdirSync(dir, { recursive: true });
  const drive = new LocalDrive(dir);
  const pageSize = opts.pageSize ?? 2;
  const secret = opts.clientSecret ?? 'mock-secret';
  let accessN = 0;
  let validAccess = new Set<string>();
  let refreshN = 0;
  // Several sign-ins can be alive side by side, as with Microsoft; a refresh token that was used is not accepted again.
  const validRefresh = new Set<string>();
  let revoked = false; // kept for the log: a revoke empties the set of valid sign-ins
  let throttle = 0;
  let throttleAfter = '0';
  let lifeSec = 3600;
  let permanentStatus: number | null = null;
  const ranges: (string | null)[] = [];
  const tempauth = () => `v1.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + lifeSec })).toString('base64url')}.sig`;
  let leaked = false;
  let refreshes = 0;
  let drop = 0;
  let fail = { n: 0, status: 500 };
  let dl: { n: number; how: 'drop' | number } = { n: 0, how: 'drop' };
  let appFolder: number | null = null;
  let probes = 0;
  let cancelConsent = false;
  let account = 'faculty@college.test';
  let lose = 0;
  const scopes: string[] = [];
  const log: string[] = [];
  const codes = new Set<string>(['good-code']);
  // OpenID Connect (Sign in with Microsoft): an RS256 key, and what each sign-in code was asked with.
  const oidcKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const oidcJwk = { ...oidcKey.publicKey.export({ format: 'jwk' }), kid: 'mock-key-1', use: 'sig', alg: 'RS256' };
  const oidcCodes = new Map<string, { tenant: string; nonce: string; challenge: string; redirect: string }>();
  let tidOverride: string | null = null;
  // Server-side copies: each job is polled through its monitor URL (first "inProgress", then "completed").
  const copies = new Map<string, { polls: number; resourceId: string | null; fail: boolean; slow: number; moving: boolean }>();
  let failCopy = false;
  let slowCopy = { polls: 1, moving: false };
  let loseLastAnswer = false;
  // Upload sessions (createUploadSession): the bytes arrive in ranges, in order.
  const sessions = new Map<string, { parent: string; name: string; next: number; parts: Buffer[] }>();
  let chunkFail = { n: 0, status: 503 };
  let chunkShort = 0;
  /** Find any item by its id, anywhere below the root. */
  const findItem = async (id: string, parent: string | null = null): Promise<{ e: any; parentId: string } | null> => {
    for (const e of await drive.children(parent)) {
      if (e.id === id) return { e, parentId: parent ?? 'ROOT' };
      if (e.isFolder) {
        const hit = await findItem(id, e.id);
        if (hit) return hit;
      }
    }
    return null;
  };

  // Graph item ids are given a "G" in front, so they never look like the stand-in drive's own ids (<inode>-<ms>),
  // as real OneDrive ids do not (the copies job tells the two apart).
  const item = (e: any, parentId: string) => ({
    id: `G${e.id}`,
    name: e.name,
    size: e.size,
    cTag: `"c:${e.ctag}"`,
    eTag: `"e:${e.ctag}"`,
    lastModifiedDateTime: e.modifiedAt?.toISOString(),
    parentReference: { driveId: 'drive1', id: parentId === 'ROOT' ? 'ROOT' : `G${parentId.replace(/^G/, '')}` },
    ...(e.isFolder
      ? { folder: { childCount: 0 } }
      : { file: { mimeType: e.mime ?? 'application/octet-stream' }, '@microsoft.graph.downloadUrl': `${base}/dl/G${e.id}?tempauth=${tempauth()}` }),
  });
  const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
    });
  const real = (id: string) => (id === 'ROOT' ? null : id.replace(/^G/, ''));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://mock');
    const raw = decodeURIComponent(url.pathname);
    const p = raw.replace(/\/items\/G([^/:]+)/g, '/items/$1').replace(/^\/dl\/G/, '/dl/');
    log.push(`${req.method} ${raw}`);
    try {
      // ---- sign-in ---------------------------------------------------------
      // The sign-in page: a person signs in and accepts (or presses Cancel), and Microsoft sends the browser back.
      const oidcConf = /^\/([^/]+)\/v2\.0\/\.well-known\/openid-configuration$/.exec(p);
      if (req.method === 'GET' && oidcConf) {
        const t = oidcConf[1];
        return send(res, 200, {
          issuer: `${base}/${t}/v2.0`,
          authorization_endpoint: `${base}/${t}/oauth2/v2.0/authorize`,
          token_endpoint: `${base}/${t}/oauth2/v2.0/token`,
          jwks_uri: `${base}/${t}/discovery/v2.0/keys`,
          response_types_supported: ['code', 'id_token', 'code id_token'],
          subject_types_supported: ['pairwise'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        });
      }
      if (req.method === 'GET' && /\/discovery\/v2\.0\/keys$/.test(p)) return send(res, 200, { keys: [oidcJwk] });
      if (req.method === 'GET' && /\/oauth2\/v2\.0\/authorize$/.test(p)) {
        const back = new URL(url.searchParams.get('redirect_uri') || 'http://missing-redirect-uri/');
        back.searchParams.set('state', url.searchParams.get('state') || '');
        if (cancelConsent) {
          back.searchParams.set('error', 'access_denied');
          back.searchParams.set('error_description', 'AADSTS65004: User declined to consent to access the app.');
        } else if ((url.searchParams.get('scope') || '').split(' ').includes('openid')) {
          const code = `oidc-${crypto.randomUUID()}`;
          oidcCodes.set(code, {
            tenant: p.split('/')[1],
            nonce: url.searchParams.get('nonce') || '',
            challenge: url.searchParams.get('code_challenge') || '',
            redirect: url.searchParams.get('redirect_uri') || '',
          });
          back.searchParams.set('code', code);
        } else back.searchParams.set('code', 'good-code');
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (req.method === 'POST' && /\/oauth2\/v2\.0\/token$/.test(p)) {
        const f = new URLSearchParams((await readBody(req)).toString());
        scopes.push(f.get('scope') || '');
        if (f.get('client_secret') !== secret) {
          return send(res, 401, { error: 'invalid_client', error_description: "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app 'client-1'." });
        }
        const signIn = oidcCodes.get(f.get('code') || '');
        if (f.get('grant_type') === 'authorization_code' && signIn) {
          oidcCodes.delete(f.get('code')!); // a code works once
          const verifier = f.get('code_verifier') || '';
          if (crypto.createHash('sha256').update(verifier).digest('base64url') !== signIn.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'AADSTS501481: The Code_Verifier does not match the code_challenge.' });
          if (f.get('redirect_uri') !== signIn.redirect) return send(res, 400, { error: 'invalid_grant', error_description: 'AADSTS50148: redirect_uri does not match.' });
          const now = Math.floor(Date.now() / 1000);
          const idToken = jwt.sign(
            { aud: f.get('client_id'), iss: `${base}/${signIn.tenant}/v2.0`, iat: now, nbf: now, exp: now + 3600, sub: `sub-${account}`, oid: `oid-${account}`, tid: tidOverride ?? signIn.tenant, preferred_username: account, name: account.split('@')[0], nonce: signIn.nonce, ver: '2.0' },
            oidcKey.privateKey,
            { algorithm: 'RS256', keyid: 'mock-key-1' },
          );
          return send(res, 200, { token_type: 'Bearer', access_token: `oidc-at-${++accessN}`, expires_in: 3600, scope: 'openid profile email', id_token: idToken });
        }
        if (f.get('grant_type') === 'authorization_code') {
          if (!codes.has(f.get('code') || '')) return send(res, 400, { error: 'invalid_grant', error_description: 'bad code' });
        } else if (f.get('grant_type') === 'refresh_token') {
          refreshes++;
          if (!validRefresh.delete(f.get('refresh_token') || '')) return send(res, 400, { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired due to inactivity.' });
        } else return send(res, 400, { error: 'unsupported_grant_type' });
        const at = `at-${++accessN}`;
        validAccess.add(at);
        const rt = `rt-${++refreshN}`;
        validRefresh.add(rt);
        return send(res, 200, { token_type: 'Bearer', access_token: at, refresh_token: rt, expires_in: 3600, scope: f.get('scope') });
      }
      // ---- the pre-authenticated download link: no token wanted ------------------
      if (req.method === 'GET' && p.startsWith('/dl/')) {
        if (req.headers.authorization) leaked = true;
        if (dl.n > 0) {
          dl.n--;
          if (dl.how === 'drop') return void req.socket.destroy();
          return send(res, dl.how, { error: { code: 'serviceNotAvailable' } });
        }
        const t = url.searchParams.get('tempauth') ?? '';
        try {
          const exp = JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString()).exp;
          if (typeof exp === 'number' && exp * 1000 < Date.now()) return send(res, 401, { error: { code: 'unauthenticated', message: 'The link has expired.' } });
        } catch {
          /* an older link without exp: works */
        }
        const tmp = path.join(dir, `.dl-${Date.now()}-${Math.random()}`);
        try {
          await drive.children(null);
          await drive.download(p.slice(4), tmp);
        } catch {
          return send(res, 404, { error: { code: 'itemNotFound' } });
        }
        const data = fs.readFileSync(tmp);
        fs.rmSync(tmp);
        const range = req.headers.range ? String(req.headers.range) : null;
        ranges.push(range);
        const r = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
        if (r) {
          const start = Number(r[1]);
          const end = r[2] === '' ? data.length - 1 : Math.min(Number(r[2]), data.length - 1);
          if (start >= data.length) return send(res, 416, { error: { code: 'invalidRange' } });
          res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes' });
          return res.end(data.subarray(start, end + 1));
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(data.length), 'accept-ranges': 'bytes' });
        return res.end(data);
      }
      // ---- a copy's monitor URL: pre-authenticated like a download link -----------
      if (req.method === 'GET' && p.startsWith('/monitor/')) {
        if (req.headers.authorization) leaked = true;
        const job = copies.get(p.slice(9));
        if (!job) return send(res, 404, { error: { code: 'itemNotFound' } });
        if (job.polls++ < job.slow) return send(res, 202, { status: 'inProgress', percentageComplete: job.moving ? Math.min(99, job.polls) : 40 });
        if (job.fail) return send(res, 200, { status: 'failed', percentageComplete: 40, error: { code: 'copyFailed', message: 'The copy did not finish.' } });
        return send(res, 200, { status: 'completed', percentageComplete: 100, resourceId: job.resourceId });
      }
      // ---- an upload session's URL: pre-authenticated, the bytes come in ranges ---
      if (p.startsWith('/up/')) {
        if (req.headers.authorization) leaked = true;
        const id = p.slice(4);
        const s = sessions.get(id);
        if (!s) return send(res, 404, { error: { code: 'itemNotFound', message: 'The upload session is gone.' } });
        const ranges = () => ({ expirationDateTime: new Date(Date.now() + 3600_000).toISOString(), nextExpectedRanges: [`${s.next}-`] });
        if (req.method === 'GET') return send(res, 200, ranges());
        if (req.method === 'DELETE') {
          sessions.delete(id);
          res.writeHead(204);
          return res.end();
        }
        if (req.method === 'PUT') {
          const data = await readBody(req);
          if (chunkFail.n > 0) {
            chunkFail.n--;
            return send(res, chunkFail.status, { error: { code: 'serviceNotAvailable' } }, chunkFail.status === 429 ? { 'retry-after': '0' } : {});
          }
          const r = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] || ''));
          if (!r) return send(res, 400, { error: { code: 'invalidRequest', message: 'Content-Range is missing.' } });
          const [start, end, total] = [Number(r[1]), Number(r[2]), Number(r[3])];
          if (start !== s.next) return send(res, 416, { error: { code: 'invalidRange' } });
          if (data.length !== end - start + 1) return send(res, 400, { error: { code: 'invalidRequest', message: 'The chunk length does not match its range.' } });
          if (chunkShort > 0) {
            chunkShort--;
            const half = Math.max(1, Math.floor(data.length / 2));
            s.parts.push(data.subarray(0, half));
            s.next += half;
            return send(res, 202, ranges());
          }
          s.parts.push(data);
          s.next = end + 1;
          if (s.next < total) return send(res, 202, ranges());
          sessions.delete(id);
          const tmp = path.join(dir, `.up-${id}`);
          fs.writeFileSync(tmp, Buffer.concat(s.parts));
          try {
            await drive.children(null);
            const saved = await drive.uploadFile(real(s.parent), s.name, tmp, 'application/octet-stream');
            if (loseLastAnswer) {
              loseLastAnswer = false;
              return void req.socket.destroy(); // the file is made, the answer never arrives
            }
            return send(res, 201, item(saved, s.parent));
          } finally {
            fs.rmSync(tmp, { force: true });
          }
        }
      }
      // ---- everything else is Graph and needs a valid token ----------------------
      if (!p.startsWith('/v1.0/')) return send(res, 404, { error: { code: 'notFound' } });
      if (drop > 0) {
        drop--;
        return void req.socket.destroy();
      }
      if (fail.n > 0) {
        fail.n--;
        return send(res, fail.status, { error: { code: 'generalException', message: 'The service had a problem.' } });
      }
      if (throttle > 0) {
        throttle--;
        return send(res, 429, { error: { code: 'tooManyRequests' } }, { 'retry-after': throttleAfter });
      }
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ') || !validAccess.has(auth.slice(7))) return send(res, 401, { error: { code: 'InvalidAuthenticationToken' } });
      const g = p.slice(5);
      let m: RegExpMatchArray | null;

      if (req.method === 'GET' && g === '/me/drive/special/approot') {
        if (appFolder) return send(res, appFolder, { error: { code: 'accessDenied', message: 'Access denied' } });
        return send(res, 200, { id: 'ROOT', name: 'Event Photos', folder: {}, parentReference: { driveId: 'drive1' } });
      }
      // A sharing link: /shares/u!{base64url(link)}/driveItem gives the folder behind it (opts.shares maps a link to a path).
      if (req.method === 'GET' && (m = g.match(/^\/shares\/u!([^/]+)\/driveItem$/))) {
        const link = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const target = opts.shares?.[link];
        if (!target) return send(res, 403, { error: { code: 'accessDenied', message: 'Access denied' } });
        let parent: string | null = null;
        let found: any = null;
        for (const name of target.split('/')) {
          found = (await drive.children(parent)).find((e) => e.isFolder && e.name === name);
          if (!found) return send(res, 404, { error: { code: 'itemNotFound' } });
          parent = found.id;
        }
        return send(res, 200, { ...item(found, 'ROOT'), shared: { owner: { user: { displayName: 'Srihari Polakam' } } } });
      }
      // The wider permission: a folder looked up by its path from the top of the OneDrive, made when it is not there.
      if (req.method === 'GET' && (m = g.match(/^\/me\/drive\/root:\/(.+)$/))) {
        let parent: string | null = null;
        let found: any = null;
        for (const name of m[1].split('/')) {
          found = (await drive.children(parent)).find((e) => e.isFolder && e.name === name);
          if (!found) return send(res, 404, { error: { code: 'itemNotFound' } });
          parent = found.id;
        }
        return send(res, 200, item(found, 'ROOT'));
      }
      if (req.method === 'POST' && g === '/me/drive/root/children') {
        const b = JSON.parse((await readBody(req)).toString());
        return send(res, 201, item(await drive.createFolder(null, b.name), 'ROOT'));
      }
      if (req.method === 'GET' && g === '/me') return send(res, 200, { mail: account, userPrincipalName: account });
      if (req.method === 'GET' && g === '/drives/drive1') return send(res, 200, { driveType: 'business', quota: { total: 1000, used: 400, remaining: 600 } });

      if (req.method === 'GET' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+)\/children$/))) {
        const all = await drive.children(real(m[1]));
        const skip = Number(url.searchParams.get('$skiptoken') || 0);
        const size = Math.min(pageSize, Number(url.searchParams.get('$top')) || pageSize); // the smaller of the service's page and $top
        const page = all.slice(skip, skip + size);
        const body: any = { value: page.map((e) => item(e, m![1])) };
        if (skip + size < all.length) body['@odata.nextLink'] = `${base}/v1.0/drives/drive1/items/${m[1]}/children?$top=${size}&$skiptoken=${skip + size}`;
        return send(res, 200, body);
      }
      if (req.method === 'POST' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+)\/children$/))) {
        const b = JSON.parse((await readBody(req)).toString());
        const exists = (await drive.children(real(m[1]))).some((e) => e.name.toLowerCase() === String(b.name).toLowerCase());
        if (exists && b['@microsoft.graph.conflictBehavior'] === 'fail') return send(res, 409, { error: { code: 'nameAlreadyExists' } });
        return send(res, 201, item(await drive.createFolder(real(m[1]), b.name), m[1]));
      }
      if (req.method === 'GET' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+)\/content$/))) {
        if (lose > 0) {
          lose--;
          return send(res, 404, { error: { code: 'itemNotFound' } });
        }
        await drive.children(null); // refresh the id map
        const tmp = path.join(dir, `.probe-${Date.now()}-${++probes}`); // a name of its own: downloads run side by side
        try {
          await drive.download(m[1], tmp);
          fs.rmSync(tmp);
        } catch {
          return send(res, 404, { error: { code: 'itemNotFound' } });
        }
        res.writeHead(302, { location: `${base}/dl/G${m[1]}?tempauth=abc` });
        return res.end();
      }
      if (req.method === 'PUT' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+):\/(.+):\/content$/))) {
        const saved = await drive.upload(real(m[1]), m[2], await readBody(req));
        return send(res, 201, item(saved, m[1]));
      }
      if (req.method === 'PUT' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+)\/content$/))) {
        await drive.children(null);
        return send(res, 200, item(await drive.replace(m[1], await readBody(req)), 'ROOT'));
      }
      if (req.method === 'POST' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+):\/(.+):\/createUploadSession$/))) {
        await readBody(req);
        await drive.children(real(m[1])); // the folder must be there
        const id = crypto.randomUUID();
        sessions.set(id, { parent: m[1], name: m[2], next: 0, parts: [] });
        return send(res, 200, { uploadUrl: `${base}/up/${id}`, expirationDateTime: new Date(Date.now() + 3600_000).toISOString(), nextExpectedRanges: ['0-'] });
      }
      if (req.method === 'POST' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+)\/copy$/))) {
        const b = JSON.parse((await readBody(req)).toString());
        if (url.searchParams.get('@microsoft.graph.conflictBehavior') !== 'rename') return send(res, 400, { error: { code: 'invalidRequest', message: 'expected conflictBehavior=rename' } });
        await drive.children(null); // refresh the id map
        const made = await drive.copy(m[1], real(String(b.parentReference?.id ?? 'ROOT')), String(b.name));
        const job = crypto.randomUUID();
        copies.set(job, { polls: 0, resourceId: `G${made.id}`, fail: failCopy, slow: slowCopy.polls, moving: slowCopy.moving });
        failCopy = false;
        slowCopy = { polls: 1, moving: false };
        res.writeHead(202, { location: `${base}/monitor/${job}` });
        return res.end();
      }
      // An item by its name in a folder: /items/{parent}:/{name}
      if (req.method === 'GET' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+):\/([^/:]+)$/))) {
        const hit = (await drive.children(real(m[1]))).find((e) => e.name.toLowerCase() === m![2].toLowerCase());
        if (!hit) return send(res, 404, { error: { code: 'itemNotFound' } });
        return send(res, 200, item(hit, m[1]));
      }
      if (req.method === 'GET' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+)$/))) {
        const hit = await findItem(m[1]);
        if (!hit) return send(res, 404, { error: { code: 'itemNotFound' } });
        return send(res, 200, item(hit.e, hit.parentId));
      }
      if (req.method === 'PATCH' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+)$/))) {
        const b = JSON.parse((await readBody(req)).toString());
        await drive.children(null);
        return send(res, 200, item(await drive.rename(m[1], b.name), 'ROOT'));
      }
      if (req.method === 'POST' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+)\/permanentDelete$/))) {
        if (permanentStatus) return send(res, permanentStatus, { error: { code: 'notSupported', message: 'Not supported here.' } });
        await drive.children(null);
        const before = fs.readdirSync(dir, { recursive: true }).length;
        await drive.remove(m[1]);
        if (fs.readdirSync(dir, { recursive: true }).length === before) return send(res, 404, { error: { code: 'itemNotFound' } });
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'DELETE' && (m = g.match(/^\/drives\/drive1\/items\/([^/:]+)$/))) {
        const before = fs.readdirSync(dir, { recursive: true }).length;
        await drive.remove(m[1]);
        if (fs.readdirSync(dir, { recursive: true }).length === before) return send(res, 404, { error: { code: 'itemNotFound' } });
        res.writeHead(204);
        return res.end();
      }
      return send(res, 404, { error: { code: 'notFound', message: `mock has no ${req.method} ${g}` } });
    } catch (e) {
      const notFound = (e as Error).name === 'DriveNotFoundError';
      return send(res, notFound ? 404 : 500, { error: { code: notFound ? 'itemNotFound' : 'mockError', message: (e as Error).message } });
    }
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    graphBase: `${base}/v1.0`,
    loginBase: base,
    dir,
    log,
    expireAccessTokens: () => void (validAccess = new Set()),
    revokeSignIn: () => void ((revoked = true), validRefresh.clear()),
    throttleNext: (n, retryAfter = '0') => void ((throttle = n), (throttleAfter = retryAfter)),
    linkLife: (seconds) => void (lifeSec = seconds),
    refusePermanentDelete: (status) => void (permanentStatus = status),
    ranges,
    leakedToken: () => leaked,
    refreshCount: () => refreshes,
    dropNext: (n) => void (drop = n),
    failNext: (n, status) => void (fail = { n, status }),
    breakDownloads: (n, how) => void (dl = { n, how }),
    refuseAppFolder: (status) => void (appFolder = status),
    loseNext: (n) => void (lose = n),
    cancelSignIn: (on) => void (cancelConsent = on),
    signInAs: (email) => void (account = email),
    tenantInToken: (tid) => void (tidOverride = tid),
    failNextCopy: () => void (failCopy = true),
    slowNextCopy: (polls, moving = false) => void (slowCopy = { polls, moving }),
    expireCopyMonitors: () => copies.clear(),
    finishCopies: () => {
      for (const job of copies.values()) job.slow = 0;
    },
    loseLastChunkAnswer: () => void (loseLastAnswer = true),
    failChunks: (n, status) => void (chunkFail = { n, status }),
    shortChunks: (n) => void (chunkShort = n),
    scopes,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
