import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  const sql = await readFile(path.join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Run directly: `npm run db:migrate`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runMigrations();
    console.log('Database schema is up to date.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
