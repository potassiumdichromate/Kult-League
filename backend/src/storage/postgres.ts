import { Pool } from 'pg';

export type PgSslMode = 'verify' | 'no-verify' | 'disable';

export interface PgOptions {
  connectionString: string;
  max: number;
  ssl: PgSslMode;
}

function sslOption(mode: PgSslMode): false | { rejectUnauthorized: boolean } {
  switch (mode) {
    case 'verify':
      return { rejectUnauthorized: true };
    case 'no-verify':
      // Encrypted but unauthenticated — must be chosen explicitly, never a default.
      return { rejectUnauthorized: false };
    case 'disable':
      // Only for Render's internal (private-network) URL or local/CI containers.
      return false;
  }
}

export function createPool(opts: PgOptions): Pool {
  return new Pool({
    connectionString: opts.connectionString,
    max: opts.max,
    ssl: sslOption(opts.ssl),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: 'pixel-agency',
  });
}
