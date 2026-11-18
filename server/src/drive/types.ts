/** One file or folder in the drive. Ids are opaque: never build one by hand. */
export interface DriveEntry {
  id: string;
  name: string;
  isFolder: boolean;
  size: number;
  /** Changes only when the file's content changes. */
  ctag: string;
  mime: string | null;
  modifiedAt: Date | null;
  /** When the picture was taken, if the drive knows. */
  takenAt: Date | null;
  /** A short-lived pre-authenticated link to the bytes, when the listing or lookup gave one (children with urls, item). */
  url?: string | null;
  /** When `url` stops working (ms since 1970). */
  urlExpiresAt?: number | null;
}

/** What read() gives: the bytes (or a byte range) as a stream, never written to this server's disk. */
export interface DriveRead {
  status: 200 | 206;
  size: number | null;
  contentRange: string | null;
  mime: string | null;
  body: ReadableStream<Uint8Array>;
  /** The link given (a cached one) no longer worked and a fresh one was used: the caller forgets the cached one. */
  staleUrl?: boolean;
}

export interface DriveStatus {
  kind: 'local' | 'graph';
  connected: boolean;
  needsReconnect: boolean;
  account: string | null;
  rootName: string | null;
  quota: { total: number; used: number; remaining: number } | null;
  /** OneDrive only: 'approot' = the app can reach only its own folder; 'folder' = the wider permission, with a folder named Event Photos. */
  mode?: 'approot' | 'folder' | null;
}

/**
 * The storage behind the app. Two implementations:
 *   graph - OneDrive through Microsoft Graph (production)
 *   local - a folder on this machine that behaves the same way (development, tests, demo)
 */
export interface Drive {
  kind: 'local' | 'graph';
  status(): Promise<DriveStatus>;
  /**
   * Files and folders directly inside a folder. null = the app's own root folder (Event Photos). pageSize: items per
   * page (the connection check uses 2, the copies folders 999). urls: each file also gets its pre-authenticated
   * download link. patient false: a busy OneDrive (429/503) throws DriveBusyError at once instead of waiting.
   */
  children(folderId: string | null, pageSize?: number, opts?: { urls?: boolean; patient?: boolean }): Promise<DriveEntry[]>;
  /** One item, with its pre-authenticated download link. */
  item(itemId: string, opts?: { patient?: boolean }): Promise<DriveEntry>;
  /** The bytes, or a byte range ("bytes=0-99"), as a stream: through `url` when given (no Graph call), else through a fresh link. */
  /** patient false (a student's request is waiting): a busy OneDrive (429/503) throws DriveBusyError at once instead of waiting. */
  read(itemId: string, opts?: { url?: string | null; range?: string | null; signal?: AbortSignal; patient?: boolean }): Promise<DriveRead>;
  /** read() into memory, refusing a file larger than maxBytes (photos handed over, scene descriptions). */
  readAll(itemId: string, maxBytes: number, signal?: AbortSignal, opts?: { patient?: boolean }): Promise<Buffer>;
  /**
   * The file's bytes into destPath. `signal` stops it (the person who asked went away): the part written is removed.
   * A download that fails for any reason never leaves a part-file behind.
   */
  download(itemId: string, destPath: string, signal?: AbortSignal, opts?: { patient?: boolean }): Promise<void>;
  /** A short-lived link the attendee's phone can open directly, or null if the drive has none. */
  downloadUrl(itemId: string): Promise<string | null>;
  /** Creates the folder, or returns the one that is already there. */
  createFolder(parentId: string | null, name: string): Promise<DriveEntry>;
  /** A small file held in memory (a photo). Large files (videos) go through uploadFile. */
  upload(parentId: string | null, name: string, data: Buffer, mime: string): Promise<DriveEntry>;
  /**
   * A file of any size from disk (a video), never held in memory whole: OneDrive takes it in 10 MiB pieces
   * (an upload session). A name that is already taken gets a number added. Returns the saved item.
   */
  uploadFile(parentId: string | null, name: string, filePath: string, mime: string): Promise<DriveEntry>;
  /**
   * A copy of a file (or folder) made by the drive itself, without the bytes passing through this server.
   * A name that is already taken in the target folder gets a number added ("name 1.jpg"). Returns the new item.
   */
  copy(itemId: string, parentId: string | null, name: string): Promise<DriveEntry>;
  /** Removes the item (a folder with everything in it). permanent: not into the recycle bin, where it would count against the quota. */
  remove(itemId: string, opts?: { permanent?: boolean }): Promise<void>;
  // The next three are used only by the connection check ("Check everything").
  rename(itemId: string, name: string): Promise<DriveEntry>;
  /** New content for a file that is already there; its id stays. */
  replace(itemId: string, data: Buffer, mime: string): Promise<DriveEntry>;
  /** Proves the stored sign-in still works without a person. Nothing to do for a local folder. */
  renew(): Promise<void>;
}

/** The drive needs the organiser to sign in again (Connect OneDrive). */
export class DriveAuthError extends Error {
  constructor(message = 'OneDrive needs to be connected again.') {
    super(message);
    this.name = 'DriveAuthError';
  }
}

/**
 * Microsoft cannot be reached, or is limiting requests. Nothing is wrong with the file:
 * the work waits and the next sync carries on.
 */
export class DriveDownError extends Error {
  constructor(message = 'OneDrive cannot be reached right now. The next sync carries on from here.') {
    super(message);
    this.name = 'DriveDownError';
  }
}

/** The app-folder permission did not work for this Microsoft 365. The wider permission is the way on. */
export class AppFolderRefused extends Error {
  constructor(detail: string) {
    super(`Your Microsoft 365 did not open the app's own folder (${detail}).`);
    this.name = 'AppFolderRefused';
  }
}

/** The sign-in was for a different Microsoft account than the one the event folders belong to. */
export class WrongAccount extends Error {
  constructor(
    public signedIn: string,
    public expected: string,
  ) {
    super(`You signed in as ${signedIn}, but the event folders are in the OneDrive of ${expected}. Sign in as ${expected}.`);
    this.name = 'WrongAccount';
  }
}

/** OneDrive is limiting requests (429/503) and the caller asked not to wait (a student's request is waiting). */
export class DriveBusyError extends Error {
  constructor(public retryAfterMs: number) {
    super('OneDrive is limiting requests right now.');
    this.name = 'DriveBusyError';
  }
}

/** OneDrive is full (507): nothing more can be written until space is freed. Nothing is wrong with the file. */
export class DriveFullError extends Error {
  constructor(message = 'OneDrive is full. Free some space or ask the admin for a higher limit.') {
    super(message);
    this.name = 'DriveFullError';
  }
}

/** A file larger than the caller would hold in memory (readAll). */
export class DriveTooLargeError extends Error {
  constructor(public size: number) {
    super('The file is too large to be read into memory.');
    this.name = 'DriveTooLargeError';
  }
}

/**
 * When a pre-authenticated link stops working: from the exp of its tempauth token when there is one (SharePoint
 * links carry it), else lifeMin minutes from now.
 */
export function urlExpiry(url: string, lifeMin = 55, now = Date.now()): number {
  try {
    const t = new URL(url, 'http://x').searchParams.get('tempauth');
    if (t) {
      const parts = t.split('.');
      // "v1.<payload>.<sig>" or a plain JWT "<head>.<payload>.<sig>": the payload is the part that decodes to JSON with exp.
      for (const p of parts) {
        try {
          const j = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
          if (j && typeof j.exp === 'number') return j.exp * 1000;
        } catch {
          /* not this part */
        }
      }
    }
  } catch {
    /* not a URL we can read */
  }
  return now + lifeMin * 60_000;
}

/** Read a web stream into one Buffer, refusing more than maxBytes. */
export async function streamToBuffer(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new DriveTooLargeError(n);
      }
      parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts, n);
}

export class DriveNotFoundError extends Error {
  constructor(message = 'The file is no longer in the drive.') {
    super(message);
    this.name = 'DriveNotFoundError';
  }
}

export interface TreeFile extends DriveEntry {
  folderId: string;
  /** null = directly in the event folder; otherwise the subfolder's name (an album section). */
  folderName: string | null;
}

/** An event folder and its subfolders one level down, as the sync job reads them. */
export async function listTree(drive: Drive, folderId: string): Promise<{ files: TreeFile[]; folders: DriveEntry[] }> {
  const top = await drive.children(folderId);
  const files: TreeFile[] = top.filter((e) => !e.isFolder).map((e) => ({ ...e, folderId, folderName: null }));
  const folders = top.filter((e) => e.isFolder);
  for (const f of folders) {
    for (const e of await drive.children(f.id)) {
      if (!e.isFolder) files.push({ ...e, folderId: f.id, folderName: f.name });
    }
  }
  return { files, folders };
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp',
  '.txt': 'text/plain',
};

export function mimeFromName(name: string): string | null {
  const i = name.lastIndexOf('.');
  return i < 0 ? null : (MIME[name.slice(i).toLowerCase()] ?? null);
}
