import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { openDb, type Db } from './db/index.js';
import { createDrive, LocalDrive, type Drive } from './drive/index.js';
import type { Redis } from 'ioredis';
import { defaultFace } from './face/engine.js';
import type { FaceEngine } from './face/index.js';
import { loadJwtKeys, type JwtKeys } from './lib/jwt.js';
import { createMailer, type Mailer } from './lib/mail.js';
import { slugify } from './lib/http.js';
import { KeyedLock, Queue } from './lib/queue.js';
import { checkRedis, createRedis } from './lib/redis.js';
import { hashPassword, randomToken } from './lib/security.js';

/** Everything a request or a job needs, built once at start-up. */
export interface Ctx {
  cfg: Config;
  db: Db;
  drive: Drive;
  face: FaceEngine;
  /** Short-lived shared state: sign-in limits, signed-out tokens, one-time links. */
  redis: Redis;
  /** RS256 keys for the sign-in tokens. */
  jwt: JwtKeys;
  mailer: Mailer;
  orgId: string;
  /** Photo processing, a few at a time. */
  work: Queue;
  /** One duplicate decision at a time per event. */
  eventLock: KeyedLock;
  /** Call after anything that changes what students can see in an event. */
  bump(eventId: string): void;
  version(eventId: string): number;
  /** Events whose sync is running right now. */
  syncing: Set<string>;
  log(msg: string, extra?: unknown): void;
  /** Stop: wait for photo work, then close the face workers, Redis and the database. */
  close(): Promise<void>;
}

export interface ContextOptions {
  db?: Db;
  drive?: Drive;
  face?: FaceEngine;
  redis?: Redis;
  mailer?: Mailer;
  quiet?: boolean;
}

export async function createContext(cfg: Config, opts: ContextOptions = {}): Promise<Ctx> {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  if (!cfg.sessionSecret) {
    // Development only: production refuses to start without SESSION_SECRET (see config).
    const file = path.join(cfg.dataDir, 'dev-secret');
    if (!fs.existsSync(file)) fs.writeFileSync(file, randomToken(48), { mode: 0o600 });
    cfg.sessionSecret = fs.readFileSync(file, 'utf8').trim();
  }
  const log = (msg: string, extra?: unknown) => {
    if (opts.quiet) return;
    if (extra !== undefined) console.log(`[event-photos] ${msg}`, extra);
    else console.log(`[event-photos] ${msg}`);
  };
  const jwt = loadJwtKeys(cfg);
  const redis = opts.redis ?? createRedis(cfg);
  await checkRedis(redis, cfg.redisUrl);
  const db = opts.db ?? (await openDb(cfg));

  // One organisation for now; the tables already allow more.
  let org = (await db.query<{ id: string }>(`select id from orgs order by created_at limit 1`)).rows[0];
  if (!org) {
    org = (await db.query<{ id: string }>(`insert into orgs (name, slug) values ($1, 'main') returning id`, [cfg.orgName])).rows[0];
  }
  // The campuses, once: afterwards they are changed in Settings.
  if (!(await db.knex('campuses').where({ org_id: org.id }).first())) {
    const rows = cfg.campuses.map((name, i) => ({ org_id: org.id, name, slug: slugify(name), sort: i }));
    if (rows.length) await db.knex('campuses').insert(rows).onConflict(['org_id', 'slug']).ignore();
  }
  if (cfg.adminEmail && cfg.adminPassword) {
    const users = (await db.query<{ n: number }>(`select count(*)::int as n from users`)).rows[0].n;
    if (users === 0) {
      await db.query(`insert into users (org_id, email, password_hash, role) values ($1, $2, $3, 'super_admin')`, [
        org.id,
        cfg.adminEmail,
        await hashPassword(cfg.adminPassword),
      ]);
    }
  }

  const versions = new Map<string, number>();
  const face = opts.face ?? (await defaultFace(cfg));
  const work = new Queue(cfg.workers);
  const drive = opts.drive ?? createDrive(cfg, db, org.id);
  // The stand-in drive's links (/_drive) are signed with the session secret, like the image links.
  if (drive instanceof LocalDrive && !drive.hasSigner()) drive.useSigner(cfg.sessionSecret);
  return {
    cfg,
    db,
    drive,
    face,
    redis,
    jwt,
    mailer: opts.mailer ?? createMailer(cfg, log),
    orgId: org.id,
    work,
    eventLock: new KeyedLock(),
    bump: (eventId) => void versions.set(eventId, (versions.get(eventId) ?? 0) + 1),
    version: (eventId) => versions.get(eventId) ?? 0,
    syncing: new Set(),
    log,
    async close() {
      await work.idle();
      await (face as FaceEngine & { close?: () => Promise<void> }).close?.();
      if (!opts.redis) redis.disconnect();
      if (!opts.db) await db.close();
    },
  };
}

export async function audit(ctx: Ctx, actor: string, action: string, target?: string | null, detail?: unknown): Promise<void> {
  await ctx.db.query(`insert into audit_log (actor, action, target, detail) values ($1, $2, $3, $4::jsonb)`, [
    actor,
    action,
    target ?? null,
    detail === undefined ? null : JSON.stringify(detail),
  ]);
}
