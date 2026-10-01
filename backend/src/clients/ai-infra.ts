import { createHash, createHmac, randomBytes } from 'node:crypto';
import { AppError, upstreamUnavailable } from '../api/errors';

/**
 * Client for ai-infrastructure (football intelligence on 0G). Requests are
 * signed with HMAC scheme v1:
 *
 *   canonical = "v1\n" + METHOD + "\n" + pathWithQuery + "\n" + timestamp + "\n" + nonce + "\n" + sha256hex(body)
 *   x-aii-signature = hex(HMAC-SHA256(secret, canonical))
 */

export type Specialty = 'form' | 'lineups' | 'weather' | 'odds' | 'set_pieces' | 'discipline' | 'scorers';
export type Side = 'HOME' | 'AWAY';

export interface FixtureSummary {
  fixtureId: number;
  leagueId: number;
  leagueName: string;
  season: number;
  kickoffAt: string;
  homeTeam: string;
  awayTeam: string;
  status: string;
  venue: string | null;
}

export interface PublicForecast {
  variant: string;
  result: { HOME: number; DRAW: number; AWAY: number };
  correctScore: { scores: Array<{ home: number; away: number; p: number }>; other: number };
  totalGoals: { pOver: number; expected: number };
  totalCards: { pOver: number; expected: number };
  totalCorners: { pOver: number; expected: number };
  scorers: Array<{ playerId: string; p: number }>;
  decisionId: string | null;
}

export interface MatchOutcome {
  status: 'FINISHED' | 'CANCELLED' | 'ABANDONED';
  regulation?: { home: number; away: number };
  scorers?: string[];
  totalCards?: number;
  totalCorners?: number;
}

export interface FixtureContext {
  fixture: FixtureSummary & { homeTeamId: number; awayTeamId: number; venueCity?: string | null };
  predictionsOpen: boolean;
  squad: Array<{ id: string; name: string; side: Side }>;
  absences: Array<{ name: string; side: Side; type: string | null; reason: string | null }>;
  forecast: PublicForecast | null;
  market: Record<string, unknown> | null;
  outcome: MatchOutcome | null;
}

export interface ResearchBrief {
  fixtureId: number;
  specialty: Specialty;
  available: boolean;
  data: Record<string, unknown>;
  narrative: string;
  source: 'llm' | 'template';
  modelId: string | null;
  createdAt: string;
}

export interface FootballIntel {
  listFixtures(q: { from?: string; to?: string; league?: number }): Promise<FixtureSummary[]>;
  context(fixtureId: number): Promise<FixtureContext>;
  forecastNow(fixtureId: number): Promise<FixtureContext>;
  research(fixtureId: number, specialty: Specialty): Promise<ResearchBrief>;
}

export class AiInfraClient implements FootballIntel {
  private readonly secret: Buffer;

  constructor(
    private readonly opts: { url: string; keyId: string; secret: string; timeoutMs?: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.secret = Buffer.from(opts.secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (this.secret.length < 32) throw new Error('AI_INFRA_SECRET must decode to at least 32 bytes');
  }

  private async request<T>(method: 'GET' | 'POST', pathWithQuery: string): Promise<T> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(18).toString('base64url');
    const canonical = ['v1', method, pathWithQuery, timestamp, nonce, createHash('sha256').update('').digest('hex')].join('\n');
    const headers = {
      'x-aii-key-id': this.opts.keyId,
      'x-aii-timestamp': timestamp,
      'x-aii-nonce': nonce,
      'x-aii-signature': createHmac('sha256', this.secret).update(canonical).digest('hex'),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.url}${pathWithQuery}`, { method, headers, signal: controller.signal });
    } catch {
      throw upstreamUnavailable('match intelligence is unreachable');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: { error?: string; message?: string } | undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.ok && json !== undefined) return json as T;
    // Pass through what the player can act on; everything else is an upstream problem.
    if (res.status === 404) throw new AppError(404, 'not_found', 'fixture not found');
    if (res.status === 409) throw new AppError(409, 'conflict', json?.message ?? 'not available for this fixture');
    if (res.status === 400) throw new AppError(400, 'bad_request', json?.message ?? 'invalid request');
    throw upstreamUnavailable(`match intelligence answered ${res.status}`);
  }

  async listFixtures(q: { from?: string; to?: string; league?: number }) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    const s = p.toString();
    return (await this.request<{ fixtures: FixtureSummary[] }>('GET', `/v1/football/fixtures${s ? `?${s}` : ''}`)).fixtures;
  }

  context(fixtureId: number) {
    return this.request<FixtureContext>('GET', `/v1/football/fixtures/${fixtureId}/context`);
  }

  forecastNow(fixtureId: number) {
    return this.request<FixtureContext>('POST', `/v1/football/fixtures/${fixtureId}/forecast`);
  }

  research(fixtureId: number, specialty: Specialty) {
    return this.request<ResearchBrief>('GET', `/v1/football/fixtures/${fixtureId}/research/${specialty}`);
  }
}
