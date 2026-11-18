import crypto from 'node:crypto';
import { openDb, type Db } from '../../src/db/index.js';

/** PostgreSQL 16 for the tests. Every test file works in a schema of its own, dropped when it closes. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/event_photos_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export const testId = () => crypto.randomBytes(5).toString('hex');

export function openTestDb(id: string): Promise<Db> {
  return openDb({ databaseUrl: TEST_DATABASE_URL }, { schema: `t_${id}`, dropSchemaOnClose: true });
}
