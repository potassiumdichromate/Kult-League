import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { AppConfig } from './config/env';
import { AiArenaClient } from './clients/ai-arena';
import { AiInfraClient } from './clients/ai-infra';
import { GameService } from './game/service';
import { GameStore } from './game/store';

export function buildGame(pool: Pool, cfg: AppConfig, log: Logger): GameService {
  return new GameService(
    new GameStore(pool),
    new AiArenaClient(cfg.aiArenaApiUrl),
    new AiInfraClient({ url: cfg.aiInfra.url, keyId: cfg.aiInfra.keyId, secret: cfg.aiInfra.secret, timeoutMs: Math.max(5_000, cfg.requestTimeoutMs - 5_000) }),
    { sessionSecret: cfg.sessionSecret, sessionTtlMinutes: cfg.sessionTtlMinutes, lockMinutesBeforeKickoff: cfg.lockMinutesBeforeKickoff, maxAnalysesPerFixture: cfg.maxAnalysesPerFixture },
    log,
  );
}
