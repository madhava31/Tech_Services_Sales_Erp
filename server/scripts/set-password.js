// Set a user's password from the terminal — for local development, or when nobody can sign in.
//
//   npm run user:set-password -- <username>
//
// Prompts for the new password (not echoed). Works only against a local database (DATABASE_URL
// in .env); production passwords are reset from Admin → Users. Signs the user out everywhere,
// clears their failed sign-in attempts, and writes an audit-log entry.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { hashPassword, isAcceptablePassword, PASSWORD_RULE } from '../auth/password.js';
import { createClient, isLocalDatabaseUrl } from '../db/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// One reader for every prompt, with typed lines queued: piped input can arrive (and end) before
// a prompt is shown, and reopening stdin between prompts hangs.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
// Echo nothing while the password is typed.
rl._writeToOutput = () => {};
const lines = [];
const waiting = [];
rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
rl.on('close', () => waiting.splice(0).forEach((resolve) => resolve(null)));

function askHidden(question) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const done = (answer) => {
      process.stdout.write('\n');
      resolve(answer ?? '');
    };
    if (lines.length) done(lines.shift());
    else waiting.push(done);
  });
}

async function main() {
  const username = process.argv[2];
  if (!username) throw new Error('Usage: npm run user:set-password -- <username>');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (.env).');
  if (!isLocalDatabaseUrl(url)) throw new Error('Refusing: this only works on a local database. Use Admin → Users → Reset password.');

  const client = createClient(url);
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT id, is_active FROM app_user WHERE username = $1`, [username]);
    if (!rows.length) throw new Error(`No user "${username}".`);

    const password = await askHidden('New password: ');
    if (!isAcceptablePassword(password)) throw new Error(PASSWORD_RULE);
    if ((await askHidden('Repeat it: ')) !== password) throw new Error('The passwords did not match.');

    const { salt, hash } = hashPassword(password);
    await client.query('BEGIN');
    await client.query(`UPDATE app_user SET password_hash = $1, password_salt = $2 WHERE id = $3`, [hash, salt, rows[0].id]);
    await client.query(`DELETE FROM session WHERE user_id = $1`, [rows[0].id]);
    await client.query(`DELETE FROM login_attempt WHERE username = $1 AND NOT succeeded`, [username.toLowerCase()]);
    await client.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, summary)
       VALUES (NULL, 'user.password_reset', 'app_user', $1, $2)`,
      [rows[0].id, `Reset password for "${username}" from the command line`]
    );
    await client.query('COMMIT');
    console.log(`Password set for ${username}.${rows[0].is_active ? '' : ' Note: this account is deactivated.'}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    rl.close();
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  rl.close();
  process.exit(1);
});
