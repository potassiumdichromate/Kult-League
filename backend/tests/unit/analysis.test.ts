import { describe, expect, it } from 'vitest';
import { analystReport, combine, syntheticScore, AnalystInput } from '../../src/game/analysis';
import { outcomeOf } from '../../src/game/picks';
import { SPECIALTIES } from '../../src/game/rules';
import { brief, context } from '../fixtures/match';

const analyst = (id: string, specialty: AnalystInput['specialty'], skill: number): AnalystInput => ({ id, name: `A ${id}`, specialty, skill });

describe('analyst reports', () => {
  it('recommend only their own markets, and always a consistent score', () => {
    const ctx = context();
    for (const s of SPECIALTIES) {
      const r = analystReport(analyst(`a-${s}`, s, 3), ctx, brief(s));
      const markets = Object.keys(r.recommendations).sort();
      const expected = { form: ['outcome', 'score'], lineups: ['outcome', 'scorer'], weather: ['corners', 'score'], odds: ['outcome', 'score'], set_pieces: ['corners'], discipline: ['cards'], scorers: ['scorer'] }[s];
      expect(markets).toEqual(expected);
      if (r.recommendations.score && r.recommendations.outcome) expect(outcomeOf(r.recommendations.score.pick)).toBe(r.recommendations.outcome.pick);
    }
  });

  it('are deterministic per analyst and fixture', () => {
    const a = analystReport(analyst('x', 'form', 2), context(), brief('form'));
    const b = analystReport(analyst('x', 'form', 2), context(), brief('form'));
    expect(a).toEqual(b);
  });

  it('read their own data: weather lowers goals and adds corners in a storm', () => {
    const r = analystReport(analyst('w', 'weather', 5), context(), brief('weather'));
    expect(r.signals.join(' ')).toMatch(/heavy rain/);
    expect(r.signals.join(' ')).toMatch(/corners/);
    const total = r.recommendations.score!.pick.home + r.recommendations.score!.pick.away;
    expect(total).toBeLessThanOrEqual(3);
  });

  it('only pick scorers from the squad', () => {
    const ctx = context();
    const ids = new Set(ctx.squad.map((p) => p.id));
    for (let i = 0; i < 30; i++) {
      const r = analystReport(analyst(`s${i}`, 'scorers', 1), ctx, brief('scorers'));
      expect(ids.has(r.recommendations.scorer!.pick.playerId)).toBe(true);
    }
  });

  it('skilled analysts read the favourite more often than juniors', () => {
    const hits = (skill: number) => {
      let n = 0;
      for (let i = 0; i < 300; i++) if (analystReport(analyst(`o${skill}-${i}`, 'odds', skill), context(), brief('odds')).recommendations.outcome!.pick === 'HOME') n++;
      return n / 300;
    };
    expect(hits(5)).toBeGreaterThan(hits(1) + 0.15);
  });

  it('work without data at reduced accuracy and say so', () => {
    const r = analystReport(analyst('n', 'odds', 3), context(), brief('odds', false));
    expect(r.note).toMatch(/Working without odds data/);
    expect(r.signals).toEqual([]);
  });
});

describe('CEO combination', () => {
  it('produces a full, consistent set of picks and marks gut calls', () => {
    const ctx = context();
    const reports = [analystReport(analyst('f', 'form', 4), ctx, brief('form')), analystReport(analyst('d', 'discipline', 3), ctx, brief('discipline'))];
    const c = combine(reports, ctx, { id: 'ceo-1', name: 'Kraken' });
    expect(outcomeOf(c.picks.score)).toBe(c.picks.outcome);
    expect(c.markets.outcome).toMatchObject({ covered: true, source: 'desk', support: ['f'] });
    expect(c.markets.cards.covered).toBe(true);
    expect(c.markets.corners).toMatchObject({ covered: false, source: 'ceo' });
    expect(c.markets.scorer.source).toBe('ceo');
    expect(c.summary).toMatch(/Kraken's desk/);
    expect(c.summary).toMatch(/Gut calls .*corners.*scorer/);
  });

  it('weights votes by skill', () => {
    const ctx = context();
    const base = { name: 'x', title: 't', brief: { available: true, narrative: '', source: 'template' as const }, signals: [], note: '' };
    const reports = [
      { ...base, analystId: 'senior', specialty: 'odds' as const, skill: 5, recommendations: { outcome: { pick: 'AWAY' as const, confidence: 0.3 } } },
      { ...base, analystId: 'j1', specialty: 'form' as const, skill: 2, recommendations: { outcome: { pick: 'HOME' as const, confidence: 0.5 } } },
      { ...base, analystId: 'j2', specialty: 'lineups' as const, skill: 2, recommendations: { outcome: { pick: 'HOME' as const, confidence: 0.5 } } },
    ];
    expect(combine(reports, ctx, { id: 'c', name: 'C' }).picks.outcome).toBe('AWAY');
  });

  it('an empty office still drafts picks from the CEO', () => {
    const c = combine([], context(), { id: 'c', name: 'Solo' });
    expect(Object.values(c.markets).every((m) => m.source === 'ceo')).toBe(true);
    expect(c.picks.scorerId).not.toBeNull();
  });

  it('synthetic scores agree with the outcome', () => {
    expect(syntheticScore('HOME', 3)).toEqual({ home: 2, away: 1 });
    expect(syntheticScore('AWAY', 1.2)).toEqual({ home: 0, away: 1 });
    expect(syntheticScore('DRAW', 2.6)).toEqual({ home: 1, away: 1 });
  });
});
