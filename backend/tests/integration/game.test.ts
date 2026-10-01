import pino from 'pino';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { unauthorized } from '../../src/api/errors';
import type { ArenaGateway, ArenaIdentity } from '../../src/clients/ai-arena';
import type { FixtureContext, FootballIntel, MatchOutcome, Specialty } from '../../src/clients/ai-infra';
import { GameService } from '../../src/game/service';
import { GameStore } from '../../src/game/store';
import { migrate } from '../../src/storage/migrate';
import { brief, context, FIXTURE_ID, KICKOFF } from '../fixtures/match';

const url = process.env.TEST_DATABASE_URL;
const SECRET = 'test-session-secret-'.padEnd(48, 'x');

class StubArena implements ArenaGateway {
  users = new Map<string, ArenaIdentity>();
  async identify(token: string) {
    const u = this.users.get(token);
    if (!u) throw unauthorized('AI Arena session is invalid or expired');
    return u;
  }
}

class StubIntel implements FootballIntel {
  ctx: FixtureContext = context({ forecast: null });
  outcome: MatchOutcome | null = null;
  researched: Specialty[] = [];
  forecasts = 0;
  async listFixtures() {
    return [this.ctx.fixture];
  }
  async context(id: number) {
    if (id !== FIXTURE_ID) throw Object.assign(new Error('nf'), { statusCode: 404 });
    return { ...this.ctx, outcome: this.outcome };
  }
  async forecastNow() {
    this.forecasts++;
    this.ctx = { ...this.ctx, forecast: context().forecast };
    return this.context(FIXTURE_ID);
  }
  async research(_id: number, s: Specialty) {
    this.researched.push(s);
    if (s === 'weather') throw new Error('weather service down');
    return brief(s);
  }
}

describe.skipIf(!url)('Pixel Agency (end to end, Postgres)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let game: GameService;
  let clock = new Date('2026-10-01T09:00:00Z'); // Thursday, ISO week 2026-W40
  const arena = new StubArena();
  const intel = new StubIntel();
  const tokens: Record<string, string> = {};

  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, who?: string, body?: unknown) => {
    const res = await app.inject({ method, url: path, headers: who ? { authorization: `Bearer ${tokens[who]}` } : {}, ...(body !== undefined && { payload: body as object }) });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    await pool.query('DROP SCHEMA IF EXISTS pixel_agency CASCADE');
    await migrate(pool);
    arena.users.set('arena-token-alice-0123456789', {
      userId: 'user-alice', walletAddress: '0xa11ce', username: 'alice',
      agents: [
        { id: 'agent-kraken', name: 'Kraken', clan: 'ZEROG', archetype: 'BERSERKER', evolutionStage: 'GENESIS', eloRating: 1200, isRetired: false },
        { id: 'agent-old', name: 'Old Timer', clan: 'BASE', archetype: null, evolutionStage: null, eloRating: null, isRetired: true },
      ],
    });
    arena.users.set('arena-token-bob-0123456789xx', {
      userId: 'user-bob', walletAddress: '0xb0b', username: 'bob',
      agents: [{ id: 'agent-owl', name: 'Owl', clan: 'OKX', archetype: null, evolutionStage: null, eloRating: null, isRetired: false }],
    });
    game = new GameService(new GameStore(pool), arena, intel, { sessionSecret: SECRET, sessionTtlMinutes: 30 * 24 * 60, lockMinutesBeforeKickoff: 5, maxAnalysesPerFixture: 3 }, pino({ level: 'silent' }), () => clock);
    app = await buildApp({
      config: { logLevel: 'silent', bodyLimitBytes: 65536, requestTimeoutMs: 30000, rateLimitPerMinute: 1000, corsOrigins: ['https://game.example.com'], sessionSecret: SECRET },
      game,
      now: () => clock.getTime(),
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('1. exchanges an AI Arena token for a game session', async () => {
    expect((await call('POST', '/v1/auth/session', undefined, { aiArenaToken: 'arena-token-nobody-01234567' })).status).toBe(401);
    const s = await call('POST', '/v1/auth/session', undefined, { aiArenaToken: 'arena-token-alice-0123456789' });
    expect(s.status).toBe(200);
    expect(s.body.agents.map((a: { id: string }) => a.id)).toEqual(['agent-kraken']); // retired agents hidden
    expect(s.body.agency).toBeNull();
    tokens.alice = s.body.token;
    tokens.bob = (await call('POST', '/v1/auth/session', undefined, { aiArenaToken: 'arena-token-bob-0123456789xx' })).body.token;
    expect((await call('GET', '/v1/me')).status).toBe(401);
    expect((await call('GET', '/v1/me', 'alice')).body.player.userId).toBe('user-alice');
  });

  it('2. founds an agency with one of the player\'s own agents as CEO', async () => {
    expect((await call('POST', '/v1/agency', 'alice', { name: 'Pixel FC', ceoAgentId: 'agent-owl' })).status).toBe(403); // Bob's agent
    expect((await call('POST', '/v1/agency', 'alice', { name: 'Pixel FC', ceoAgentId: 'agent-old' })).status).toBe(400); // retired
    const a = await call('POST', '/v1/agency', 'alice', { name: 'Pixel FC', ceoAgentId: 'agent-kraken' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ name: 'Pixel FC', credits: 1500, level: 1, desks: 3, ceo: { name: 'Kraken' }, staff: [] });
    expect((await call('POST', '/v1/agency', 'alice', { name: 'Second', ceoAgentId: 'agent-kraken' })).status).toBe(409);
    expect((await call('POST', '/v1/agency', 'bob', { name: 'pixel fc', ceoAgentId: 'agent-owl' })).status).toBe(409); // name, case-insensitive
    expect((await call('POST', '/v1/agency', 'bob', { name: 'Owl Analytics', ceoAgentId: 'agent-owl' })).status).toBe(201);
  });

  it('3. hires from the weekly talent pool, limited by desks and credits', async () => {
    // Candidate prices depend on the (random) agency id; fund the agency so every hire is affordable.
    const store = new GameStore(pool);
    const id = (await call('GET', '/v1/agency', 'alice')).body.id;
    await store.tx(async (c) => store.applyCredit(c, await store.lockAgency(c, id), 3000, 'grant', 'test-top-up'));
    const pool1 = (await call('GET', '/v1/talent', 'alice')).body;
    expect(pool1.week).toBe('2026-W40');
    expect(pool1.candidates).toHaveLength(10);
    const pick = (s: string) => pool1.candidates.find((c: { specialty: string }) => c.specialty === s);
    let spent = 0;
    for (const s of ['form', 'odds', 'weather']) {
      const c = pick(s);
      const r = await call('POST', '/v1/staff', 'alice', { candidateKey: c.candidateKey });
      expect(r.status).toBe(201);
      spent += c.hireCost;
    }
    const agency = (await call('GET', '/v1/agency', 'alice')).body;
    expect(agency.credits).toBe(4500 - spent);
    expect(agency.staff).toHaveLength(3);
    expect((await call('GET', '/v1/talent', 'alice')).body.candidates).toHaveLength(7);
    const full = await call('POST', '/v1/staff', 'alice', { candidateKey: pick('discipline').candidateKey });
    expect(full.status).toBe(409);
    expect(full.body.message).toMatch(/desks/);

    const fired = await call('DELETE', `/v1/staff/${agency.staff.find((x: { specialty: string }) => x.specialty === 'weather').id}`, 'alice');
    expect(fired.status).toBe(200);
    expect((await call('POST', '/v1/staff', 'alice', { candidateKey: pick('discipline').candidateKey })).status).toBe(201);
    expect((await call('POST', '/v1/staff', 'alice', { candidateKey: pick('weather').candidateKey })).status).toBe(409); // already hired once

    const ledger = (await call('GET', '/v1/agency/ledger', 'alice')).body;
    expect(ledger.entries.map((e: { kind: string }) => e.kind)).toEqual(['hire', 'hire', 'hire', 'hire', 'grant', 'grant']);
  });

  it('4. analyses a match: forecasts on demand, one brief per specialty, CEO drafts the picks', async () => {
    const r = await call('POST', `/v1/fixtures/${FIXTURE_ID}/analysis`, 'alice');
    expect(r.status).toBe(200);
    expect(intel.forecasts).toBe(1);
    expect(intel.researched.sort()).toEqual(['discipline', 'form', 'odds']);
    const { analysis, prediction } = r.body;
    expect(analysis.reports).toHaveLength(3);
    expect(prediction).toMatchObject({ status: 'DRAFT', week: '2026-W40', edited: false, lockAt: '2026-10-03T13:55:00.000Z' });
    expect(analysis.combined.markets.cards.covered).toBe(true);
    expect(analysis.combined.markets.corners.source).toBe('ceo');
    expect(r.body.analysesUsed).toBe(1);

    // Re-running with the same staff gives the same reports: nothing to farm.
    const again = await call('POST', `/v1/fixtures/${FIXTURE_ID}/analysis`, 'alice');
    expect(again.body.analysis.combined.picks).toEqual(analysis.combined.picks);
    expect(intel.forecasts).toBe(1);
  });

  it('5. the CEO edits the draft within the rules, then locks it', async () => {
    const bad = await call('PUT', `/v1/fixtures/${FIXTURE_ID}/prediction`, 'alice', { outcome: 'AWAY', score: { home: 2, away: 0 } });
    expect(bad.status).toBe(400);
    expect((await call('PUT', `/v1/fixtures/${FIXTURE_ID}/prediction`, 'alice', { scorerId: '9999' })).status).toBe(400);
    expect((await call('PUT', `/v1/fixtures/${FIXTURE_ID}/prediction`, 'alice', { corners: 31 })).status).toBe(400);
    const ok = await call('PUT', `/v1/fixtures/${FIXTURE_ID}/prediction`, 'alice', { outcome: 'HOME', score: { home: 2, away: 1 }, corners: 10, cards: 4, scorerId: '1001' });
    expect(ok.status).toBe(200);
    expect(ok.body.prediction).toMatchObject({ edited: true, picks: { scorerName: 'Bukayo Test' } });

    expect((await call('POST', `/v1/fixtures/${FIXTURE_ID}/prediction/lock`, 'alice')).body.prediction.status).toBe('LOCKED');
    expect((await call('PUT', `/v1/fixtures/${FIXTURE_ID}/prediction`, 'alice', { corners: 9 })).status).toBe(409);
    expect((await call('POST', `/v1/fixtures/${FIXTURE_ID}/analysis`, 'alice')).status).toBe(409);
    await expect(pool.query(`UPDATE pixel_agency.predictions SET picks = '{}' WHERE status = 'LOCKED'`)).rejects.toThrow(/locked/);
  });

  it('6. drafts auto-lock at the deadline; late players are turned away', async () => {
    // Bob has no analysts: the CEO drafts alone.
    const bob = await call('POST', `/v1/fixtures/${FIXTURE_ID}/analysis`, 'bob');
    expect(bob.status).toBe(200);
    expect(bob.body.analysis.combined.summary).toMatch(/No analysts on staff/);
    clock = new Date('2026-10-03T13:56:00Z');
    expect(await game.autoLock()).toBe(1);
    const p = (await call('GET', `/v1/fixtures/${FIXTURE_ID}`, 'bob')).body.prediction;
    expect(p).toMatchObject({ status: 'LOCKED', autoLocked: true });
    expect((await call('POST', `/v1/fixtures/${FIXTURE_ID}/analysis`, 'bob')).status).toBe(409);
  });

  it('7. settles once the result is in: points, credits, analyst XP', async () => {
    clock = new Date('2026-10-03T15:10:00Z');
    expect(await game.settleDue()).toEqual({ settled: 0, voided: 0, pending: 0 }); // too early to look
    clock = new Date('2026-10-03T16:30:00Z');
    expect(await game.settleDue()).toEqual({ settled: 0, voided: 0, pending: 1 }); // no result yet
    intel.outcome = { status: 'FINISHED', regulation: { home: 2, away: 1 }, scorers: ['1001', '2001'], totalCards: 5, totalCorners: 12 };
    expect(await game.settleDue()).toEqual({ settled: 2, voided: 0, pending: 0 });
    expect(await game.settleDue()).toEqual({ settled: 0, voided: 0, pending: 0 });

    const p = (await call('GET', `/v1/fixtures/${FIXTURE_ID}`, 'alice')).body.prediction;
    // Outcome 5 + exact score 7 + corners off by 2 (0) + cards off by 1 (5) + scorer 20
    expect(p).toMatchObject({ status: 'SETTLED', points: 37, exactHits: 3 });
    expect(p.breakdown.cards).toEqual({ result: 'CLOSE', points: 5 });
    const agency = (await call('GET', '/v1/agency', 'alice')).body;
    const ledger = (await call('GET', '/v1/agency/ledger', 'alice')).body;
    expect(ledger.entries[0]).toMatchObject({ kind: 'winnings', delta: 370 });
    expect(agency.credits).toBe(ledger.entries[0].balanceAfter);
    expect(agency.points).toBe(37);
    const form = agency.staff.find((x: { specialty: string }) => x.specialty === 'form');
    expect(form.xp + (form.skill - 1) * 100).toBeGreaterThan(0);
    await expect(pool.query(`UPDATE pixel_agency.credit_ledger SET delta = 0`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`UPDATE pixel_agency.predictions SET points_x10 = 999`)).rejects.toThrow(/final/);
  });

  it('8. weekly and all-time leaderboards, public, with the caller\'s own standing', async () => {
    const weekly = await call('GET', '/v1/leaderboards/weekly');
    expect(weekly.status).toBe(200);
    expect(weekly.body.week).toBe('2026-W40');
    const entries = weekly.body.entries as Array<{ rank: number; agencyName: string; points: number; ceo: { name: string } }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.rank).toBe(1);
    expect(entries[0]!.points).toBeGreaterThanOrEqual(entries[1]!.points);
    expect(entries.find((e) => e.agencyName === 'Pixel FC')).toMatchObject({ points: 37, ceo: { name: 'Kraken' } });
    expect(weekly.body.me).toBeNull();
    const mine = await call('GET', '/v1/leaderboards/all-time', 'bob');
    expect(mine.body.me.agencyName).toBe('Owl Analytics');
    expect((await call('GET', '/v1/leaderboards/weekly?week=2026-W41')).body.entries).toEqual([]);
    expect((await call('GET', '/v1/leaderboards/monthly')).status).toBe(400);
  });

  it('9. weekly payroll: paid once per week; unaffordable analysts quit', async () => {
    clock = new Date('2026-10-05T00:10:00Z'); // Monday, 2026-W41
    const before = (await call('GET', '/v1/agency', 'alice')).body;
    const res = await game.runPayroll();
    expect(res).toMatchObject({ agencies: 2, quit: 0 });
    expect(res.paid).toBe(3);
    const after = (await call('GET', '/v1/agency', 'alice')).body;
    expect(after.credits).toBe(before.credits - before.payroll.weeklyTotal);
    expect(await game.runPayroll()).toEqual({ agencies: 0, paid: 0, quit: 0 });

    // Drain Alice's credits through the ledger path, then the next payroll cannot be met.
    const store = new GameStore(pool);
    await store.tx(async (c) => {
      const a = await store.lockAgency(c, after.id);
      await store.applyCredit(c, a, -(a.credits - 10), 'hire', 'test-drain');
    });
    clock = new Date('2026-10-12T00:10:00Z');
    expect((await game.runPayroll()).quit).toBe(3);
    expect((await call('GET', '/v1/agency', 'alice')).body.staff).toEqual([]);
  });

  it('10. CORS allows only the game origin; errors never leak internals', async () => {
    const ok = await app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: 'https://game.example.com', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://game.example.com');
    const evil = await app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const nf = await call('GET', '/v1/fixtures/12345', 'alice');
    expect(nf.status).toBe(404);
    expect(Object.keys(nf.body).sort()).toEqual(['correlationId', 'error']);
    expect(JSON.stringify(nf.body)).not.toMatch(/nf|stack/);
    expect(new Date(KICKOFF).getTime()).toBeGreaterThan(0);
  });
});
