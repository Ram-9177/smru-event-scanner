/** Bring the database's tables up to date (the server also does this when it starts):  npm run db:migrate -w server */
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';

try {
  process.loadEnvFile?.('.env');
} catch {
  /* no .env file: use the environment as it is */
}
const cfg = loadConfig();
const db = await openDb(cfg);
const done = await db.knex('knex_migrations').select('name').orderBy('id');
console.log(`Database up to date: ${done.map((m) => m.name).join(', ')}`);
await db.close();
