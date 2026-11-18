/**
 * The same checks run against both storage adapters:
 *   local - the folder that stands in for OneDrive
 *   graph - the Microsoft Graph adapter, talking to an imitation of Microsoft's endpoints
 * The Graph adapter is NOT tested here against a real Microsoft 365: that is the Phase 1 check on your tenant.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/index.js';
import { openTestDb, testId, TEST_DATABASE_URL } from './helpers/db.js';
import { AppFolderRefused, DriveAuthError, DriveBusyError, DriveDownError, DriveFullError, DriveNotFoundError, GraphDrive, LocalDrive, listTree, urlExpiry, type Drive } from '../src/drive/index.js';
import { checkDrive } from '../src/drive/check.js';
import { plainMicrosoftError } from '../src/drive/graph.js';
import { startMockGraph, type MockGraph } from './helpers/mock-graph.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-drive-'));
let db: Db;
let mock: MockGraph;
let graph: GraphDrive;
/** The same connection, waiting only 40 ms for a copy that does not move. */
let quick: GraphDrive;
let baseCfg: ReturnType<typeof loadConfig>;
const drives: Record<string, { drive: () => Drive; dir: string }> = {};

beforeAll(async () => {
  mock = await startMockGraph(path.join(tmp, 'graph-root'), { pageSize: 2 });
  const cfg = loadConfig(
    {},
    {
      dataDir: path.join(tmp, 'data'),
      databaseUrl: TEST_DATABASE_URL,
      sessionSecret: 'drive-test-secret-drive-test-secret',
      drive: 'graph',
      ms: {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        clientSecret: 'mock-secret',
        redirectUri: 'https://photos.college.test/admin/onedrive/callback',
        scope: 'offline_access User.Read Files.ReadWrite.AppFolder',
        root: 'approot',
        rootFolderName: 'Event Photos',
        rootLink: '',
        graphBase: mock.graphBase,
        loginBase: mock.loginBase,
      },
    },
  );
  db = await openTestDb(testId());
  const org = (await db.query<{ id: string }>(`insert into orgs (name, slug) values ('T', 'drive-test') returning id`)).rows[0].id;
  graph = new GraphDrive(db, cfg, org, { retryMs: 10, chunkBytes: 320 * 1024, pollMs: 10 });
  quick = new GraphDrive(db, cfg, org, { retryMs: 10, chunkBytes: 320 * 1024, pollMs: 5, copyTimeoutMs: 40 });
  baseCfg = cfg;
  const local = new LocalDrive(path.join(tmp, 'local-root'));
  drives.local = { drive: () => local, dir: path.join(tmp, 'local-root') };
  drives.graph = { drive: () => graph, dir: mock.dir };
});

afterAll(async () => {
  await mock.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Connect OneDrive (Graph adapter)', () => {
  it('is not connected before sign-in', async () => {
    expect((await graph.status()).connected).toBe(false);
    await expect(graph.children(null)).rejects.toBeInstanceOf(DriveAuthError);
  });

  it('builds the Microsoft sign-in address with the registered redirect URI and scopes', () => {
    const u = new URL(graph.authUrl('state-123'));
    expect(u.pathname).toBe('/tenant-1/oauth2/v2.0/authorize');
    expect(u.searchParams.get('client_id')).toBe('client-1');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('redirect_uri')).toBe('https://photos.college.test/admin/onedrive/callback');
    expect(u.searchParams.get('scope')).toBe('offline_access User.Read Files.ReadWrite.AppFolder');
    expect(u.searchParams.get('state')).toBe('state-123');
  });

  it('refuses a bad code', async () => {
    await expect(graph.finishSignIn('bad-code')).rejects.toThrow(/invalid_grant/);
  });

  it('swaps the code for tokens, finds the app folder and stores the sign-in encrypted', async () => {
    await graph.finishSignIn('good-code');
    const st = await graph.status();
    expect(st).toMatchObject({ connected: true, needsReconnect: false, account: 'faculty@college.test', rootName: 'Apps > Event Photos' });
    expect(st.quota).toEqual({ total: 1000, used: 400, remaining: 600 });
    const row = (await db.query(`select refresh_token, drive_id, root_item_id from connections`)).rows[0];
    expect(row.drive_id).toBe('drive1');
    expect(row.root_item_id).toBe('ROOT');
    expect(row.refresh_token).not.toContain('rt-'); // never stored in plain text
    expect(row.refresh_token).toMatch(/^v1\./);
  });
});

for (const kind of ['local', 'graph'] as const) {
  describe(`drive contract: ${kind}`, () => {
    let d: Drive;
    let folderId: string;
    let fileId: string;
    beforeAll(() => {
      d = drives[kind].drive();
    });

    it('creates a folder once, and returns the same one the second time', async () => {
      const a = await d.createFolder(null, '2026-11-20 Annual Day');
      const b = await d.createFolder(null, '2026-11-20 Annual Day');
      expect(b.id).toBe(a.id);
      expect(a.isFolder).toBe(true);
      folderId = a.id;
      expect((await d.children(null)).filter((e) => e.isFolder).map((e) => e.name)).toEqual(['2026-11-20 Annual Day']);
    });

    it('uploads a file and lists it with its size and content tag', async () => {
      const saved = await d.upload(folderId, 'photo 1.jpg', Buffer.from('first version'), 'image/jpeg');
      fileId = saved.id;
      const list = await d.children(folderId);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: fileId, name: 'photo 1.jpg', isFolder: false, size: 13 });
      expect(list[0].ctag).toBeTruthy();
    });

    it('downloads the same bytes', async () => {
      const dest = path.join(tmp, `dl-${kind}`);
      await d.download(fileId, dest);
      expect(fs.readFileSync(dest, 'utf8')).toBe('first version');
    });

    it('lists every file of a folder with many files (paging)', async () => {
      for (let i = 2; i <= 6; i++) await d.upload(folderId, `photo ${i}.jpg`, Buffer.from(`n${i}`), 'image/jpeg');
      expect((await d.children(folderId)).map((e) => e.name).sort()).toEqual(['photo 1.jpg', 'photo 2.jpg', 'photo 3.jpg', 'photo 4.jpg', 'photo 5.jpg', 'photo 6.jpg']);
    });

    it('reads an event folder and its subfolders one level down', async () => {
      const stage = await d.createFolder(folderId, 'Stage');
      await d.upload(stage.id, 's1.jpg', Buffer.from('stage'), 'image/jpeg');
      const tree = await listTree(d, folderId);
      expect(tree.folders.map((f) => f.name)).toEqual(['Stage']);
      expect(tree.files).toHaveLength(7);
      expect(tree.files.find((f) => f.name === 's1.jpg')).toMatchObject({ folderId: stage.id, folderName: 'Stage' });
      expect(tree.files.find((f) => f.name === 'photo 1.jpg')?.folderName).toBeNull();
    });

    it('keeps the id when a file is renamed, and changes the content tag when the content changes', async () => {
      const dir = path.join(drives[kind].dir, '2026-11-20 Annual Day');
      const before = (await d.children(folderId)).find((e) => e.id === fileId)!;
      fs.renameSync(path.join(dir, 'photo 1.jpg'), path.join(dir, 'renamed.jpg'));
      const renamed = (await d.children(folderId)).find((e) => e.id === fileId)!;
      expect(renamed.name).toBe('renamed.jpg');
      expect(renamed.ctag).toBe(before.ctag);
      fs.writeFileSync(path.join(dir, 'renamed.jpg'), 'second version, longer');
      const changed = (await d.children(folderId)).find((e) => e.id === fileId)!;
      expect(changed.ctag).not.toBe(before.ctag);
    });

    it('removes a file; removing it again is not an error; downloading it is a clear "not found"', async () => {
      await d.remove(fileId);
      expect((await d.children(folderId)).find((e) => e.id === fileId)).toBeUndefined();
      await d.remove(fileId);
      await expect(d.download(fileId, path.join(tmp, 'never'))).rejects.toBeInstanceOf(DriveNotFoundError);
    });
  });
}

/** About 1.1 MB of bytes that differ everywhere, so a chunk sent in the wrong place shows. */
const bigBytes = (seed: number) => {
  const b = Buffer.alloc(1_100_000);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + seed * 7 + (i >> 9)) & 0xff;
  return b;
};

for (const kind of ['local', 'graph'] as const) {
  describe(`large files and copies: ${kind}`, () => {
    let d: Drive;
    let folderId: string;
    let people: string;
    let videoId: string;
    const src = path.join(tmp, `big-${kind}.mp4`);
    beforeAll(async () => {
      d = drives[kind].drive();
      folderId = (await d.createFolder(null, 'Videos')).id;
      people = (await d.createFolder(null, 'People')).id;
      fs.writeFileSync(src, bigBytes(1));
    });

    it('uploads a large file from disk and gets the same bytes back', async () => {
      const n = mock.log.length;
      const saved = await d.uploadFile(folderId, 'clip.mp4', src, 'video/mp4');
      videoId = saved.id;
      expect(saved).toMatchObject({ name: 'clip.mp4', isFolder: false, size: 1_100_000 });
      expect((await d.children(folderId)).map((e) => e.name)).toEqual(['clip.mp4']);
      const back = path.join(tmp, `big-back-${kind}`);
      await d.download(saved.id, back);
      expect(fs.readFileSync(back).equals(fs.readFileSync(src))).toBe(true);
      if (kind === 'graph') {
        // 1.1 MB in 320 KiB pieces = 4 chunks, sent to the session URL without the token
        expect(mock.log.slice(n).filter((l) => l.startsWith('PUT /up/'))).toHaveLength(4);
        expect(mock.log.slice(n).some((l) => l.endsWith(':/createUploadSession'))).toBe(true);
        expect(mock.leakedToken()).toBe(false);
      }
    });

    it('never replaces a file of the same name: the second one gets a number', async () => {
      const again = await d.uploadFile(folderId, 'clip.mp4', src, 'video/mp4');
      expect(again.id).not.toBe(videoId);
      expect(again.name).toBe('clip 1.mp4');
      expect((await d.children(folderId)).map((e) => e.name).sort()).toEqual(['clip 1.mp4', 'clip.mp4']);
    });

    it('copies a file into another folder inside the drive; the original stays', async () => {
      const copy = await d.copy(videoId, people, 'Riya - clip.mp4');
      expect(copy).toMatchObject({ name: 'Riya - clip.mp4', isFolder: false, size: 1_100_000 });
      expect(copy.id).not.toBe(videoId);
      expect((await d.children(people)).map((e) => e.id)).toEqual([copy.id]);
      expect((await d.children(folderId)).some((e) => e.id === videoId)).toBe(true);
      const back = path.join(tmp, `copy-back-${kind}`);
      await d.download(copy.id, back);
      expect(fs.readFileSync(back).equals(fs.readFileSync(src))).toBe(true);
      const second = await d.copy(videoId, people, 'Riya - clip.mp4');
      expect(second.name).toBe('Riya - clip 1.mp4'); // a taken name is never overwritten
      if (kind === 'graph') {
        expect(mock.log.filter((l) => l.startsWith('GET /monitor/')).length).toBeGreaterThanOrEqual(4); // polled until completed
        expect(mock.leakedToken()).toBe(false);
      }
    });

    it('a copy of a file that is gone is a clear "not found"', async () => {
      const gone = await d.upload(folderId, 'gone.jpg', Buffer.from('x'), 'image/jpeg');
      await d.remove(gone.id);
      await expect(d.copy(gone.id, people, 'x.jpg')).rejects.toBeInstanceOf(DriveNotFoundError);
    });
  });
}

describe('Graph adapter: upload sessions and copies when Microsoft has trouble', () => {
  let folderId: string;
  const src = path.join(tmp, 'big-trouble.mp4');
  beforeAll(async () => {
    folderId = (await graph.createFolder(null, 'Trouble')).id;
    fs.writeFileSync(src, bigBytes(2));
  });
  const sameBytes = async (id: string) => {
    const back = path.join(tmp, `trouble-back-${id}`);
    await graph.download(id, back);
    return fs.readFileSync(back).equals(fs.readFileSync(src));
  };

  it('sends a chunk again after 503 and 429, and goes on from where the session says it stands', async () => {
    mock.failChunks(2, 503);
    const a = await graph.uploadFile(folderId, 'a.mp4', src, 'video/mp4');
    expect(await sameBytes(a.id)).toBe(true);
    mock.failChunks(1, 429);
    mock.shortChunks(2); // OneDrive took only half of two chunks: nextExpectedRanges points back into them
    const b = await graph.uploadFile(folderId, 'b.mp4', src, 'video/mp4');
    expect(await sameBytes(b.id)).toBe(true);
    expect(mock.leakedToken()).toBe(false);
  });

  it('waits instead of failing when OneDrive keeps refusing chunks, and leaves nothing behind', async () => {
    mock.failChunks(50, 500);
    await expect(graph.uploadFile(folderId, 'c.mp4', src, 'video/mp4')).rejects.toBeInstanceOf(DriveDownError);
    mock.failChunks(0, 500);
    expect((await graph.children(folderId)).map((e) => e.name).sort()).toEqual(['a.mp4', 'b.mp4']);
  });

  it('says so when OneDrive reports that a copy failed', async () => {
    const a = (await graph.children(folderId)).find((e) => e.name === 'a.mp4')!;
    mock.failNextCopy();
    await expect(graph.copy(a.id, folderId, 'copy.mp4')).rejects.toThrow(/could not copy the file: The copy did not finish/);
  });

  it('a lost answer to the last piece of an upload does not send the whole file again', async () => {
    mock.loseLastChunkAnswer();
    const d = await graph.uploadFile(folderId, 'lost-answer.mp4', src, 'video/mp4');
    expect(d.name).toBe('lost-answer.mp4');
    expect((await graph.children(folderId)).map((e) => e.name).filter((n) => n.startsWith('lost-answer'))).toEqual(['lost-answer.mp4']);
    expect(await sameBytes(d.id)).toBe(true);
  });

  it('a copy still running when the app stops waiting is followed on the next try, never started a second time', async () => {
    const a = (await graph.children(folderId)).find((e) => e.name === 'a.mp4')!;
    const target = (await graph.createFolder(folderId, 'Slow copies')).id;
    const names = async () => (await graph.children(target)).map((e) => e.name).sort();

    mock.slowNextCopy(10_000); // OneDrive keeps copying, without saying how far it is
    await expect(quick.copy(a.id, target, 'slow.mp4')).rejects.toBeInstanceOf(DriveDownError);
    await expect(quick.copy(a.id, target, 'slow.mp4')).rejects.toBeInstanceOf(DriveDownError); // still going: no new copy
    mock.finishCopies();
    const made = await quick.copy(a.id, target, 'slow.mp4');
    expect(made.name).toBe('slow.mp4');
    expect(await names()).toEqual(['slow.mp4']);

    // its monitor expired before the next try: the file it made is found by name and size
    mock.slowNextCopy(10_000);
    await expect(quick.copy(a.id, target, 'slow 2.mp4')).rejects.toBeInstanceOf(DriveDownError);
    mock.expireCopyMonitors();
    expect((await quick.copy(a.id, target, 'slow 2.mp4')).name).toBe('slow 2.mp4');
    expect(await names()).toEqual(['slow 2.mp4', 'slow.mp4']);

    // a large copy that keeps moving is waited for, however long it takes
    mock.slowNextCopy(7, true);
    expect((await quick.copy(a.id, target, 'moving.mp4')).name).toBe('moving.mp4');
    expect(await names()).toEqual(['moving.mp4', 'slow 2.mp4', 'slow.mp4']);
  });

  it('a download that fails part-way leaves no part-file behind', async () => {
    const a = (await graph.children(folderId)).find((e) => e.name === 'a.mp4')!;
    const dest = path.join(tmp, 'part-file.mp4');
    mock.breakDownloads(3, 'drop');
    await expect(graph.download(a.id, dest)).rejects.toBeInstanceOf(DriveDownError);
    expect(fs.existsSync(dest)).toBe(false);
    const stop = new AbortController();
    stop.abort();
    await expect(graph.download(a.id, dest, stop.signal)).rejects.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('Graph adapter: the four limits', () => {
  let folderId: string;
  let fileId: string;
  beforeAll(async () => {
    folderId = (await graph.createFolder(null, 'Limits')).id;
    fileId = (await graph.upload(folderId, 'a.jpg', Buffer.from('abc'), 'image/jpeg')).id;
  });

  it('hands out a download link that works without the token, and never sends the token to it', async () => {
    const url = await graph.downloadUrl(fileId);
    expect(url).toMatch(/\/dl\/.+tempauth=/);
    expect(await (await fetch(url!)).text()).toBe('abc');
    await graph.download(fileId, path.join(tmp, 'limits-a'));
    expect(mock.leakedToken()).toBe(false);
  });

  it('gets a fresh token when Microsoft says the old one expired, and keeps the new sign-in', async () => {
    const before = (await db.query(`select refresh_token from connections`)).rows[0].refresh_token;
    const refreshes = mock.refreshCount();
    mock.expireAccessTokens();
    expect((await graph.children(folderId)).map((e) => e.name)).toEqual(['a.jpg']);
    expect(mock.refreshCount()).toBe(refreshes + 1);
    expect((await db.query(`select refresh_token from connections`)).rows[0].refresh_token).not.toBe(before); // replaced on every use
  });

  it('waits and tries again when Microsoft throttles (429 with Retry-After)', async () => {
    mock.throttleNext(2);
    const n = mock.log.length;
    expect((await graph.children(folderId)).length).toBe(1);
    expect(mock.log.length - n).toBe(3); // two refusals, then the answer
  });

  it('tries again when the connection is cut, and waits instead of failing when Microsoft cannot be reached at all', async () => {
    mock.dropNext(2);
    expect((await graph.children(folderId)).length).toBe(1); // two cut connections, then the answer
    mock.dropNext(50);
    await expect(graph.children(folderId)).rejects.toBeInstanceOf(DriveDownError);
    mock.dropNext(0);
  });

  it('tries a broken answer (500, 502) again, and reports it when it stays broken', async () => {
    mock.failNext(2, 502);
    expect((await graph.children(folderId)).length).toBe(1);
    mock.failNext(50, 500);
    await expect(graph.children(folderId)).rejects.toThrow(/OneDrive answered 500/);
    // Microsoft's side, not the file's: the jobs pause and try later instead of giving up on the file
    await expect(graph.children(folderId)).rejects.toBeInstanceOf(DriveDownError);
    mock.failNext(0, 500);
  });

  it('a full OneDrive (507) is told apart, so jobs pause instead of giving up on every file', async () => {
    mock.failNext(1, 507);
    await expect(graph.children(folderId)).rejects.toBeInstanceOf(DriveFullError);
    mock.failNext(0, 507);
  });

  it("a student's download does not wait when Microsoft throttles (patient: false)", async () => {
    mock.throttleNext(1, '30');
    const n = mock.log.length;
    const t = Date.now();
    await expect(graph.readAll(fileId, 1024, undefined, { patient: false })).rejects.toBeInstanceOf(DriveBusyError);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(mock.log.length - n).toBe(1);
    mock.throttleNext(0);
    expect((await graph.readAll(fileId, 1024, undefined, { patient: false })).toString()).toBe('abc');
  });

  it('waits instead of failing when Microsoft keeps throttling', async () => {
    mock.throttleNext(50);
    await expect(graph.children(folderId)).rejects.toBeInstanceOf(DriveDownError);
    mock.throttleNext(0);
  });

  it('asks for a fresh download link when a download breaks half-way', async () => {
    const dest = path.join(tmp, 'limits-b');
    mock.breakDownloads(2, 'drop');
    await graph.download(fileId, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('abc');
    mock.breakDownloads(2, 503);
    await graph.download(fileId, dest);
    mock.breakDownloads(50, 'drop');
    await expect(graph.download(fileId, dest)).rejects.toBeInstanceOf(DriveDownError);
    mock.breakDownloads(0, 'drop');
    expect(mock.leakedToken()).toBe(false);
  });

  it("puts Microsoft's sign-in errors in plain words", async () => {
    const wrongSecret = new GraphDrive(db, { ...baseCfg, ms: { ...baseCfg.ms, clientSecret: 'the-secret-id-by-mistake' } }, 'unused', { retryMs: 10 });
    await expect(wrongSecret.finishSignIn('good-code')).rejects.toThrow(/MS_CLIENT_SECRET must be the secret's Value, not its Secret ID.*AADSTS7000215/);
    expect(plainMicrosoftError('access_denied', 'AADSTS65004: User declined to consent to access the app.')).toMatch(/pressed Cancel.*AADSTS65004/);
    expect(plainMicrosoftError('invalid_request', "AADSTS50011: The redirect URI 'x' specified in the request does not match", 'https://photos.college.test/admin/onedrive/callback')).toContain('add exactly: https://photos.college.test/admin/onedrive/callback');
    expect(plainMicrosoftError('server_error', 'AADSTS99999: Something new.')).toMatch(/^Microsoft sign-in failed\. AADSTS99999/);
  });

  it('passes "Check everything": real files through every call, with paging, a rename and new content', async () => {
    for (const kind of ['graph', 'local'] as const) {
      const before = (await drives[kind].drive().children(null)).length;
      const out = await checkDrive({ drive: drives[kind].drive(), cfg: baseCfg } as any);
      expect(out.steps.filter((x) => !x.ok)).toEqual([]);
      expect(out.ok).toBe(true);
      expect(out.steps.map((x) => x.step)).toEqual([
        'Signed in',
        'The sign-in renews itself',
        'Space',
        'Make a folder',
        'Save three photos',
        'List them, two a page',
        'Download one and compare',
        'A renamed file keeps its identity',
        'New content is noticed',
        'Make the copies folder',
        'A link from a listing opens',
        'Download links allow the browser',
        'Remove the test folder',
      ]);
      expect(out.report).toMatch(/Result: everything the app needs works\./);
      expect((await drives[kind].drive().children(null)).length).toBe(before); // nothing is left behind
    }
    expect(mock.log.some((l) => l.startsWith('PATCH /v1.0/drives/drive1/items/'))).toBe(true);
  });

  it('"Check everything" never removes the real copies folder, nor what jobs write into it meanwhile', async () => {
    for (const kind of ['graph', 'local'] as const) {
      const d = drives[kind].drive();
      expect((await d.children(null)).some((e) => e.name === '_app copies (do not edit)')).toBe(false);
      // the rebuild job keeps its first copy while the check runs (it makes the copies folder for it)
      const realUpload = d.upload.bind(d);
      let written: string | null = null;
      (d as any).upload = async (...a: Parameters<Drive['upload']>) => {
        const out = await realUpload(...a);
        if (a[1] === 'check-link.mp4' && !written) {
          const root = await d.createFolder(null, '_app copies (do not edit)');
          written = (await realUpload(root.id, `job-copy-${kind}.webp`, Buffer.from('copy'), 'image/webp')).id;
        }
        return out;
      };
      try {
        expect((await checkDrive({ drive: d, cfg: baseCfg } as any)).ok).toBe(true);
      } finally {
        (d as any).upload = realUpload;
      }
      expect(written).not.toBeNull();
      const root = (await d.children(null)).find((e) => e.name === '_app copies (do not edit)');
      expect(root).toBeTruthy();
      expect((await d.children(root!.id)).map((e) => e.id)).toEqual([written]);
      await d.remove(root!.id, { permanent: true });
    }
  });

  it('copies in OneDrive: a listing and a lookup carry the download link, and its end is read from the tempauth token', async () => {
    mock.linkLife(3000);
    const listed = (await graph.children(folderId, 999, { urls: true })).find((e) => e.id === fileId)!;
    expect(listed.url).toMatch(/\/dl\/.+tempauth=v1\./);
    expect(Math.abs(listed.urlExpiresAt! - (Date.now() + 3000_000))).toBeLessThan(5000);
    const one = await graph.item(fileId);
    expect(one.url).toMatch(/\/dl\//);
    expect(urlExpiry('https://x/dl/1?tempauth=none', 55, 1000)).toBe(1000 + 55 * 60_000); // no exp: DRIVE_URL_LIFE_MIN
    mock.linkLife(3600);
    await expect(graph.item('no-such-item')).rejects.toBeInstanceOf(DriveNotFoundError);
  });

  it('reads a byte range (206) through a cached link without a Graph call, and a whole copy into memory', async () => {
    const url = (await graph.item(fileId)).url!;
    const before = mock.log.filter((l) => l.startsWith('GET /v1.0')).length;
    const r = await graph.read(fileId, { url, range: 'bytes=1-2' });
    expect(r.status).toBe(206);
    expect(r.contentRange).toBe('bytes 1-2/3');
    expect(Buffer.from(await new Response(r.body).arrayBuffer()).toString()).toBe('bc');
    expect(mock.log.filter((l) => l.startsWith('GET /v1.0')).length).toBe(before); // straight to the link
    expect((await graph.readAll(fileId, 100)).toString()).toBe('abc');
    await expect(graph.readAll(fileId, 2)).rejects.toThrow(/too large/);
    expect(mock.ranges.at(-3)).toBe('bytes=1-2');
    expect(mock.leakedToken()).toBe(false);
  });

  it('a cached link that has run out is replaced by a fresh one once', async () => {
    mock.linkLife(-10);
    const stale = (await graph.item(fileId)).url!;
    mock.linkLife(3600);
    const r = await graph.read(fileId, { url: stale });
    expect(r.status).toBe(200);
    expect(r.staleUrl).toBe(true); // the caller forgets the cached link
    expect(Buffer.from(await new Response(r.body).arrayBuffer()).toString()).toBe('abc');
  });

  it('on a student\'s request (patient: false) a throttled OneDrive answers at once with DriveBusyError and its Retry-After', async () => {
    mock.throttleNext(1, '30');
    const t0 = Date.now();
    const err = await graph.item(fileId, { patient: false }).catch((e) => e);
    expect(err).toBeInstanceOf(DriveBusyError);
    expect(err.retryAfterMs).toBe(30_000);
    expect(Date.now() - t0).toBeLessThan(2000); // no sleeping on the request path
    mock.throttleNext(1, '0');
    expect((await graph.item(fileId)).id).toBe(fileId); // background work still waits and tries again
  });

  it('removes copies for good (permanentDelete), and falls back to a plain delete where that is not offered', async () => {
    const a = await graph.upload(folderId, 'perm-a.webp', Buffer.from('a'), 'image/webp');
    await graph.remove(a.id, { permanent: true });
    expect(mock.log.some((l) => l === `POST /v1.0/drives/drive1/items/${a.id}/permanentDelete`)).toBe(true);
    expect((await graph.children(folderId)).some((e) => e.id === a.id)).toBe(false);
    mock.refusePermanentDelete(405);
    const b = await graph.upload(folderId, 'perm-b.webp', Buffer.from('b'), 'image/webp');
    await graph.remove(b.id, { permanent: true });
    expect(mock.log.some((l) => l === `DELETE /v1.0/drives/drive1/items/${b.id}`)).toBe(true);
    expect((await graph.children(folderId)).some((e) => e.id === b.id)).toBe(false);
    mock.refusePermanentDelete(null);
    await graph.remove(b.id, { permanent: true }); // gone already: done
  });

  it('asks for Reconnect OneDrive when the sign-in was revoked', async () => {
    mock.revokeSignIn();
    mock.expireAccessTokens();
    await expect(graph.children(folderId)).rejects.toBeInstanceOf(DriveAuthError);
    expect(await graph.status()).toMatchObject({ connected: false, needsReconnect: true });
    await expect(graph.children(folderId)).rejects.toBeInstanceOf(DriveAuthError); // stays that way until reconnected
  });
});

describe('a Microsoft 365 that does not open the app folder', () => {
  let m2: MockGraph;
  let d2: GraphDrive;
  let org2: string;
  beforeAll(async () => {
    m2 = await startMockGraph(path.join(tmp, 'graph-root-2'), { pageSize: 2 });
    org2 = (await db.query<{ id: string }>(`insert into orgs (name, slug) values ('T2', 'drive-test-2') returning id`)).rows[0].id;
    d2 = new GraphDrive(db, { ...baseCfg, ms: { ...baseCfg.ms, graphBase: m2.graphBase, loginBase: m2.loginBase } }, org2, { retryMs: 10 });
  });
  afterAll(() => m2.close());

  it('says so, saves nothing, and leaves a working connection alone', async () => {
    m2.refuseAppFolder(403);
    await expect(d2.finishSignIn('good-code')).rejects.toBeInstanceOf(AppFolderRefused);
    await expect(d2.finishSignIn('good-code')).rejects.toThrow(/did not open the app's own folder \(403 accessDenied\)/);
    expect((await db.query(`select 1 from connections where org_id = $1`, [org2])).rows).toHaveLength(0);
    expect((await d2.status()).connected).toBe(false);

    // a connection that works is not replaced by a try that fails
    m2.refuseAppFolder(null);
    await d2.finishSignIn('good-code');
    m2.refuseAppFolder(404);
    await expect(d2.finishSignIn('good-code')).rejects.toBeInstanceOf(AppFolderRefused);
    expect(await d2.status()).toMatchObject({ connected: true, mode: 'approot', rootName: 'Apps > Event Photos' });
    expect((await d2.children(null)).length).toBe(0);
  });

  it('connects with the wider permission instead: a top-level folder named Event Photos, and every later sign-in asks for the same permission', async () => {
    const u = new URL(d2.authUrl('s', 'folder'));
    expect(u.searchParams.get('scope')).toBe('offline_access User.Read Files.ReadWrite');
    expect(new URL(d2.authUrl('s')).searchParams.get('scope')).toBe('offline_access User.Read Files.ReadWrite.AppFolder');

    await d2.finishSignIn('good-code', 'folder');
    const st = await d2.status();
    expect(st).toMatchObject({ connected: true, mode: 'folder', rootName: 'Event Photos' });
    expect(fs.existsSync(path.join(m2.dir, 'Event Photos'))).toBe(true);
    const row = (await db.query(`select scope, root_mode, root_item_id from connections where org_id = $1`, [org2])).rows[0];
    expect(row).toMatchObject({ scope: 'offline_access User.Read Files.ReadWrite', root_mode: 'folder' });
    expect(row.root_item_id).not.toBe('ROOT');

    // files land inside that folder, not next to it
    const f = await d2.createFolder(null, '2026-11-20 Annual Day');
    await d2.upload(f.id, 'a.jpg', Buffer.from('abc'), 'image/jpeg');
    expect(fs.existsSync(path.join(m2.dir, 'Event Photos', '2026-11-20 Annual Day', 'a.jpg'))).toBe(true);

    // connecting again finds the same folder instead of making a second one
    await d2.finishSignIn('good-code', 'folder');
    expect((await db.query(`select root_item_id from connections where org_id = $1`, [org2])).rows[0].root_item_id).toBe(row.root_item_id);

    m2.expireAccessTokens();
    await d2.children(null);
    expect(m2.scopes.at(-1)).toBe('offline_access User.Read Files.ReadWrite'); // the refresh asked for what was granted
    const out = await checkDrive({ drive: d2, cfg: baseCfg } as any);
    expect(out.ok).toBe(true);
    expect(out.steps[0].detail).toContain('the whole OneDrive (wider permission)');
  });
});
