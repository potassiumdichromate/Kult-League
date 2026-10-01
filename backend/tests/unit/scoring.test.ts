import { describe, expect, it } from 'vitest';
import { Picks, picksProblems, settle } from '../../src/game/picks';

const picks: Picks = { outcome: 'HOME', score: { home: 2, away: 1 }, corners: 10, cards: 4, scorerId: '1001', scorerName: 'Bukayo Test' };
const finished = { status: 'FINISHED' as const, regulation: { home: 2, away: 1 }, scorers: ['1001', '2001'], totalCards: 4, totalCorners: 10 };

describe('settle', () => {
  it('awards full points for every exact market: 5 + 7 + 10 + 10 + 20 = 52', () => {
    const s = settle(picks, finished);
    expect(s).toMatchObject({ status: 'SETTLED', pointsX10: 520, exactHits: 5 });
  });

  it('gives half points when off by one, measured by total goal distance for the score', () => {
    const s = settle({ ...picks, score: { home: 3, away: 1 }, corners: 11, cards: 3 }, finished);
    expect(s.breakdown.score).toEqual({ result: 'CLOSE', pointsX10: 35 });
    expect(s.breakdown.corners).toEqual({ result: 'CLOSE', pointsX10: 50 });
    expect(s.breakdown.cards).toEqual({ result: 'CLOSE', pointsX10: 50 });
    expect(s.pointsX10).toBe(50 + 35 + 50 + 50 + 200);
    expect(s.exactHits).toBe(2);
  });

  it('misses beyond one, including a score off by one goal on each side', () => {
    const s = settle({ ...picks, outcome: 'DRAW', score: { home: 1, away: 2 }, corners: 13, cards: 6, scorerId: '2002' }, finished);
    expect(s.breakdown.score.result).toBe('MISS');
    expect(s.pointsX10).toBe(0);
  });

  it('voids the whole prediction for a cancelled match, and a single market when its data is missing', () => {
    expect(settle(picks, { status: 'CANCELLED' })).toMatchObject({ status: 'VOID', pointsX10: 0 });
    const s = settle(picks, { status: 'FINISHED', regulation: { home: 2, away: 1 }, scorers: ['1001'] });
    expect(s.breakdown.corners.result).toBe('VOID');
    expect(s.breakdown.cards.result).toBe('VOID');
    expect(s.pointsX10).toBe(50 + 70 + 200);
  });

  it('a goalless draw is a scorer miss, not a void', () => {
    const s = settle({ ...picks, outcome: 'DRAW', score: { home: 0, away: 0 } }, { ...finished, regulation: { home: 0, away: 0 }, scorers: [] });
    expect(s.breakdown.scorer.result).toBe('MISS');
    expect(s.breakdown.score.result).toBe('EXACT');
  });
});

describe('picksProblems', () => {
  const squad = new Set(['1001', '2001']);
  it('requires the score to agree with the outcome and the scorer to be in a squad', () => {
    expect(picksProblems(picks, squad)).toEqual([]);
    expect(picksProblems({ ...picks, outcome: 'AWAY' }, squad)).toEqual(['the exact score must agree with the outcome']);
    expect(picksProblems({ ...picks, scorerId: '9999' }, squad)).toEqual(['the goal scorer must be a player in either squad']);
    expect(picksProblems({ ...picks, scorerId: null }, squad)).toEqual([]);
  });
});
