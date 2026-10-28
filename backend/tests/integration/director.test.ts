import pino from 'pino';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { AppError, unauthorized, upstreamUnavailable } from '../../src/api/errors';
import type { ArenaGateway, ArenaIdentity } from '../../src/clients/ai-arena';
import type { FixtureContext, FootballIntel, MatchOutcome, MatchRecord, RecordProfile, RecordSubmission, Specialty } from '../../src/clients/ai-infra';
import type { ArenaMind, ArenaMindKeys } from '../../src/clients/arena-minds';
import type { MindsGateway, MindsIdentity } from '../../src/clients/minds';
import { DirectorService } from '../../src/game/director';
import { MindsStore } from '../../src/game/minds-store';
import { GameService } from '../../src/game/service';
import { GameStore } from '../../src/game/store';
import { migrate } from '../../src/storage/migrate';
import { brief, context, FIXTURE_ID } from '../fixtures/match';

/** Mind directors end to end: link a Minds account, direct the agency with a key, decide, record, settle. */

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
  ctx: FixtureContext = context();
  outcome: MatchOutcome | null = null;
  async listFixtures() {
    return [this.ctx.fixture];
  }
  async context() {
    return { ...this.ctx, outcome: this.outcome };
  }
  async forecastNow() {
    return this.context();
  }
  async research(_id: number, s: Specialty) {
    return brief(s);
  }
}

class StubRecord implements MatchRecord {
  submissions: Array<{ fixtureId: number; s: RecordSubmission }> = [];
  failWith: AppError | null = null;
  async submit(fixtureId: number, s: RecordSubmission) {
    if (this.failWith) throw this.failWith;
    this.submissions.push({ fixtureId, s });
    return { prediction: { agentId: s.agent.id, decisionId: `dec-${this.submissions.length}`, picks: {} }, alreadySubmitted: false };
  }
  async profile(agentId: string): Promise<RecordProfile> {
    return {
      agentId,
      record: [{ market: 'result', n: 1, hitRate: 1, ciLow: null, ciHigh: null }],
      calibration: [],
      baseline: [{ market: 'result', n: 1, hitRate: 1, baselineHitRate: 1, difference: 0, ciLow: null, ciHigh: null }],
      lessons: [],
      recentOutcomes: [],
    };
  }
}

class StubArenaMinds implements ArenaMindKeys {
  keys = new Map<string, ArenaMind>();
  async resolve(key: string) {
    return this.keys.get(key);
  }
}

class StubMinds implements MindsGateway {
  accounts = new Map<string, MindsIdentity>();
  async identify(token: string) {
    const a = this.accounts.get(token);
    if (!a) throw unauthorized('Hello Minds rejected the sign-in; sign in with Minds again');
    return a;
  }
}

describe.skipIf(!url)('Mind directors (end to end, Postgres)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let director: DirectorService;
  let game: GameService;
  let clock = new Date('2026-10-01T09:00:00Z');
  const arena = new StubArena();
  const intel = new StubIntel();
  const record = new StubRecord();
  const minds = new StubMinds();
  const arenaMinds = new StubArenaMinds();
  const tokens: Record<string, string> = {};
  const keys: Record<string, string> = {};

  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, who?: { user?: string; key?: string; mindKey?: string }, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (who?.mindKey) headers['x-mind-key'] = who.mindKey;
    if (who?.user) headers.authorization = `Bearer ${tokens[who.user]}`;
    if (who?.key) headers['x-director-key'] = who.key;
    const res = await app.inject({ method, url: path, headers, ...(body !== undefined && { payload: body as object }) });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const decision = (over: Record<string, unknown> = {}) => ({
    picks: { outcome: 'HOME', score: { home: 2, away: 1 }, corners: 9, cards: 6, scorerId: '1001', ...over },
    conviction: 'HIGH',
    rationale: 'Arsenal unbeaten at home in five; Chelsea without a recognised striker.',
    evidence: ['https://example.com/team-news'],
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    await pool.query('DROP SCHEMA IF EXISTS pixel_agency CASCADE');
    await migrate(pool);
    arena.users.set('arena-token-alice-0123456789', { userId: 'user-alice', walletAddress: '0xa', username: 'alice', agents: [{ id: 'agent-kraken', name: 'Kraken', clan: 'ZEROG', archetype: null, evolutionStage: null, eloRating: null, isRetired: false }] });
    arena.users.set('arena-token-bob-0123456789xx', { userId: 'user-bob', walletAddress: '0xb', username: 'bob', agents: [{ id: 'agent-owl', name: 'Owl', clan: 'OKX', archetype: null, evolutionStage: null, eloRating: null, isRetired: false }] });
    minds.accounts.set('minds-token-alice-0123456789', { mindsUserId: 'mu-alice', minds: [{ mindId: 'gaffer', name: 'Gaffer', email: 'gaffer@hellominds.ai', model: 'm' }, { mindId: 'scout', name: 'Scout', email: null, model: 'm' }] });
    minds.accounts.set('minds-token-bob-0123456789', { mindsUserId: 'mu-bob', minds: [{ mindId: 'owl-mind', name: 'Owl Mind', email: null, model: 'm' }] });

    const store = new GameStore(pool);
    const log = pino({ level: 'silent' });
    const cfg = { sessionSecret: SECRET, sessionTtlMinutes: 30 * 24 * 60, lockMinutesBeforeKickoff: 5, maxAnalysesPerFixture: 3 };
    game = new GameService(store, arena, intel, cfg, log, () => clock);
    director = new DirectorService(game, store, new MindsStore(pool), minds, intel, record, { lockMinutesBeforeKickoff: 5 }, log, () => clock, arenaMinds);
    app = await buildApp({
      config: { logLevel: 'silent', bodyLimitBytes: 65536, requestTimeoutMs: 30000, rateLimitPerMinute: 1000, corsOrigins: [], sessionSecret: SECRET },
      game,
      director: { service: director, publicApiUrl: 'https://api.example.test' },
      now: () => clock.getTime(),
    });
    await app.ready();

    for (const [who, token] of [['alice', 'arena-token-alice-0123456789'], ['bob', 'arena-token-bob-0123456789xx']] as const) {
      tokens[who] = (await call('POST', '/v1/auth/session', undefined, { aiArenaToken: token })).body.token;
    }
    expect((await call('POST', '/v1/agency', { user: 'alice' }, { name: 'Pixel FC', ceoAgentId: 'agent-kraken' })).status).toBe(201);
    expect((await call('POST', '/v1/agency', { user: 'bob' }, { name: 'Owl Analytics', ceoAgentId: 'agent-owl' })).status).toBe(201);
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('1. links a Minds account and issues a director key once', async () => {
    expect((await call('POST', '/v1/agency/mind', undefined, { accessToken: 'minds-token-alice-0123456789' })).status).toBe(401);
    expect((await call('POST', '/v1/agency/mind', { user: 'alice' }, { accessToken: 'minds-token-nobody-0123456789' })).status).toBe(401);

    const first = await call('POST', '/v1/agency/mind', { user: 'alice' }, { accessToken: 'minds-token-alice-0123456789' });
    expect(first.status).toBe(200);
    expect(first.body.mind.mindId).toBeNull(); // two Minds: the owner must choose
    expect(first.body.minds).toHaveLength(2);
    expect(first.body.key.key).toMatch(/^pa_mk_/);
    keys.alice = first.body.key.key;

    expect((await call('POST', '/v1/agency/mind', { user: 'alice' }, { accessToken: 'minds-token-alice-0123456789', mindId: 'not-mine' })).status).toBe(400);
    const chosen = await call('POST', '/v1/agency/mind', { user: 'alice' }, { accessToken: 'minds-token-alice-0123456789', mindId: 'gaffer' });
    expect(chosen.body.mind).toMatchObject({ mindId: 'gaffer', name: 'Gaffer', agentId: 'mind:gaffer' });
    expect(chosen.body.key).toBeNull(); // a key is already active

    // One Minds account directs one agency.
    expect((await call('POST', '/v1/agency/mind', { user: 'bob' }, { accessToken: 'minds-token-alice-0123456789' })).status).toBe(409);
    const bob = await call('POST', '/v1/agency/mind', { user: 'bob' }, { accessToken: 'minds-token-bob-0123456789' });
    expect(bob.body.mind.mindId).toBe('owl-mind'); // the only Mind is chosen automatically
    keys.bob = bob.body.key.key;

    const status = await call('GET', '/v1/agency/mind', { user: 'alice' });
    expect(status.body.keys).toHaveLength(1);
    expect(JSON.stringify(status.body)).not.toContain(keys.alice); // only hashes are stored
  });

  it('2. the director API needs a valid key and runs the agency', async () => {
    expect((await call('GET', '/v1/director/agency')).status).toBe(401);
    expect((await call('GET', '/v1/director/agency', { key: 'pa_mk_' + 'x'.repeat(43) })).status).toBe(401);
    expect((await call('GET', '/v1/director/agency', { user: 'alice' })).status).toBe(401); // a session is not a director key
    const agency = await call('GET', '/v1/director/agency', { key: keys.alice });
    expect(agency.body).toMatchObject({ name: 'Pixel FC' });

    const talent = (await call('GET', '/v1/director/talent', { key: keys.alice })).body;
    const cheapest = [...talent.candidates].sort((a: { hireCost: number }, b: { hireCost: number }) => a.hireCost - b.hireCost)[0];
    expect((await call('POST', '/v1/director/staff', { key: keys.alice }, { candidateKey: cheapest.candidateKey })).status).toBe(201);
    expect((await call('POST', `/v1/director/fixtures/${FIXTURE_ID}/analysis`, { key: keys.alice })).status).toBe(200);
    const fixture = await call('GET', `/v1/director/fixtures/${FIXTURE_ID}`, { key: keys.alice });
    expect(fixture.body.squad.length).toBeGreaterThan(0);
    expect(fixture.body.prediction.status).toBe('DRAFT');
  });

  it('3. a Mind\'s decision is validated, locked and put on the record', async () => {
    const path = `/v1/director/fixtures/${FIXTURE_ID}/decision`;
    expect((await call('POST', path, { key: keys.alice }, decision({ outcome: 'AWAY' }))).body.message).toMatch(/agree with the outcome/);
    expect((await call('POST', path, { key: keys.alice }, decision({ score: { home: 0, away: 1 }, outcome: 'AWAY', scorerId: '1001' }))).body.message).toMatch(/will not score/);
    expect((await call('POST', path, { key: keys.alice }, { ...decision(), extra: true })).status).toBe(400);
    expect(record.submissions).toHaveLength(0);

    const r = await call('POST', path, { key: keys.alice }, decision());
    expect(r.status).toBe(200);
    expect(r.body.prediction).toMatchObject({
      status: 'LOCKED', decidedBy: 'mind', picks: { outcome: 'HOME', corners: 9, cards: 6, scorerName: 'Bukayo Test' },
      mindDecision: { mindId: 'gaffer', conviction: 'HIGH', record: { status: 'recorded', agentId: 'mind:gaffer', decisionId: 'dec-1' } },
    });
    // Exact cards/corners go on the record as the side of its lines (4.5, 9.5).
    expect(record.submissions[0]).toEqual({
      fixtureId: FIXTURE_ID,
      s: {
        agent: { id: 'mind:gaffer', name: 'Gaffer' },
        picks: { result: 'HOME', score: { home: 2, away: 1 }, totalCards: 'OVER', totalCorners: 'UNDER', scorerId: '1001' },
        conviction: 'HIGH', rationale: decision().rationale, evidence: decision().evidence,
      },
    });

    // Final in the game: neither the Mind nor the owner can change it.
    expect((await call('POST', path, { key: keys.alice }, decision({ outcome: 'DRAW', score: { home: 1, away: 1 } }))).status).toBe(409);
    expect((await call('PUT', `/v1/fixtures/${FIXTURE_ID}/prediction`, { user: 'alice' }, { cards: 3 })).status).toBe(409);
  });

  it('4. if the record is unreachable the pick stays locked as pending and the worker records it', async () => {
    record.failWith = upstreamUnavailable('match intelligence answered 503');
    const r = await call('POST', `/v1/director/fixtures/${FIXTURE_ID}/decision`, { key: keys.bob }, decision({ outcome: 'DRAW', score: { home: 1, away: 1 }, scorerId: null }));
    expect(r.body.prediction).toMatchObject({ status: 'LOCKED', mindDecision: { record: { status: 'pending' } } });
    expect(await director.syncRecords()).toEqual({ recorded: 0, missed: 0, pending: 1 });
    record.failWith = null;
    expect(await director.syncRecords()).toEqual({ recorded: 1, missed: 0, pending: 0 });
    expect(record.submissions.at(-1)!.s.agent).toEqual({ id: 'mind:owl-mind', name: 'Owl Mind' });
  });

  it('5. refuses decisions once the record has closed, without locking anything', async () => {
    arena.users.set('arena-token-carol-012345678', { userId: 'user-carol', walletAddress: '0xc', username: 'carol', agents: [{ id: 'agent-c', name: 'C', clan: null, archetype: null, evolutionStage: null, eloRating: null, isRetired: false }] });
    tokens.carol = (await call('POST', '/v1/auth/session', undefined, { aiArenaToken: 'arena-token-carol-012345678' })).body.token;
    await call('POST', '/v1/agency', { user: 'carol' }, { name: 'Carol Data', ceoAgentId: 'agent-c' });
    minds.accounts.set('minds-token-carol-0123456789', { mindsUserId: 'mu-carol', minds: [{ mindId: 'c-mind', name: 'C Mind', email: null, model: 'm' }] });
    const key = (await call('POST', '/v1/agency/mind', { user: 'carol' }, { accessToken: 'minds-token-carol-0123456789' })).body.key.key;

    intel.ctx = { ...intel.ctx, predictionsOpen: false };
    const r = await call('POST', `/v1/director/fixtures/${FIXTURE_ID}/decision`, { key }, decision());
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/record for this match has closed/);
    expect((await call('GET', `/v1/director/fixtures/${FIXTURE_ID}`, { key })).body.prediction).toBeNull();
    intel.ctx = { ...intel.ctx, predictionsOpen: true };
  });

  it('6. settles a Mind\'s pick like any other and shows the career record', async () => {
    clock = new Date('2026-10-03T16:30:00Z');
    intel.outcome = { status: 'FINISHED', regulation: { home: 2, away: 1 }, scorers: ['1001', '2001'], totalCards: 6, totalCorners: 11 };
    await game.settleDue();
    const preds = (await call('GET', '/v1/director/predictions', { key: keys.alice })).body.predictions;
    expect(preds[0]).toMatchObject({ status: 'SETTLED', decidedBy: 'mind', points: 5 + 7 + 0 + 10 + 20, mindDecision: { record: { status: 'recorded' } } });

    const career = await call('GET', '/v1/director/record', { key: keys.alice });
    expect(career.body).toMatchObject({ mind: { mindId: 'gaffer', agentId: 'mind:gaffer' }, record: { vsBaseline: [{ market: 'result' }] }, agency: { name: 'Pixel FC' } });
  });

  it('7. keys can be revoked; unlinking revokes them all', async () => {
    const extra = await call('POST', '/v1/agency/mind/keys', { user: 'alice' });
    expect(extra.status).toBe(201);
    const ks = (await call('GET', '/v1/agency/mind', { user: 'alice' })).body.keys;
    expect((await call('DELETE', `/v1/agency/mind/keys/${ks[0].id}`, { user: 'alice' })).status).toBe(200);
    expect((await call('GET', '/v1/director/agency', { key: extra.body.key.key })).status).toBe(401);
    expect((await call('GET', '/v1/director/agency', { key: keys.alice })).status).toBe(200);
    expect((await call('DELETE', '/v1/agency/mind', { user: 'alice' })).status).toBe(200);
    expect((await call('GET', '/v1/director/agency', { key: keys.alice })).status).toBe(401);
  });

  it('8. a Mind linked to the CEO agent in AI Arena directs with its one KULT key', async () => {
    const kultKey = 'kult_mk_' + 'k'.repeat(43);
    const notCeo = 'kult_mk_' + 'n'.repeat(43);
    arenaMinds.keys.set(kultKey, { agentId: 'agent-owl', ownerUserId: 'user-bob', mindId: 'owl-mind', mindName: 'Owl Mind' });
    arenaMinds.keys.set(notCeo, { agentId: 'agent-other', ownerUserId: 'user-bob', mindId: 'x', mindName: 'X' });
    const agency = await call('GET', '/v1/director/agency', { mindKey: kultKey });
    expect(agency.status).toBe(200);
    expect(agency.body.name).toBe('Owl Analytics');
    expect((await call('GET', '/v1/director/agency', { mindKey: notCeo })).status).toBe(401);
    expect((await call('GET', '/v1/director/agency', { mindKey: 'kult_mk_' + 'u'.repeat(43) })).status).toBe(401);
  });

  it('9. publishes the spec the Mind builds its Skill from', async () => {
    const spec = (await call('GET', '/v1/director/openapi.json')).body;
    expect(spec.servers[0].url).toBe('https://api.example.test');
    expect(Object.keys(spec.paths)).toContain('/v1/director/fixtures/{id}/decision');
  });
});
