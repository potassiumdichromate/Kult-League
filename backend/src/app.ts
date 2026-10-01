import Fastify, { FastifyInstance, LogController } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from './config/env';
import { errorHandler } from './api/errors';
import { registerRoutes } from './api/routes';
import type { GameService } from './game/service';
import { CORRELATION_HEADER, genCorrelationId, loggerOptions } from './telemetry/logger';

export interface AppDeps {
  config: Pick<AppConfig, 'logLevel' | 'bodyLimitBytes' | 'requestTimeoutMs' | 'rateLimitPerMinute' | 'corsOrigins' | 'sessionSecret'>;
  game: GameService;
  /** Readiness probe (database). */
  ready?: () => Promise<void>;
  /** Clock override for tests. */
  now?: () => number;
}

/**
 * The game API, built without listening so tests use `app.inject()`.
 * Browsers may call it only from the configured game origins; auth is a
 * bearer session token (no cookies), so CORS credentials stay off.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: loggerOptions(config.logLevel),
    genReqId: genCorrelationId,
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    bodyLimit: config.bodyLimitBytes,
    requestTimeout: config.requestTimeoutMs,
    return503OnClosing: true,
    // Render terminates TLS at one proxy hop: trust exactly that hop, so per-IP
    // rate limits see the client address and a forged X-Forwarded-For is ignored.
    trustProxy: (_address: string, hop: number) => hop < 1,
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: 'not_found', correlationId: req.id });
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header(CORRELATION_HEADER, req.id);
  });

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', CORRELATION_HEADER],
    exposedHeaders: [CORRELATION_HEADER],
    credentials: false,
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health',
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    try {
      await deps.ready?.();
      return { status: 'ready' };
    } catch {
      reply.status(503);
      return { status: 'unavailable' };
    }
  });

  registerRoutes(app, deps.game, config.sessionSecret, deps.now);
  return app;
}
