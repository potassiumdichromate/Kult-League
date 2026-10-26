import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { AppConfig } from './config/env';
import { AiArenaClient } from './clients/ai-arena';
import { AiInfraClient } from './clients/ai-infra';
import { MindsClient } from './clients/minds';
import { DirectorService } from './game/director';
import { MindsStore } from './game/minds-store';
import { GameService } from './game/service';
import { GameStore } from './game/store';

export function buildServices(pool: Pool, cfg: AppConfig, log: Logger): { game: GameService; director: DirectorService } {
  const store = new GameStore(pool);
  const infra = new AiInfraClient({ url: cfg.aiInfra.url, keyId: cfg.aiInfra.keyId, secret: cfg.aiInfra.secret, timeoutMs: Math.max(5_000, cfg.requestTimeoutMs - 5_000) });
  const game = new GameService(
    store,
    new AiArenaClient(cfg.aiArenaApiUrl),
    infra,
    { sessionSecret: cfg.sessionSecret, sessionTtlMinutes: cfg.sessionTtlMinutes, lockMinutesBeforeKickoff: cfg.lockMinutesBeforeKickoff, maxAnalysesPerFixture: cfg.maxAnalysesPerFixture },
    log,
  );
  const director = new DirectorService(game, store, new MindsStore(pool), new MindsClient(cfg.mindsApiUrl), infra, infra, { lockMinutesBeforeKickoff: cfg.lockMinutesBeforeKickoff }, log);
  return { game, director };
}
