import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { decrypt, encrypt } from '../lib/security.js';
import type { Drive, DriveEntry, DriveRead, DriveStatus } from './types.js';
import { AppFolderRefused, DriveAuthError, DriveBusyError, DriveDownError, DriveFullError, DriveNotFoundError, DriveTooLargeError, streamToBuffer, urlExpiry, WrongAccount } from './types.js';

interface Connection {
  account_email: string | null;
  refresh_token: string | null;
  drive_id: string | null;
  root_item_id: string | null;
  root_name: string | null;
  needs_reconnect: boolean;
  scope: string | null;
  root_mode: string | null;
}

/** approot = the app can reach only its own folder (Apps > Event Photos); folder = the wider permission, with a top-level folder. */
export type RootMode = 'approot' | 'folder';
const SCOPES: Record<RootMode, string> = {
  approot: 'offline_access User.Read Files.ReadWrite.AppFolder',
  folder: 'offline_access User.Read Files.ReadWrite',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The first byte an upload session still wants, from nextExpectedRanges (["12345-"] or ["0-99", "200-"]). */
function startOf(ranges: unknown): number | null {
  if (!Array.isArray(ranges) || !ranges.length) return null;
  const n = Number(String(ranges[0]).split('-')[0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Microsoft's sign-in errors in plain words, with what to do about them.
 * The meanings are from Microsoft's error-code reference; the code stays at the end so it can be searched.
 */
export function plainMicrosoftError(code: string | undefined, description: string | undefined, redirectUri = ''): string {
  const text = String(description || '');
  const id = /AADSTS\d+/.exec(text)?.[0] ?? '';
  const tips: Record<string, string> = {
    AADSTS7000215: "The client secret is wrong. MS_CLIENT_SECRET must be the secret's Value, not its Secret ID.",
    AADSTS7000222: 'The client secret has expired. Create a new one in Microsoft Entra (Certificates & secrets) and put its Value in MS_CLIENT_SECRET.',
    AADSTS7000218: 'The client secret is missing. Put the secret\'s Value in MS_CLIENT_SECRET.',
    AADSTS700016: 'Microsoft does not know this app. Check MS_CLIENT_ID (Application ID) and MS_TENANT_ID (Directory ID).',
    AADSTS90002: 'Microsoft does not know this directory. Check MS_TENANT_ID (Directory ID).',
    AADSTS50011: `The address Microsoft should come back to is not registered. In Microsoft Entra, under Authentication, add exactly: ${redirectUri}`,
    AADSTS65001: 'The permission has not been accepted yet. Press Connect OneDrive again and accept, or ask the admin to approve the app.',
    AADSTS65004: "You pressed Cancel on Microsoft's permission screen. Press Connect OneDrive again and accept.",
    AADSTS90094: 'Your college needs an admin to approve this app once. Send the admin the note from the plan.',
    AADSTS50105: 'Your account has not been given this app. Ask the admin to assign you to it (Enterprise applications > Event Photos > Users and groups).',
    AADSTS53003: "Your college's sign-in rules (Conditional Access) blocked this. Ask the admin.",
    AADSTS50020: 'That account is not from your college directory. Sign in with the college account.',
    AADSTS70011: 'Microsoft does not accept the permission the app asked for.',
    AADSTS54005: 'The sign-in page was used twice. Press Connect OneDrive again.',
    AADSTS70008: 'The saved sign-in has expired. Press Reconnect OneDrive.',
    AADSTS700082: 'The saved sign-in has expired because it was not used for a long time. Press Reconnect OneDrive.',
    AADSTS50173: 'The saved sign-in is no longer valid, for example after a password change. Press Reconnect OneDrive.',
    AADSTS50076: 'Microsoft asks for the second sign-in step again. Press Reconnect OneDrive.',
    AADSTS50079: 'Microsoft asks you to set up the second sign-in step. Press Reconnect OneDrive.',
  };
  const tip = tips[id] ?? (code === 'access_denied' ? "Microsoft's permission screen was closed without accepting. Press Connect OneDrive again." : '');
  const original = [id || code, text.replace(/\s+/g, ' ').slice(0, 160)].filter(Boolean).join(': ');
  return tip ? `${tip} (${id || code})` : `Microsoft sign-in failed. ${original}`.trim();
}

/**
 * OneDrive (work or school) through Microsoft Graph, signed in as one account (delegated permissions).
 *
 * Calls used, all checked against Microsoft's documentation on 16 November 2026:
 *   GET    /me/drive/special/approot                     the app's own folder (app-folder permission)
 *   GET    /drives/{d}/items/{id}/children               list a folder, 200 items a page, @odata.nextLink
 *   GET    /drives/{d}/items/{id}/content                302 to a short-lived download link (no token needed for it)
 *   PUT    /drives/{d}/items/{parent}:/{name}:/content   upload in one request (up to 250 MB)
 *   PUT    /drives/{d}/items/{id}/content                new content for an existing file
 *   POST   /drives/{d}/items/{parent}:/{name}:/createUploadSession   large files (videos), then PUT ranges to its uploadUrl
 *   POST   /drives/{d}/items/{id}/copy?@microsoft.graph.conflictBehavior=rename   202 + a monitor URL polled without the token
 *   GET    /drives/{d}/items/{id}                        one item (the copy, once it is made)
 *   POST   /drives/{d}/items/{parent}/children           create a folder
 *   PATCH  /drives/{d}/items/{id}                        rename
 *   DELETE /drives/{d}/items/{id}                        delete (goes to the recycle bin)
 *
 * Not yet run against a real Microsoft 365: only against test/helpers/mock-graph.ts.
 * Every request has a time limit; trouble on the network is tried again; when Microsoft cannot be
 * reached at all the work waits (DriveDownError) instead of marking photos as failed.
 */
export class GraphDrive implements Drive {
  kind = 'graph' as const;
  private access: { token: string; exp: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private retryMs: number;
  /** Upload-session chunk: Microsoft wants a multiple of 320 KiB. */
  private chunkBytes: number;
  private pollMs: number;
  private copyTimeoutMs: number;
  /** Copies still running in OneDrive when the app stopped waiting: their monitor URL (null = finished, item not known). */
  private copying = new Map<string, string | null>();

  constructor(
    private db: Db,
    private cfg: Pick<Config, 'ms' | 'sessionSecret'> & Partial<Pick<Config, 'driveUrlLifeMin'>>,
    private orgId: string,
    opts: { retryMs?: number; chunkBytes?: number; pollMs?: number; copyTimeoutMs?: number } = {},
  ) {
    this.retryMs = opts.retryMs ?? 1500;
    const unit = 320 * 1024;
    this.chunkBytes = Math.max(unit, Math.floor((opts.chunkBytes ?? 10 * 1024 * 1024) / unit) * unit);
    this.pollMs = opts.pollMs ?? 1000;
    this.copyTimeoutMs = opts.copyTimeoutMs ?? 120_000;
  }

  // ---- sign-in ---------------------------------------------------------------
  private scopeFor(mode: RootMode): string {
    return mode === this.cfg.ms.root ? this.cfg.ms.scope : SCOPES[mode];
  }

  /** Where to send the organiser to sign in with Microsoft. */
  authUrl(state: string, mode: RootMode = this.cfg.ms.root): string {
    const { ms } = this.cfg;
    const q = new URLSearchParams({
      client_id: ms.clientId,
      response_type: 'code',
      redirect_uri: ms.redirectUri,
      response_mode: 'query',
      scope: this.scopeFor(mode),
      state,
      prompt: 'select_account',
    });
    return `${ms.loginBase}/${ms.tenantId}/oauth2/v2.0/authorize?${q}`;
  }

  /**
   * Swap the one-time code for tokens, find the app's folder, then save the connection.
   * Nothing is saved unless every step worked, so a failed try never replaces a connection that works.
   */
  async finishSignIn(code: string, mode: RootMode = this.cfg.ms.root, opts: { keepAccount?: string | null } = {}): Promise<void> {
    const scope = this.scopeFor(mode);
    let tokens: any;
    try {
      tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.ms.redirectUri }, scope);
    } catch (e: any) {
      if (mode === 'approot' && (e.code === 'invalid_scope' || /AADSTS70011/.test(e.message))) throw new AppFolderRefused('Microsoft did not accept the permission');
      throw e;
    }
    if (!tokens.refresh_token) throw new Error('Microsoft did not return a lasting sign-in. Check that offline_access is among the permissions.');
    const before = this.access;
    this.access = { token: tokens.access_token, exp: Date.now() + (tokens.expires_in - 60) * 1000 };
    try {
      const root = await this.findRoot(mode);
      if (!root.id || !root.driveId) throw new Error('Microsoft answered without the folder\'s ID.');
      let email: string | null = null;
      try {
        const me = await this.json('GET', '/me?$select=mail,userPrincipalName');
        email = me.mail || me.userPrincipalName || null;
      } catch {
        /* the email is only for display */
      }
      // The event folders live in one account's OneDrive. Signing in as someone else by mistake would cut every event off from its folder.
      if (opts.keepAccount && email && email.toLowerCase() !== opts.keepAccount.toLowerCase()) {
        throw new WrongAccount(email, opts.keepAccount);
      }
      await this.db.query(
        `insert into connections (org_id, refresh_token, needs_reconnect, connected_at, renewed_at, scope, root_mode, drive_id, root_item_id, root_name, account_email)
         values ($1, $2, false, now(), now(), $3, $4, $5, $6, $7, $8)
         on conflict (org_id) do update set refresh_token = excluded.refresh_token, needs_reconnect = false, connected_at = now(), renewed_at = now(),
           scope = excluded.scope, root_mode = excluded.root_mode, drive_id = excluded.drive_id, root_item_id = excluded.root_item_id,
           root_name = excluded.root_name, account_email = excluded.account_email`,
        [this.orgId, encrypt(tokens.refresh_token, this.cfg.sessionSecret), scope, mode, root.driveId, root.id, root.name, email],
      );
    } catch (e) {
      this.access = before && before.exp > Date.now() ? before : null;
      throw e;
    }
  }

  private async findRoot(mode: RootMode): Promise<{ id: string; name: string; driveId: string }> {
    const { ms } = this.cfg;
    if (mode === 'approot') {
      const res = await this.call('GET', '/me/drive/special/approot');
      if (!res.ok && res.status !== 401) {
        // Microsoft's pages disagree on whether a work or school account may use the app folder. This is where it shows.
        const body: any = await res.json().catch(() => null);
        throw new AppFolderRefused(`${res.status} ${body?.error?.code ?? ''}`.trim());
      }
      const item = await this.check(res);
      return { id: item.id, name: `Apps > ${item.name}`, driveId: item.parentReference?.driveId };
    }
    // A folder given by its sharing link: it may live in another person's OneDrive, shared with this account.
    if (ms.rootLink) return this.findSharedRoot(ms.rootLink);
    // The wider permission: a folder in this account's OneDrive. MS_ROOT_FOLDER is its name at the top level
    // (made the first time if it is missing), or a path such as "Photos/Event Photos" to a folder that already exists.
    const parts = ms.rootFolderName.split('/').map((p) => p.trim()).filter(Boolean);
    const res = await this.call('GET', `/me/drive/root:/${parts.map(encodeURIComponent).join('/')}`);
    // Only the default "Event Photos" is made when missing; a folder someone chose must already be there,
    // so signing in with the wrong account cannot quietly start an empty folder in that account's OneDrive.
    if (res.status === 404 && (parts.length > 1 || ms.rootFolderName.trim() !== 'Event Photos')) {
      throw new Error(`The folder "${parts.join(' > ')}" is not in the OneDrive of the account that signed in. Check MS_ROOT_FOLDER in server/.env and sign in with the account that owns the folder.`);
    }
    if (res.status === 404) {
      const made = await this.json('POST', '/me/drive/root/children', {
        name: ms.rootFolderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      });
      return { id: made.id, name: made.name, driveId: made.parentReference?.driveId };
    }
    const item = await this.check(res);
    return { id: item.id, name: parts.length > 1 ? parts.join(' > ') : item.name, driveId: item.parentReference?.driveId };
  }

  /** The folder behind a sharing link (GET /shares/{u!base64url(link)}/driveItem). */
  private async findSharedRoot(link: string): Promise<{ id: string; name: string; driveId: string }> {
    const shareId = 'u!' + Buffer.from(link, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    const res = await this.call('GET', `/shares/${shareId}/driveItem`);
    if (res.status === 403 || res.status === 404 || res.status === 400) {
      throw new Error(
        `The shared folder in MS_ROOT_LINK could not be opened with this account (${res.status}). Ask its owner to share it with this account with "Can edit", and check that the app has the Files.ReadWrite.All permission.`,
      );
    }
    const found = await this.check(res);
    const item = found.remoteItem ?? found;
    if (!item.folder && !found.folder) throw new Error('MS_ROOT_LINK points at a file, not a folder. Copy the link of the folder itself.');
    const driveId = item.parentReference?.driveId;
    if (!item.id || !driveId) throw new Error('Microsoft answered without the shared folder\'s ID.');
    const owner = found.shared?.owner?.user?.displayName ?? item.shared?.owner?.user?.displayName ?? null;
    return { id: item.id, name: owner ? `${item.name} (shared by ${owner})` : item.name, driveId };
  }

  private async connection(): Promise<Connection | null> {
    const r = await this.db.query<Connection>(`select * from connections where org_id = $1`, [this.orgId]);
    return r.rows[0] ?? null;
  }

  /** One request with a time limit. null = no answer at all (network trouble or a timeout). */
  private async send(url: string, init: RequestInit, timeoutMs: number, stop?: AbortSignal): Promise<Response | null> {
    try {
      return await fetch(url, { ...init, signal: stop ? AbortSignal.any([AbortSignal.timeout(timeoutMs), stop]) : AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (stop?.aborted) throw e;
      return null;
    }
  }

  private async tokenRequest(fields: Record<string, string>, scope: string): Promise<any> {
    const { ms } = this.cfg;
    let res: Response | null = null;
    for (let tries = 0; tries < 3 && !res; tries++) {
      if (tries) await sleep(tries * this.retryMs);
      res = await this.send(
        `${ms.loginBase}/${ms.tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: ms.clientId, client_secret: ms.clientSecret, scope, ...fields }),
        },
        30_000,
      );
    }
    if (!res) throw new DriveDownError("Microsoft's sign-in service cannot be reached right now. The next sync carries on from here.");
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(plainMicrosoftError(body.error, body.error_description, ms.redirectUri));
      (err as any).code = body.error;
      throw err;
    }
    return body;
  }

  /** A valid access token. The stored sign-in is swapped for a fresh one on every use, as Microsoft requires. */
  private async token(force = false): Promise<string> {
    if (!force && this.access && this.access.exp > Date.now()) return this.access.token;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const conn = await this.connection();
        if (!conn?.refresh_token || conn.needs_reconnect) throw new DriveAuthError();
        try {
          const t = await this.tokenRequest(
            { grant_type: 'refresh_token', refresh_token: decrypt(conn.refresh_token, this.cfg.sessionSecret) },
            conn.scope || this.scopeFor(this.cfg.ms.root),
          );
          this.access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
          // renewed_at: the stored sign-in was used (Microsoft ends one unused for 90 days; alerts warn before that).
          if (t.refresh_token) {
            await this.db.query(`update connections set refresh_token = $2, renewed_at = now() where org_id = $1`, [this.orgId, encrypt(t.refresh_token, this.cfg.sessionSecret)]);
          } else {
            await this.db.query(`update connections set renewed_at = now() where org_id = $1`, [this.orgId]);
          }
          return t.access_token as string;
        } catch (e: any) {
          if (e.code === 'invalid_grant' || e.code === 'interaction_required') {
            await this.db.query(`update connections set needs_reconnect = true where org_id = $1`, [this.orgId]);
            throw new DriveAuthError();
          }
          throw e;
        }
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /**
   * One place for every Graph call:
   *   no answer            tried 3 times, then the work waits (DriveDownError)
   *   401                  the sign-in is renewed once
   *   429, 503, 509        waits as long as Microsoft asks (Retry-After), up to 5 times, then the work waits
   *   500, 502, 504        tried twice more
   * patient false (a student's request is waiting): 429/503/509 throw DriveBusyError at once, with Microsoft's Retry-After.
   */
  private async call(method: string, pathOrUrl: string, body?: unknown, extra: { raw?: Buffer; type?: string; manual?: boolean; patient?: boolean } = {}): Promise<Response> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.cfg.ms.graphBase}${pathOrUrl}`;
    let refreshed = false;
    let silent = 0;
    let busy = 0;
    let broken = 0;
    for (;;) {
      const headers: Record<string, string> = { authorization: `Bearer ${await this.token()}` };
      let payload: any;
      if (extra.raw) {
        headers['content-type'] = extra.type || 'application/octet-stream';
        payload = extra.raw;
      } else if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await this.send(url, { method, headers, body: payload, redirect: extra.manual ? 'manual' : 'follow' }, extra.raw ? 180_000 : 60_000);
      if (!res) {
        if (++silent >= 3) throw new DriveDownError();
        await sleep(silent * this.retryMs);
        continue;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.token(true);
        continue;
      }
      if (res.status === 429 || res.status === 503 || res.status === 509) {
        if (extra.patient === false) {
          const header = res.headers.get('retry-after');
          await res.body?.cancel().catch(() => {});
          const secs = header !== null && header !== '' && !Number.isNaN(Number(header)) ? Number(header) : 5;
          throw new DriveBusyError(Math.max(5, secs) * 1000);
        }
        if (++busy > 5) throw new DriveDownError('Microsoft is limiting requests to OneDrive right now. The next sync carries on from here.');
        const header = res.headers.get('retry-after');
        const wait = header !== null && header !== '' && !Number.isNaN(Number(header)) ? Number(header) : 2 ** (busy - 1);
        await sleep(Math.min(Math.max(wait, 0), 120) * 1000); // wait as long as Microsoft asks
        continue;
      }
      if ((res.status === 500 || res.status === 502 || res.status === 504) && broken < 2) {
        broken++;
        await sleep(broken * this.retryMs);
        continue;
      }
      return res;
    }
  }

  private async check(res: Response): Promise<any> {
    if (res.status === 404) throw new DriveNotFoundError();
    if (res.status === 401) throw new DriveAuthError();
    const body: any = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status === 507) throw new DriveFullError();
    // Still failing after call()'s retries: Microsoft's side, not the file's (an outage, not a reason to give up on it).
    if (res.status >= 500) throw new DriveDownError(`OneDrive answered ${res.status}: ${body?.error?.message || body?.error?.code || 'server error'}. It is tried again later.`);
    if (res.status === 423) throw new Error('The file is locked in OneDrive, usually because someone has it open.');
    if (!res.ok) throw new Error(`OneDrive answered ${res.status}: ${body?.error?.message || body?.error?.code || 'unknown error'}`);
    return body;
  }

  private async json(method: string, pathOrUrl: string, body?: unknown, extra: { patient?: boolean } = {}): Promise<any> {
    return this.check(await this.call(method, pathOrUrl, body, extra));
  }

  private async ready(): Promise<{ driveId: string; rootId: string }> {
    const conn = await this.connection();
    if (!conn?.refresh_token || conn.needs_reconnect || !conn.drive_id || !conn.root_item_id) throw new DriveAuthError();
    return { driveId: conn.drive_id, rootId: conn.root_item_id };
  }

  private entry(i: any): DriveEntry {
    const url: string | null = i['@microsoft.graph.downloadUrl'] ?? null;
    return { ...GraphDrive.entry(i), url, urlExpiresAt: url ? urlExpiry(url, this.cfg.driveUrlLifeMin ?? 55) : null };
  }

  private static entry(i: any): DriveEntry {
    const taken = i.photo?.takenDateTime;
    return {
      id: i.id,
      name: i.name,
      isFolder: !!i.folder,
      size: i.size ?? 0,
      ctag: i.cTag || i.eTag || '',
      mime: i.file?.mimeType ?? null,
      modifiedAt: i.lastModifiedDateTime ? new Date(i.lastModifiedDateTime) : null,
      takenAt: taken ? new Date(taken) : null,
    };
  }

  // ---- Drive -------------------------------------------------------------------
  async status(): Promise<DriveStatus> {
    const conn = await this.connection();
    const connected = !!(conn?.refresh_token && conn.root_item_id && !conn.needs_reconnect);
    let quota: DriveStatus['quota'] = null;
    if (connected) {
      try {
        const d = await this.json('GET', `/drives/${conn!.drive_id}?$select=quota`);
        if (d?.quota?.total) quota = { total: d.quota.total, used: d.quota.used ?? 0, remaining: d.quota.remaining ?? 0 };
      } catch {
        /* optional: not every permission may read the quota */
      }
    }
    return {
      kind: 'graph',
      connected,
      needsReconnect: !!conn?.needs_reconnect,
      account: conn?.account_email ?? null,
      rootName: conn?.root_name ?? null,
      quota,
      mode: conn?.root_mode === 'folder' ? 'folder' : conn?.root_mode === 'approot' ? 'approot' : conn?.root_item_id ? this.cfg.ms.root : null,
    };
  }

  async children(folderId: string | null, pageSize = 200, opts: { urls?: boolean; patient?: boolean } = {}): Promise<DriveEntry[]> {
    const { driveId, rootId } = await this.ready();
    const base = `/drives/${driveId}/items/${folderId ?? rootId}/children`;
    const SELECT = 'id,name,size,cTag,eTag,file,folder,lastModifiedDateTime,photo,@microsoft.graph.downloadUrl';
    const list = async (first: string) => {
      const out: DriveEntry[] = [];
      let next: string | null = first;
      while (next) {
        const page: any = await this.json('GET', next, undefined, { patient: opts.patient });
        for (const i of page.value ?? []) out.push(this.entry(i));
        next = page['@odata.nextLink'] ?? null;
      }
      return out;
    };
    if (!opts.urls) return list(`${base}?$top=${pageSize}`);
    try {
      return await list(`${base}?$top=${pageSize}&$select=${SELECT}`);
    } catch (e) {
      // A OneDrive that refuses the select (400): the plain listing, which carries the links too.
      if (!/answered 400/.test((e as Error).message)) throw e;
      return list(`${base}?$top=${Math.min(pageSize, 200)}`);
    }
  }

  /** One item, with its pre-authenticated download link (files only). */
  async item(itemId: string, opts: { patient?: boolean } = {}): Promise<DriveEntry> {
    const { driveId } = await this.ready();
    const res = await this.call('GET', `/drives/${driveId}/items/${itemId}`, undefined, { patient: opts.patient });
    if (res.status === 400) {
      const body: any = await res.json().catch(() => null);
      if (body?.error?.code === 'invalidRequest') throw new DriveNotFoundError();
      throw new Error(`OneDrive answered 400: ${body?.error?.message || body?.error?.code || 'unknown error'}`);
    }
    return this.entry(await this.check(res));
  }

  /**
   * The bytes (or a range) as a stream, never to disk. Through `url` when given (a cached link: no Graph call); a
   * cached link that has stopped working (401/403/404/410) is replaced by a fresh one once.
   */
  async read(itemId: string, opts: { url?: string | null; range?: string | null; signal?: AbortSignal; patient?: boolean } = {}): Promise<DriveRead> {
    let url = opts.url ?? null;
    let stale = false;
    for (let fresh = !url; ; fresh = true) {
      if (!url) {
        const c = await this.content(itemId, opts.patient);
        if ('res' in c) return { ...this.toRead(c.res), staleUrl: stale };
        url = c.url;
      }
      const headers: Record<string, string> = opts.range ? { range: opts.range } : {};
      const res = await this.send(url, { headers }, 2 * 60 * 60_000, opts.signal); // the link is pre-authenticated: no token is sent
      if (!res) throw new DriveDownError('OneDrive did not send the file.');
      if ([401, 403, 404, 410].includes(res.status) && !fresh) {
        await res.body?.cancel().catch(() => {});
        url = null;
        stale = true;
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => {});
        throw new DriveNotFoundError();
      }
      if (res.status === 429 || res.status === 503) {
        const header = res.headers.get('retry-after');
        await res.body?.cancel().catch(() => {});
        throw new DriveBusyError(Math.max(5, Number(header) || 5) * 1000);
      }
      if (res.status === 416) {
        await res.body?.cancel().catch(() => {});
        throw new Error('The range asked for is outside the file.');
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        if (res.status >= 500) throw new DriveDownError(`OneDrive did not send the file (status ${res.status}).`);
        throw new Error(`The download from OneDrive failed (status ${res.status}).`);
      }
      return { ...this.toRead(res), staleUrl: stale };
    }
  }

  private toRead(res: Response): DriveRead {
    const len = res.headers.get('content-length');
    return {
      status: res.status === 206 ? 206 : 200,
      size: len !== null && len !== '' ? Number(len) : null,
      contentRange: res.headers.get('content-range'),
      mime: res.headers.get('content-type'),
      body: res.body as unknown as ReadableStream<Uint8Array>,
    };
  }

  async readAll(itemId: string, maxBytes: number, signal?: AbortSignal, opts: { patient?: boolean } = {}): Promise<Buffer> {
    const r = await this.read(itemId, { signal, patient: opts.patient });
    if (r.size !== null && r.size > maxBytes) {
      await r.body.cancel().catch(() => {});
      throw new DriveTooLargeError(r.size);
    }
    try {
      return await streamToBuffer(r.body, maxBytes);
    } catch (e) {
      if (e instanceof DriveTooLargeError || signal?.aborted) throw e;
      throw new DriveDownError('The connection to OneDrive dropped.');
    }
  }

  /** Ask for the file's content. Microsoft answers with a short-lived link (302); a drive that sends the bytes at once is handled too. */
  private async content(itemId: string, patient?: boolean): Promise<{ url: string } | { res: Response }> {
    const { driveId } = await this.ready();
    const res = await this.call('GET', `/drives/${driveId}/items/${itemId}/content`, undefined, { manual: true, patient });
    // An ID OneDrive cannot even read (a file from before OneDrive was connected) is answered 400 invalidRequest:
    // for the app that is the same as a file that is not there.
    if (res.status === 400) {
      const body: any = await res.json().catch(() => null);
      if (body?.error?.code === 'invalidRequest') throw new DriveNotFoundError();
      throw new Error(`OneDrive answered 400: ${body?.error?.message || body?.error?.code || 'unknown error'}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const url = res.headers.get('location');
      if (!url) throw new Error('OneDrive did not return a download link.');
      return { url };
    }
    if (res.ok) return { res };
    await this.check(res);
    throw new Error(`OneDrive answered ${res.status} for a download.`);
  }

  async downloadUrl(itemId: string): Promise<string | null> {
    const c = await this.content(itemId);
    if ('url' in c) return c.url;
    await c.res.body?.cancel().catch(() => {});
    return null;
  }

  async download(itemId: string, destPath: string, signal?: AbortSignal, opts: { patient?: boolean } = {}): Promise<void> {
    try {
      await this.fetchTo(itemId, destPath, signal, opts.patient);
    } catch (e) {
      await fs.promises.rm(destPath, { force: true }); // never a part-file left behind
      throw e;
    }
  }

  private async fetchTo(itemId: string, destPath: string, signal?: AbortSignal, patient?: boolean): Promise<void> {
    let last = '';
    let silent = false;
    for (let tries = 0; tries < 3; tries++) {
      signal?.throwIfAborted();
      if (tries) await sleep(tries * this.retryMs);
      const c = await this.content(itemId, patient); // a fresh link every time: they can expire within minutes
      const res = 'url' in c ? await this.send(c.url, {}, 600_000, signal) : c.res; // the link is pre-authenticated: no token is sent
      silent = !res;
      if (res?.status === 404) throw new DriveNotFoundError();
      if (res?.ok && res.body) {
        try {
          await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(destPath), { signal });
          return;
        } catch (e) {
          if (signal?.aborted) throw e;
          silent = true;
          last = 'the connection dropped';
          continue;
        }
      }
      last = res ? `status ${res.status}` : 'no answer';
      await res?.body?.cancel().catch(() => {});
      const header = res?.headers.get('retry-after');
      if (header && !Number.isNaN(Number(header))) await sleep(Math.min(Number(header), 120) * 1000);
    }
    if (silent) throw new DriveDownError(`OneDrive did not send the file (${last}). The next sync carries on from here.`);
    throw new Error(`The download from OneDrive failed (${last}).`);
  }

  async createFolder(parentId: string | null, name: string): Promise<DriveEntry> {
    const { driveId, rootId } = await this.ready();
    const parent = parentId ?? rootId;
    const find = async () => (await this.children(parent)).find((e) => e.isFolder && e.name.toLowerCase() === name.toLowerCase());
    const existing = await find();
    if (existing) return existing;
    const res = await this.call('POST', `/drives/${driveId}/items/${parent}/children`, { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
    if (res.status === 409) {
      const again = await find();
      if (again) return again;
    }
    return GraphDrive.entry(await this.check(res));
  }

  async upload(parentId: string | null, name: string, data: Buffer, mime: string): Promise<DriveEntry> {
    const { driveId, rootId } = await this.ready();
    const res = await this.call('PUT', `/drives/${driveId}/items/${parentId ?? rootId}:/${encodeURIComponent(name)}:/content`, undefined, { raw: data, type: mime });
    return GraphDrive.entry(await this.check(res));
  }

  /**
   * A large file through an upload session: POST .../createUploadSession, then the file in chunks (a multiple of
   * 320 KiB, 10 MiB by default) PUT to the session's own URL, which is pre-authenticated (no token is sent to it).
   * A chunk answered 5xx or 429, or with no answer, is sent again from where the session says it stands
   * (nextExpectedRanges). A session that has gone (404) is started once more.
   */
  async uploadFile(parentId: string | null, name: string, filePath: string, mime: string): Promise<DriveEntry> {
    const { driveId, rootId } = await this.ready();
    const size = (await fs.promises.stat(filePath)).size;
    if (size === 0) return this.upload(parentId, name, Buffer.alloc(0), mime);
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const session = await this.json('POST', `/drives/${driveId}/items/${parentId ?? rootId}:/${encodeURIComponent(name)}:/createUploadSession`, {
        item: { '@microsoft.graph.conflictBehavior': 'rename' },
      });
      if (!session?.uploadUrl) throw new Error('OneDrive did not start the upload.');
      const out = await this.sendSession(session.uploadUrl, filePath, size, startOf(session.nextExpectedRanges) ?? 0);
      if (out === 'unsure') {
        // The last piece went out but its answer never came back, and the session is closed now: OneDrive most
        // likely made the file. Use it rather than sending the whole file again (which would leave two).
        const made = await this.itemAt(driveId, parentId ?? rootId, name);
        // (made during this upload: not an older file that happens to have the same name and size)
        if (made && !made.isFolder && made.size === size && (made.modifiedAt?.getTime() ?? 0) >= started - 5 * 60_000) return made;
      } else if (out !== 'gone') return out;
      if (attempt >= 1) throw new DriveDownError('OneDrive dropped the upload twice. It is tried again later.');
    }
  }

  /** 'gone' = the session expired; 'unsure' = it closed after the last piece was sent without an answer (maybe finished). */
  private async sendSession(uploadUrl: string, filePath: string, size: number, from: number): Promise<DriveEntry | 'gone' | 'unsure'> {
    const fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(Math.min(this.chunkBytes, size));
    const cancel = () => this.send(uploadUrl, { method: 'DELETE' }, 30_000).then((r) => r?.body?.cancel().catch(() => {}));
    const where = async (): Promise<number | null> => {
      const r = await this.send(uploadUrl, {}, 30_000);
      if (!r?.ok) return null;
      return startOf(((await r.json().catch(() => null)) as any)?.nextExpectedRanges);
    };
    try {
      let offset = from;
      let trouble = 0;
      let lastUnanswered = false; // the piece that ends the file got no answer (or a 5xx): OneDrive may have finished
      const gone = () => (lastUnanswered ? ('unsure' as const) : ('gone' as const));
      for (;;) {
        if (offset >= size) {
          const at = await where();
          if (at === null && lastUnanswered) return 'unsure';
          if (at === null || at >= size) throw new Error('OneDrive did not finish the upload.');
          offset = at;
        }
        const len = Math.min(this.chunkBytes, size - offset);
        const { bytesRead } = await fh.read(buf, 0, len, offset);
        if (bytesRead !== len) throw new Error('The file changed while it was being sent to OneDrive.');
        const res = await this.send(
          uploadUrl,
          { method: 'PUT', headers: { 'content-range': `bytes ${offset}-${offset + len - 1}/${size}` }, body: new Uint8Array(buf.buffer, buf.byteOffset, len) },
          300_000,
        );
        if (res && (res.status === 200 || res.status === 201)) return GraphDrive.entry(await res.json());
        if (res && res.status === 202) {
          const body: any = await res.json().catch(() => null);
          offset = startOf(body?.nextExpectedRanges) ?? offset + len;
          trouble = 0;
          continue;
        }
        if (res && (res.status === 404 || res.status === 410)) {
          await res.body?.cancel().catch(() => {});
          return gone(); // the session expired (or finished): start a new one, or look for the file
        }
        if (res && res.status === 416) {
          await res.body?.cancel().catch(() => {});
          const at = await where();
          if (at === null) return gone();
          offset = at;
          continue;
        }
        if (!res || res.status === 429 || res.status >= 500) {
          if (offset + len >= size && (!res || res.status >= 500)) lastUnanswered = true;
          if (++trouble > 5) {
            await cancel();
            throw new DriveDownError('OneDrive did not take the file just now. It is tried again later.');
          }
          const header = res?.headers.get('retry-after');
          await res?.body?.cancel().catch(() => {});
          const ask = header && !Number.isNaN(Number(header)) ? Number(header) * 1000 : trouble * this.retryMs;
          await sleep(Math.min(Math.max(ask, 0), 120_000));
          const at = await where(); // honour what the session already has
          if (at !== null) offset = at;
          continue;
        }
        const body: any = await res.json().catch(() => null);
        await cancel();
        if (res.status === 507) throw new DriveFullError();
        throw new Error(`OneDrive refused the upload (${res.status}: ${body?.error?.message || body?.error?.code || 'unknown error'}).`);
      }
    } finally {
      await fh.close();
    }
  }

  /**
   * A copy made by OneDrive itself: POST /items/{id}/copy answers 202 with a monitor URL, which is polled
   * (it is pre-authenticated: no token is sent to it) until the copy is completed, then the new item is read.
   *
   * OneDrive goes on copying when the app stops waiting. So a copy that is still running when the wait ends
   * (copyTimeoutMs without progress; a large video that keeps moving is waited for) is remembered, and the next
   * copy of the same file to the same place follows that one instead of starting another: no "name 1.mp4" pile-up.
   * If its monitor is gone by then, the file it made is looked up by name and size.
   */
  async copy(itemId: string, parentId: string | null, name: string): Promise<DriveEntry> {
    const { driveId, rootId } = await this.ready();
    const parent = parentId ?? rootId;
    const key = `${itemId}>${parent}/${name}`;
    const earlier = this.copying.get(key);
    if (earlier !== undefined) {
      if (earlier) {
        const was = await this.followCopy(earlier, driveId);
        if (was === 'waiting') throw new DriveDownError('OneDrive is still copying the file. It is tried again later.');
        if (typeof was === 'object' && 'entry' in was) {
          this.copying.delete(key);
          return was.entry;
        }
      }
      // The earlier copy's monitor is gone: the file it made, if it finished, has the name and size asked for.
      this.copying.delete(key);
      const made = await this.itemAt(driveId, parent, name);
      const source = made ? GraphDrive.entry(await this.json('GET', `/drives/${driveId}/items/${itemId}`)) : null;
      if (made && !made.isFolder && source && made.size === source.size) return made;
    }
    const res = await this.call('POST', `/drives/${driveId}/items/${itemId}/copy?@microsoft.graph.conflictBehavior=rename`, {
      parentReference: { driveId, id: parent },
      name,
    });
    if (res.status !== 202) {
      const body = await this.check(res);
      if (body?.id) return GraphDrive.entry(body); // a drive that copies at once
      throw new Error(`OneDrive answered ${res.status} to a copy without the new file.`);
    }
    const monitor = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!monitor) throw new Error('OneDrive did not say where to follow the copy.');
    this.copying.set(key, monitor);
    const out = await this.followCopy(monitor, driveId);
    if (out === 'waiting') throw new DriveDownError('OneDrive is taking too long to copy the file. It is tried again later.');
    if (out === 'lost') {
      this.copying.set(key, null); // finished without saying which file it made: the next try looks it up by name
      throw new DriveDownError('OneDrive did not say which file the copy made. It is tried again later.');
    }
    this.copying.delete(key);
    if ('failed' in out) throw new Error(`OneDrive could not copy the file: ${out.failed}`);
    return out.entry;
  }

  /** Poll a copy's monitor until it is done, failed or gone, or stops moving for copyTimeoutMs ('waiting'). */
  private async followCopy(monitor: string, driveId: string): Promise<{ entry: DriveEntry } | { failed: string } | 'waiting' | 'lost'> {
    let deadline = Date.now() + this.copyTimeoutMs;
    let progress = -1;
    let wait = this.pollMs;
    for (;;) {
      const m = await this.send(monitor, { redirect: 'manual' }, 30_000);
      if (m) {
        if (m.status >= 300 && m.status < 400 && m.headers.get('location')) {
          await m.body?.cancel().catch(() => {});
          return { entry: GraphDrive.entry(await this.json('GET', m.headers.get('location')!)) };
        }
        if (m.status === 404 || m.status === 410) {
          await m.body?.cancel().catch(() => {});
          return 'lost'; // the monitor has expired
        }
        const b: any = await m.json().catch(() => null);
        if (b?.status === 'completed') {
          if (!b.resourceId) return 'lost';
          return { entry: GraphDrive.entry(await this.json('GET', `/drives/${driveId}/items/${b.resourceId}`)) };
        }
        if (b?.status === 'failed') return { failed: b.error?.message || b.errorCode || 'unknown error' };
        const pct = Number(b?.percentageComplete);
        if (Number.isFinite(pct) && pct > progress) {
          if (progress >= 0) deadline = Date.now() + this.copyTimeoutMs; // still moving: a large file is waited for
          progress = pct;
        }
      }
      if (Date.now() > deadline) return 'waiting';
      await sleep(wait);
      wait = Math.min(wait * 2, 5000);
    }
  }

  /** The item with this name in a folder, or null. */
  private async itemAt(driveId: string, parentId: string, name: string): Promise<DriveEntry | null> {
    const res = await this.call('GET', `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}`);
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return GraphDrive.entry(await this.check(res));
  }

  /**
   * permanent: POST permanentDelete (OneDrive for Business), so the app's own copies never pile up in the recycle bin
   * where they count against the quota. A OneDrive without it (consumer, or the app-folder permission) answers
   * 400/403/404/405: then the usual DELETE.
   */
  async remove(itemId: string, opts: { permanent?: boolean } = {}): Promise<void> {
    const { driveId } = await this.ready();
    if (opts.permanent) {
      const p = await this.call('POST', `/drives/${driveId}/items/${itemId}/permanentDelete`);
      if (p.status === 204 || p.status === 200) return;
      await p.body?.cancel().catch(() => {});
      if (![400, 403, 404, 405, 501].includes(p.status)) await this.check(p);
    }
    const res = await this.call('DELETE', `/drives/${driveId}/items/${itemId}`);
    if (res.status === 404) return;
    await this.check(res);
  }

  async rename(itemId: string, name: string): Promise<DriveEntry> {
    const { driveId } = await this.ready();
    return GraphDrive.entry(await this.json('PATCH', `/drives/${driveId}/items/${itemId}`, { name }));
  }

  async replace(itemId: string, data: Buffer, mime: string): Promise<DriveEntry> {
    const { driveId } = await this.ready();
    return GraphDrive.entry(await this.check(await this.call('PUT', `/drives/${driveId}/items/${itemId}/content`, undefined, { raw: data, type: mime })));
  }

  async renew(): Promise<void> {
    await this.token(true);
  }
}
