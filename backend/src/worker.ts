import 'dotenv/config';
import pino from 'pino';
import { buildGame } from './bootstrap';
import { ConfigError, loadConfig } from './config/env';
import type { GameService } from './game/service';
import { createPool } from './storage/postgres';
import { loggerOptions } from './telemetry/logger';

/**
 * Background jobs, every WORKER_INTERVAL_SECONDS:
 *   1. lock drafts whose lock time has passed (picks stand as drafted)
 *   2. settle locked predictions once results are in; pay winnings, award analyst XP
 *   3. run weekly payroll (once per agency per ISO week)
 * Every job is idempotent, so overlapping or repeated runs are safe.
 */
export async function runOnce(game: GameService, log: pino.Logger): Promise<void> {
  const jobs: Array<[string, () => Promise<unknown>]> = [
    ['auto-lock', () => game.autoLock()],
    ['settle', () => game.settleDue()],
    ['payroll', () => game.runPayroll()],
  ];
  for (const [name, job] of jobs) {
    try {
      log.info({ job: name, result: await job() }, 'job complete');
    } catch (err) {
      log.error({ job: name, err }, 'job failed');
    }
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError || err instanceof Error ? err.message : 'failed to load configuration');
    process.exit(1);
  }
  const log = pino(loggerOptions(config.logLevel));
  const pool = createPool({ connectionString: config.databaseUrl, max: 3, ssl: config.databaseSsl });
  const game = buildGame(pool, config, log);

  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = async () => {
    await runOnce(game, log);
    if (!stopping) timer = setTimeout(() => void loop(), config.workerIntervalSeconds * 1000);
  };
  const stop = async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  await loop();
}

if (require.main === module) void main();
