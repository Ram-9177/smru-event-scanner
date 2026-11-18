import { Redis } from 'ioredis';
import type { Config } from '../config.js';

/**
 * Redis keeps what is short-lived and shared between server processes: failed sign-in counters, signed-out
 * tokens, one-time links (password reset, Microsoft sign-in) and the students' passcode tries.
 */
export function createRedis(cfg: Pick<Config, 'redisUrl' | 'redisPrefix'>): Redis {
  return new Redis(cfg.redisUrl, {
    keyPrefix: cfg.redisPrefix,
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
  });
}

/** Wait until Redis answers, with a plain message when it does not. */
export async function checkRedis(redis: Redis, url: string): Promise<void> {
  try {
    await Promise.race([redis.ping(), new Promise((_r, no) => setTimeout(() => no(new Error('no answer in 5 seconds')), 5000))]);
  } catch (e) {
    throw new Error(`Cannot reach Redis at ${url.replace(/\/\/[^@]*@/, '//***@')}: ${(e as Error).message}`);
  }
}

/**
 * Counts tries of one kind per key in a window. After `limit` tries the key waits until the window ends.
 *
 * `allow` counts the try first and only then says whether it may go ahead, in one Redis round trip
 * (SET NX EX + INCR in MULTI). So many tries sent at the same moment cannot all read "under the limit" before
 * any of them is counted, and counting is right even with several server processes.
 */
export class Limiter {
  constructor(
    private redis: Redis,
    private name: string,
    private limit: number,
    private windowSeconds: number,
  ) {}

  private key = (k: string) => `limit:${this.name}:${k}`;

  /** Count one try now. True when it may go ahead (it is within the limit), false when the key has to wait. */
  async allow(k: string): Promise<boolean> {
    return (await this.count(k)) <= this.limit;
  }

  /**
   * Take back one try counted by `allow` (for example a right password), without forgetting the others.
   * Does nothing when the window has already ended.
   */
  async giveBack(k: string): Promise<void> {
    await this.redis.eval(`local n = tonumber(redis.call('GET', KEYS[1])) if n and n > 0 then return redis.call('DECR', KEYS[1]) end return 0`, 1, this.key(k));
  }

  /** True when the key is waiting. Only a look: use `allow` to check and count in one step. */
  async blocked(k: string): Promise<boolean> {
    return Number((await this.redis.get(this.key(k))) ?? 0) >= this.limit;
  }

  /** Count a failure (without asking whether it may go ahead). */
  async fail(k: string): Promise<void> {
    await this.count(k);
  }

  async clear(k: string): Promise<void> {
    await this.redis.del(this.key(k));
  }

  /** INCR, with the window started by the same MULTI when the key is new, so a key never stays without an expiry. */
  private async count(k: string): Promise<number> {
    const key = this.key(k);
    const out = await this.redis.multi().set(key, 0, 'EX', this.windowSeconds, 'NX').incr(key).exec();
    const [err, n] = out?.[1] ?? [new Error('Redis did not run the count'), 0];
    if (err) throw err;
    return Number(n);
  }
}

/** Delete every key under this client's prefix (tests). */
export async function dropPrefix(redis: Redis, prefix: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    // keys come back with the prefix; the client adds it again, so strip it.
    if (keys.length) await redis.del(...keys.map((k) => k.slice(prefix.length)));
  } while (cursor !== '0');
}
