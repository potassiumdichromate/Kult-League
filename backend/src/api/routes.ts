import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifySession } from '../auth/session';
import { picksEdit } from '../game/picks';
import type { GameService } from '../game/service';
import { parseOrThrow, unauthorized } from './errors';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

const fixtureParams = z.object({ id: z.coerce.number().int().positive() });
const sessionBody = z.object({ aiArenaToken: z.string().min(20).max(4096) }).strict();
const agencyBody = z
  .object({
    name: z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N} '&.-]+$/u, 'letters, numbers, spaces and \' & . - only'),
    ceoAgentId: z.string().min(1).max(100),
  })
  .strict();
const ceoBody = z.object({ ceoAgentId: z.string().min(1).max(100) }).strict();
const hireBody = z.object({ candidateKey: z.string().regex(/^\d{4}-W\d{2}:\d{1,2}$/) }).strict();
const analystParams = z.object({ analystId: z.string().uuid() });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fixturesQuery = z.object({ from: day.optional(), to: day.optional(), league: z.coerce.number().int().positive().optional() }).strict();
const boardQuery = z
  .object({
    week: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
const boardParams = z.object({ kind: z.enum(['weekly', 'all-time']) });

export function registerRoutes(app: FastifyInstance, game: GameService, sessionSecret: string, now: () => number = Date.now): void {
  const bearer = (req: FastifyRequest): string | undefined => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return undefined;
    return verifySession(sessionSecret, h.slice(7), now())?.userId;
  };
  const auth = async (req: FastifyRequest) => {
    const userId = bearer(req);
    if (!userId) throw unauthorized();
    req.userId = userId;
  };
  const user = (req: FastifyRequest) => req.userId!;

  // Exchange an AI Arena token (from the Kult browser) for a game session.
  app.post('/v1/auth/session', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { aiArenaToken } = parseOrThrow(sessionBody, req.body);
    return game.startSession(aiArenaToken);
  });

  app.get('/v1/me', { preHandler: auth }, async (req) => game.me(user(req)));

  app.post('/v1/agency', { preHandler: auth }, async (req, reply) => {
    const b = parseOrThrow(agencyBody, req.body);
    reply.status(201);
    return game.createAgency(user(req), b.name, b.ceoAgentId);
  });
  app.get('/v1/agency', { preHandler: auth }, async (req) => game.agency(user(req)));
  app.put('/v1/agency/ceo', { preHandler: auth }, async (req) => game.changeCeo(user(req), parseOrThrow(ceoBody, req.body).ceoAgentId));
  app.get('/v1/agency/ledger', { preHandler: auth }, async (req) => game.ledger(user(req)));

  app.get('/v1/talent', { preHandler: auth }, async (req) => game.talent(user(req)));
  app.post('/v1/staff', { preHandler: auth }, async (req, reply) => {
    const { candidateKey } = parseOrThrow(hireBody, req.body);
    reply.status(201);
    return game.hire(user(req), candidateKey);
  });
  app.delete('/v1/staff/:analystId', { preHandler: auth }, async (req) => game.fire(user(req), parseOrThrow(analystParams, req.params).analystId));

  app.get('/v1/fixtures', { preHandler: auth }, async (req) => game.fixtures(user(req), parseOrThrow(fixturesQuery, req.query)));
  app.get('/v1/fixtures/:id', { preHandler: auth }, async (req) => game.fixture(user(req), parseOrThrow(fixtureParams, req.params).id));
  // Each run calls research on 0G for every hired specialty: tightly limited.
  app.post('/v1/fixtures/:id/analysis', { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) =>
    game.analyse(user(req), parseOrThrow(fixtureParams, req.params).id),
  );
  app.put('/v1/fixtures/:id/prediction', { preHandler: auth }, async (req) =>
    game.editPicks(user(req), parseOrThrow(fixtureParams, req.params).id, parseOrThrow(picksEdit, req.body)),
  );
  app.post('/v1/fixtures/:id/prediction/lock', { preHandler: auth }, async (req) => game.lock(user(req), parseOrThrow(fixtureParams, req.params).id));
  app.get('/v1/predictions', { preHandler: auth }, async (req) => game.predictions(user(req)));

  // Public: anyone can view the boards; a signed-in player also gets their own standing.
  app.get('/v1/leaderboards/:kind', async (req) => {
    const { kind } = parseOrThrow(boardParams, req.params);
    return game.leaderboard(kind, parseOrThrow(boardQuery, req.query), bearer(req));
  });
}
