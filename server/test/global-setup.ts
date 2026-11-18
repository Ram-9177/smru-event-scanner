import pg from 'pg';
import { TEST_DATABASE_URL } from './helpers/db.js';

/** Make the test database once (each test file then works in its own schema in it). */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const name = decodeURIComponent(url.pathname.slice(1));
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.href });
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`The tests need PostgreSQL 16 at ${url.host} (TEST_DATABASE_URL): ${(e as Error).message}`);
  }
  try {
    const has = await c.query('select 1 from pg_database where datname = $1', [name]);
    if (!has.rowCount) await c.query(`create database "${name.replace(/"/g, '""')}"`);
  } finally {
    await c.end();
  }
}
