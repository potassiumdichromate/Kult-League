import 'dotenv/config';
import pino from 'pino';
import { buildApp } from './app';
import { buildGame } from './bootstrap';
import { ConfigError, loadConfig } from './config/env';
import { createPool } from './storage/postgres';
import { loggerOptions } from './telemetry/logger';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Variable names only — config errors never include values.
    console.error(err instanceof ConfigError || err instanceof Error ? err.message : 'failed to load configuration');
    process.exit(1);
  }
  const log = pino(loggerOptions(config.logLevel));
  const pool = createPool({ connectionString: config.databaseUrl, max: config.databasePoolMax, ssl: config.databaseSsl });
  const app = await buildApp({ config, game: buildGame(pool, config, log), ready: async () => void (await pool.query('SELECT 1')) });
  if (config.corsOrigins.length === 0) app.log.warn('CORS_ORIGINS is empty — browsers cannot call this API');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), config.shutdownGraceMs);
    force.unref();
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled rejection'));

  await app.listen({ host: config.host, port: config.port });
}

void main();
