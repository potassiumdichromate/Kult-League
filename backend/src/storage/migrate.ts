import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

/**
 * Forward-only SQL migrations from ./migrations, applied in filename order.
 * - Serialised with an advisory lock (safe if two deploys overlap).
 * - Each file runs in its own transaction.
 * - An applied file whose contents changed aborts the run: history is
 *   never rewritten silently; add a new migration instead.
 */

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');
const LOCK_KEY = 7_302_114_612; // arbitrary, stable

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query('CREATE SCHEMA IF NOT EXISTS pixel_agency');
    await client.query(`
      CREATE TABLE IF NOT EXISTS pixel_agency.schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM pixel_agency.schema_migrations');
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = applied.get(file);
      if (prior !== undefined) {
        if (prior !== checksum) throw new Error(`migration ${file} was modified after being applied`);
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO pixel_agency.schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

// `node dist/storage/migrate.js` — used as Render's preDeployCommand.
if (require.main === module) {
  void (async () => {
    // Reads only what it needs — the migrator must not require the service's
    // other secrets (SESSION_SECRET, AI_INFRA_SECRET) to run.
    const { createPool } = await import('./postgres');
    const databaseUrl = process.env.DATABASE_URL;
    const ssl = (process.env.DATABASE_SSL ?? 'verify') as 'verify' | 'no-verify' | 'disable';
    if (!databaseUrl) {
      console.error(JSON.stringify({ msg: 'migrations failed', error: 'DATABASE_URL is not set' }));
      process.exit(1);
    }
    if (!['verify', 'no-verify', 'disable'].includes(ssl)) {
      console.error(JSON.stringify({ msg: 'migrations failed', error: 'DATABASE_SSL must be verify, no-verify or disable' }));
      process.exit(1);
    }
    const pool = createPool({ connectionString: databaseUrl, max: 1, ssl });
    try {
      const res = await migrate(pool);
      console.log(JSON.stringify({ msg: 'migrations complete', ...res }));
    } catch (err) {
      console.error(JSON.stringify({ msg: 'migrations failed', error: (err as Error).message }));
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
