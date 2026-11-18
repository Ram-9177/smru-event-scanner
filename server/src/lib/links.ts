import type { Config } from '../config.js';
import { signLink } from './security.js';

/** t = thumbnail, w = web copy (a video's poster for both), v = a video's playable preview MP4. */
type Size = 't' | 'w' | 'v';

/**
 * Image links are signed and expire. The expiry is rounded to a half-hour step,
 * so the same photo keeps the same address for a while and the phone can cache it.
 */
export function imageUrl(cfg: Pick<Config, 'sessionSecret' | 'imageLinkMinutes'>, mediaId: string, size: Size, admin = false): string {
  const step = 30 * 60;
  const exp = Math.ceil((Date.now() / 1000 + cfg.imageLinkMinutes * 60) / step) * step;
  const sig = signLink([mediaId, size, exp, admin ? 'admin' : 'guest'], cfg.sessionSecret);
  return `/img/${mediaId}/${size}?e=${exp}&s=${sig}${admin ? '&a=1' : ''}`;
}

export function checkImageLink(cfg: Pick<Config, 'sessionSecret'>, mediaId: string, size: string, exp: string, sig: string, admin: boolean): boolean {
  if (size !== 't' && size !== 'w' && size !== 'v') return false;
  const e = Number(exp);
  if (!e || e < Date.now() / 1000) return false;
  return signLink([mediaId, size, e, admin ? 'admin' : 'guest'], cfg.sessionSecret) === sig;
}
