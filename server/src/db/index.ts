import knexFactory, { type Knex } from 'knex';
import pg from 'pg';
import type { Config } from '../config.js';
import { migrations } from './migrations.js';

/**
 * The database: PostgreSQL 16 through Knex.
 *
 * New code uses the Knex query builder (`db.knex`). The older SQL of the app is written with PostgreSQL's own
 * numbered parameters ($1, $2 ...); `query` runs it through Knex as well, so every statement shares one pool,
 * one transaction mechanism and one place for logging. Tables are made and changed by Knex migrations
 * (src/db/migrations.ts), run at start.
 */

/** Anything that can run one SQL statement: the database itself, or a transaction on it. */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  /** The Knex builder bound to the same connection (inside a transaction: the transaction). */
  knex: Knex | Knex.Transaction;
}

export interface Db extends Queryable {
  knex: Knex;
  /** Run a script of several statements, without parameters. */
  exec(sql: string): Promise<void>;
  /** Run fn inside one transaction; it is rolled back if fn throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Dates without a time ('2026-11-20') stay strings: a JavaScript Date would move them by the time zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
// Counts and sums come back as numbers (they are far below 2^53).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

/** $1, $2 ... become Knex's ? bindings (a parameter used twice is bound twice). A literal ? is escaped. */
export function toKnexSql(sql: string, params: unknown[] = []): [string, unknown[]] {
  const bindings: unknown[] = [];
  const text = sql.replace(/\?/g, '\\?').replace(/\$(\d+)/g, (_m, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new Error(`SQL parameter $${n} has no value`);
    bindings.push(params[i] === undefined ? null : params[i]);
    return '?';
  });
  return [text, bindings];
}

function queryable(k: Knex | Knex.Transaction): Queryable {
  return {
    knex: k,
    async query(sql, params) {
      const [text, bindings] = toKnexSql(sql, params);
      const r: pg.QueryResult = await k.raw(text, bindings as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
  };
}

export interface OpenOptions {
  /** A schema of its own (tests: one per test file, dropped at close). Default: public. */
  schema?: string;
  dropSchemaOnClose?: boolean;
}

/** Open the database named in the config and bring its tables up to date. */
export async function openDb(cfg: Pick<Config, 'databaseUrl'>, opts: OpenOptions = {}): Promise<Db> {
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set. Event Photos needs PostgreSQL 16, e.g. postgres://localhost:5432/event_photos');
  const schema = opts.schema;
  if (schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Bad schema name ${schema}`);
  const knex = knexFactory({
    client: 'pg',
    connection: cfg.databaseUrl,
    pool: {
      min: 0,
      max: 10,
      // Every connection of a test file works in that file's own schema.
      ...(schema ? { afterCreate: (conn: any, done: (e: Error | null, c: any) => void) => conn.query(`set search_path to "${schema}", public`, (e: Error | null) => done(e, conn)) } : {}),
    },
    searchPath: schema ? [schema, 'public'] : undefined,
  });
  try {
    await knex.raw('select 1');
  } catch (e) {
    await knex.destroy();
    throw new Error(`Cannot reach PostgreSQL at ${redact(cfg.databaseUrl)}: ${(e as Error).message}`);
  }
  if (schema) await knex.raw(`create schema if not exists "${schema}"`);
  await knex.migrate.latest({ migrationSource: migrations, schemaName: schema, tableName: 'knex_migrations' });

  const db: Db = {
    ...(queryable(knex) as Queryable & { knex: Knex }),
    async exec(sql) {
      // Several statements at once need the simple protocol: straight on one pooled connection.
      const conn = await knex.client.acquireConnection();
      try {
        await conn.query(sql);
      } finally {
        await knex.client.releaseConnection(conn);
      }
    },
    tx: (fn) => knex.transaction((trx) => fn(queryable(trx))),
    async close() {
      if (schema && opts.dropSchemaOnClose) await knex.raw(`drop schema if exists "${schema}" cascade`).catch(() => {});
      await knex.destroy();
    },
  };
  return db;
}

const redact = (url: string) => url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');

/** bytea comes back as a Buffer from pg; kept for callers that also accept Uint8Array. */
export const toBuffer = (v: Uint8Array | Buffer | null | undefined): Buffer | null =>
  v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
