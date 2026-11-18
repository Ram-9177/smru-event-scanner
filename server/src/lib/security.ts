import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

/** Security helpers: passwords (bcrypt), image-link signatures, encryption at rest. Sign-in tokens are JWTs: lib/jwt.ts. */

const b64u = (b: Buffer) => b.toString('base64url');

export function randomToken(bytes = 32): string {
  return b64u(crypto.randomBytes(bytes));
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ---- passwords: bcrypt ------------------------------------------------------
// Older accounts (and album passcodes) were saved with scrypt; they still sign in, and are saved again with
// bcrypt the next time the password is checked (see needsRehash).
const BCRYPT_COST = 12;
/** bcrypt reads at most 72 bytes of a password. */
export const PASSWORD_MAX_BYTES = 72;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith('$2')) return bcrypt.compare(password, stored);
  const [kind, n, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !n || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), want.length, { N: Number(n) });
  return crypto.timingSafeEqual(want, got);
}

/** A bcrypt hash of a random password nobody knows, made once on first use (not at start, which would slow every start). */
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= bcrypt.hash(randomToken(), BCRYPT_COST));

/**
 * Check a password for an account that may not exist. With no account (`stored` undefined) a real bcrypt check
 * still runs, against a hash nobody knows, and the answer is false. So "no such account" takes as long as
 * "wrong password", and the time an answer takes does not tell who has an account.
 */
export async function checkPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    await bcrypt.compare(password, await dummy());
    return false;
  }
  return verifyPassword(password, stored);
}

/** A hash from before bcrypt, or with a lower cost than today's: save it again after a right password. */
export const needsRehash = (stored: string) => !stored.startsWith('$2') || bcrypt.getRounds(stored) < BCRYPT_COST;

/** A short signature for image links: /img/<id>/<size>?exp=..&sig=.. */
export function signLink(parts: (string | number)[], secret: string): string {
  return b64u(crypto.createHmac('sha256', secret).update(parts.join('|')).digest().subarray(0, 16));
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- encryption at rest (the stored Microsoft sign-in) ----------------------
const keyFrom = (secret: string) => crypto.createHash('sha256').update(`event-photos:token-key:${secret}`).digest();

export function encrypt(text: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `v1.${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(data)}`;
}

export function decrypt(stored: string, secret: string): string {
  const [v, iv, tag, data] = stored.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable stored secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
