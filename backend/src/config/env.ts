import { z } from 'zod';
import type { PgSslMode } from '../storage/postgres';

/**
 * Environment parsing. Fails closed: every dependency and credential must be
 * configured explicitly — there is no fallback session secret and no
 * default upstream URL in production.
 */

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** verify (default) | no-verify | disable — disable only for Render's internal URL or local containers. */
  DATABASE_SSL: z.enum(['verify', 'no-verify', 'disable']).default('verify'),

  /** Signs the game's own session tokens (HS256). At least 32 characters of randomness. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(7 * 24 * 60).default(12 * 60),

  /** AI Arena API gateway origin (serves /v1/auth/me and /v1/agents/mine). */
  AI_ARENA_API_URL: z.string().url(),
  /** ai-infrastructure base URL and this game's HMAC service key (scopes football:read, football:predict). */
  AI_INFRA_URL: z.string().url(),
  AI_INFRA_KEY_ID: z.string().min(1),
  AI_INFRA_SECRET: z.string().min(43, 'AI_INFRA_SECRET must decode to at least 32 bytes'),
  /** Hello Minds Builder API, used to prove a Minds Connect sign-in when an owner links their Mind. */
  MINDS_API_URL: z.string().url().default('https://api.build.hellominds.ai'),
  /** This API's public origin, written into the director OpenAPI spec a Mind builds its Skill from. */
  PUBLIC_API_URL: z.string().url().default('https://pixel-agency-api.onrender.com'),

  /** Origins allowed to call the API from a browser (the game's host), comma separated. */
  CORS_ORIGINS: z.string().default(''),
  /** Predictions lock this many minutes before kickoff. */
  LOCK_MINUTES_BEFORE_KICKOFF: z.coerce.number().int().min(0).max(120).default(5),
  /** Analysis runs per agency per fixture (each run reads one brief per hired specialty). */
  MAX_ANALYSES_PER_FIXTURE: z.coerce.number().int().min(1).max(20).default(3),
  WORKER_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024).default(64 * 1024),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(60_000),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  databasePoolMax: number;
  databaseSsl: PgSslMode;
  sessionSecret: string;
  sessionTtlMinutes: number;
  aiArenaApiUrl: string;
  aiInfra: { url: string; keyId: string; secret: string };
  mindsApiUrl: string;
  publicApiUrl: string;
  corsOrigins: string[];
  lockMinutesBeforeKickoff: number;
  maxAnalysesPerFixture: number;
  workerIntervalSeconds: number;
  bodyLimitBytes: number;
  rateLimitPerMinute: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    // Problems name variables, never their values.
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // `KEY=` (empty) in a .env file means "not set".
  const parsed = envSchema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== '')));
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const corsOrigins = csv(e.CORS_ORIGINS);
  const problems: string[] = [];
  for (const o of corsOrigins) {
    if (o === '*') problems.push('CORS_ORIGINS must list origins explicitly, not *');
    else if (!/^https?:\/\/[^/]+$/.test(o)) problems.push('CORS_ORIGINS entries must be origins like https://game.example.com (no path)');
  }
  if (e.NODE_ENV === 'production') {
    if (!e.AI_ARENA_API_URL.startsWith('https://')) problems.push('AI_ARENA_API_URL must use https in production');
    if (!e.MINDS_API_URL.startsWith('https://')) problems.push('MINDS_API_URL must use https in production');
    if (corsOrigins.some((o) => o.startsWith('http://'))) problems.push('CORS_ORIGINS must use https in production');
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    databaseSsl: e.DATABASE_SSL,
    sessionSecret: e.SESSION_SECRET,
    sessionTtlMinutes: e.SESSION_TTL_MINUTES,
    aiArenaApiUrl: e.AI_ARENA_API_URL.replace(/\/$/, ''),
    aiInfra: { url: e.AI_INFRA_URL.replace(/\/$/, ''), keyId: e.AI_INFRA_KEY_ID, secret: e.AI_INFRA_SECRET },
    mindsApiUrl: e.MINDS_API_URL.replace(/\/$/, ''),
    publicApiUrl: e.PUBLIC_API_URL.replace(/\/$/, ''),
    corsOrigins,
    lockMinutesBeforeKickoff: e.LOCK_MINUTES_BEFORE_KICKOFF,
    maxAnalysesPerFixture: e.MAX_ANALYSES_PER_FIXTURE,
    workerIntervalSeconds: e.WORKER_INTERVAL_SECONDS,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
  };
}
