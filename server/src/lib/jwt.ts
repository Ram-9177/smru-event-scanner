import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';

/**
 * Sign-in tokens are JWTs signed with RS256. The private key signs; anything holding the public key can check a
 * token without being able to make one. Keys come from JWT_PRIVATE_KEY / JWT_PUBLIC_KEY, or are made once and
 * kept in the data folder (readable by this user only).
 */
export interface JwtKeys {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  /** Key id: a short hash of the public key, so a key change is visible in the token header. */
  kid: string;
  issuer: string;
}

export function loadJwtKeys(cfg: Pick<Config, 'jwtPrivateKey' | 'jwtPublicKey' | 'dataDir' | 'publicUrl'>): JwtKeys {
  let pem = cfg.jwtPrivateKey;
  if (!pem) {
    const file = path.join(cfg.dataDir, 'jwt-rs256.pem');
    if (!fs.existsSync(file)) {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    pem = fs.readFileSync(file, 'utf8');
  }
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('JWT_PRIVATE_KEY must be an RSA key (RS256).');
  const publicKey = cfg.jwtPublicKey ? crypto.createPublicKey(cfg.jwtPublicKey) : crypto.createPublicKey(privateKey);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, publicKey, kid: crypto.createHash('sha256').update(der).digest('base64url').slice(0, 16), issuer: cfg.publicUrl };
}

export interface SignOptions {
  /** What the token is for: 'admin', 'onedrive-state', 'zip' ... A token for one purpose is refused for another. */
  audience: string;
  ttlSeconds: number;
  subject?: string;
  /** A unique id, so one token can be revoked (sign out). Made when not given. */
  jwtid?: string;
}

export function signJwt(keys: JwtKeys, payload: Record<string, unknown>, o: SignOptions): string {
  return jwt.sign(payload, keys.privateKey, {
    algorithm: 'RS256',
    keyid: keys.kid,
    issuer: keys.issuer,
    audience: o.audience,
    expiresIn: o.ttlSeconds,
    ...(o.subject ? { subject: o.subject } : {}),
    jwtid: o.jwtid ?? crypto.randomUUID(),
  });
}

export type Verified<T> = T & { sub?: string; jti: string; exp: number; iat: number };

/** The token's claims, or null when it is missing, forged, expired, or made for another purpose. Only RS256 is accepted. */
export function verifyJwt<T extends object = Record<string, unknown>>(keys: JwtKeys, token: string | undefined | null, audience: string): Verified<T> | null {
  if (!token) return null;
  try {
    const out = jwt.verify(token, keys.publicKey, { algorithms: ['RS256'], issuer: keys.issuer, audience });
    return typeof out === 'string' ? null : (out as Verified<T>);
  } catch {
    return null;
  }
}
