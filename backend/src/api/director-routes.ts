import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifySession } from '../auth/session';
import type { DirectorRow } from '../game/minds-store';
import { DirectorService, looksLikeDirectorKey } from '../game/director';
import { directorOpenApi } from './director-openapi';
import { parseOrThrow, unauthorized } from './errors';

declare module 'fastify' {
  interface FastifyRequest {
    director?: DirectorRow;
  }
}

const goals = z.number().int().min(0).max(15);
export const decisionBody = z
  .object({
    picks: z
      .object({
        outcome: z.enum(['HOME', 'DRAW', 'AWAY']),
        score: z.object({ home: goals, away: goals }).strict(),
        corners: z.number().int().min(0).max(30),
        cards: z.number().int().min(0).max(20),
        scorerId: z.string().min(1).max(100).nullable(),
      })
      .strict(),
    conviction: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    rationale: z.string().trim().min(1).max(2000),
    evidence: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  })
  .strict();

const linkBody = z.object({ accessToken: z.string().min(20).max(8192), mindId: z.string().min(1).max(100).optional() }).strict();
const keyParams = z.object({ keyId: z.string().uuid() });
const fixtureParams = z.object({ id: z.coerce.number().int().positive() });
const analystParams = z.object({ analystId: z.string().uuid() });
const hireBody = z.object({ candidateKey: z.string().regex(/^\d{4}-W\d{2}:\d{1,2}$/) }).strict();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fixturesQuery = z.object({ from: day.optional(), to: day.optional(), league: z.coerce.number().int().positive().optional() }).strict();

/**
 * Mind directors (docs/ARCHITECTURE.md, "Mind directors").
 *   /v1/agency/mind/*  the owner (game session): link a Minds account, manage director keys
 *   /v1/director/*     the Mind's Skill (X-Director-Key): run the agency, make final calls
 */
export function registerDirectorRoutes(
  app: FastifyInstance,
  director: DirectorService,
  opts: { sessionSecret: string; publicApiUrl: string },
  now: () => number = Date.now,
): void {
  const { sessionSecret } = opts;
  const owner = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    const userId = h?.startsWith('Bearer ') ? verifySession(sessionSecret, h.slice(7), now())?.userId : undefined;
    if (!userId) throw unauthorized();
    req.userId = userId;
  };
  const user = (req: FastifyRequest) => req.userId!;

  // Linking proves the Minds token against Hello Minds: limited like sign-in.
  app.post('/v1/agency/mind', { preHandler: owner, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parseOrThrow(linkBody, req.body);
    return director.linkMind(user(req), b.accessToken, b.mindId);
  });
  app.get('/v1/agency/mind', { preHandler: owner }, async (req) => director.mindStatus(user(req)));
  app.delete('/v1/agency/mind', { preHandler: owner }, async (req) => director.unlink(user(req)));
  app.post('/v1/agency/mind/keys', { preHandler: owner, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.status(201);
    return director.newKey(user(req));
  });
  app.delete('/v1/agency/mind/keys/:keyId', { preHandler: owner }, async (req) => director.revokeKey(user(req), parseOrThrow(keyParams, req.params).keyId));

  // ── the Mind's API ───────────────────────────────────────────────────
  const spec = directorOpenApi(opts.publicApiUrl);
  app.get('/v1/director/openapi.json', async () => spec);

  app.register(async (scope) => {
    scope.addHook('preHandler', async (req) => {
      const key = req.headers['x-director-key'];
      const d = looksLikeDirectorKey(key) ? await director.resolve(key) : undefined;
      if (!d) throw unauthorized('missing, unknown or revoked X-Director-Key');
      req.director = d;
    });
    const d = (req: FastifyRequest) => req.director!;

    scope.get('/v1/director/agency', async (req) => director.forOwner.agency(d(req)));
    scope.get('/v1/director/record', async (req) => director.career(d(req)));
    scope.get('/v1/director/talent', async (req) => director.forOwner.talent(d(req)));
    scope.post('/v1/director/staff', async (req, reply) => {
      reply.status(201);
      return director.forOwner.hire(d(req), parseOrThrow(hireBody, req.body).candidateKey);
    });
    scope.delete('/v1/director/staff/:analystId', async (req) => director.forOwner.fire(d(req), parseOrThrow(analystParams, req.params).analystId));
    scope.get('/v1/director/fixtures', async (req) => director.forOwner.fixtures(d(req), parseOrThrow(fixturesQuery, req.query)));
    scope.get('/v1/director/fixtures/:id', async (req) => director.forOwner.fixture(d(req), parseOrThrow(fixtureParams, req.params).id));
    // Each run reads one research brief per hired specialty on 0G: tightly limited, as for players.
    scope.post('/v1/director/fixtures/:id/analysis', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) =>
      director.forOwner.analyse(d(req), parseOrThrow(fixtureParams, req.params).id),
    );
    scope.post('/v1/director/fixtures/:id/decision', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
      const body = parseOrThrow(decisionBody, req.body);
      return director.decide(d(req), parseOrThrow(fixtureParams, req.params).id, { ...body, evidence: body.evidence ?? [] });
    });
    scope.get('/v1/director/predictions', async (req) => director.forOwner.predictions(d(req)));
  });
}
