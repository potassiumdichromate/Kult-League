import type { FixtureContext, ResearchBrief, Specialty } from '../../src/clients/ai-infra';

export const FIXTURE_ID = 1035037;
export const KICKOFF = '2026-10-03T14:00:00.000Z';

export function context(over: Partial<FixtureContext> = {}): FixtureContext {
  return {
    fixture: {
      fixtureId: FIXTURE_ID, leagueId: 39, leagueName: 'Premier League', season: 2026, kickoffAt: KICKOFF,
      homeTeam: 'Arsenal', awayTeam: 'Chelsea', homeTeamId: 42, awayTeamId: 49, status: 'NS', venue: 'Emirates Stadium', venueCity: 'London',
    },
    predictionsOpen: true,
    squad: [
      { id: '1001', name: 'Bukayo Test', side: 'HOME' },
      { id: '1002', name: 'Martin Test', side: 'HOME' },
      { id: '2001', name: 'Cole Test', side: 'AWAY' },
      { id: '2002', name: 'Enzo Test', side: 'AWAY' },
    ],
    absences: [{ name: 'Injured Defender', side: 'HOME', type: 'Missing Fixture', reason: 'Hamstring' }],
    forecast: {
      variant: 'llm-ensemble-1',
      result: { HOME: 0.52, DRAW: 0.26, AWAY: 0.22 },
      correctScore: { scores: [{ home: 2, away: 1, p: 0.11 }, { home: 1, away: 0, p: 0.1 }, { home: 1, away: 1, p: 0.1 }, { home: 2, away: 0, p: 0.08 }, { home: 0, away: 1, p: 0.06 }], other: 0.55 },
      totalGoals: { pOver: 0.56, expected: 2.8 },
      totalCards: { pOver: 0.5, expected: 4.4 },
      totalCorners: { pOver: 0.52, expected: 10.1 },
      scorers: [{ playerId: '1001', p: 0.45 }, { playerId: '2001', p: 0.33 }, { playerId: '1002', p: 0.2 }],
      decisionId: 'dec-1',
    },
    market: null,
    outcome: null,
    ...over,
  };
}

const DATA: Record<Specialty, Record<string, unknown>> = {
  form: { available: true, home: { played: 5, wins: 4, draws: 1, losses: 0, goalsFor: 11, goalsAgainst: 3 }, away: { played: 5, wins: 1, draws: 2, losses: 2, goalsFor: 5, goalsAgainst: 7 } },
  lineups: { available: true, absentCount: { home: 1, away: 0 }, availablePlayers: { home: 2, away: 2 } },
  weather: { available: true, conditions: 'heavy rain', windKmh: 34, rainMm: 4.2, temperatureC: 9 },
  odds: { available: true, bookmakers: 3, impliedPct: { home: 48, draw: 27, away: 25 }, overGoalsPct: { line: 2.5, pct: 55 } },
  set_pieces: { available: true, home: { matches: 10, avgFor: 6.1, avgAgainst: 4.2 }, away: { matches: 10, avgFor: 5, avgAgainst: 5.3 }, expectedTotal: 10.4 },
  discipline: { available: true, home: { matches: 10, avgFor: 1.8, avgAgainst: 2.1 }, away: { matches: 10, avgFor: 2.4, avgAgainst: 1.9 }, expectedTotal: 4.4 },
  scorers: { available: true, candidates: [{ playerId: '1001', player: 'Bukayo Test', scoreChancePct: 45 }, { playerId: '2001', player: 'Cole Test', scoreChancePct: 33 }] },
};

export function brief(specialty: Specialty, available = true): ResearchBrief {
  return {
    fixtureId: FIXTURE_ID,
    specialty,
    available,
    data: available ? DATA[specialty] : { available: false, reason: 'no data yet' },
    narrative: `${specialty} brief`,
    source: 'template',
    modelId: null,
    createdAt: '2026-10-02T10:00:00.000Z',
  };
}
