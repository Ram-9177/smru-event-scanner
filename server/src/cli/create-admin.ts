/** Create an organiser, or reset a password:  npm run admin:create -w server -- you@college.edu "a long password" */
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import { hashPassword } from '../lib/security.js';

try {
  process.loadEnvFile?.('.env');
} catch {
  /* fine */
}
const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error('Usage: npm run admin:create -w server -- <email> <password of at least 10 characters>');
  process.exit(1);
}
const ctx = await createContext(loadConfig(), { quiet: true });
await ctx.db.query(
  `insert into users (org_id, email, password_hash, role) values ($1, $2, $3, 'super_admin')
   on conflict (email) do update set password_hash = excluded.password_hash`,
  [ctx.orgId, email.trim().toLowerCase(), await hashPassword(password)],
);
console.log(`Saved the sign-in for ${email}.`);
await ctx.close();
