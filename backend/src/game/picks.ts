import { z } from 'zod';
import type { MatchOutcome } from '../clients/ai-infra';
import { Market, MARKET_POINTS_X10 } from './rules';

export type Outcome = 'HOME' | 'DRAW' | 'AWAY';

export interface Picks {
  outcome: Outcome;
  score: { home: number; away: number };
  corners: number;
  cards: number;
  scorerId: string | null;
  scorerName: string | null;
}

const goals = z.number().int().min(0).max(15);

/** A CEO edit: any subset of markets. Merged into the draft, then validated whole. */
export const picksEdit = z
  .object({
    outcome: z.enum(['HOME', 'DRAW', 'AWAY']).optional(),
    score: z.object({ home: goals, away: goals }).strict().optional(),
    corners: z.number().int().min(0).max(30).optional(),
    cards: z.number().int().min(0).max(20).optional(),
    scorerId: z.string().min(1).max(100).nullable().optional(),
  })
  .strict();
export type PicksEdit = z.infer<typeof picksEdit>;

export const outcomeOf = (s: { home: number; away: number }): Outcome => (s.home > s.away ? 'HOME' : s.home < s.away ? 'AWAY' : 'DRAW');

/** Problems with a full set of picks, or [] when it is valid. */
export function picksProblems(p: Picks, squadIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (outcomeOf(p.score) !== p.outcome) problems.push('the exact score must agree with the outcome');
  if (p.scorerId !== null && !squadIds.has(p.scorerId)) problems.push('the goal scorer must be a player in either squad');
  return problems;
}

export type MarketResult = 'EXACT' | 'CLOSE' | 'MISS' | 'VOID';
export interface Settlement {
  status: 'SETTLED' | 'VOID';
  pointsX10: number;
  exactHits: number;
  breakdown: Record<Market, { result: MarketResult; pointsX10: number }>;
}

/**
 * Scores a locked prediction against the regulation-time outcome.
 *   Outcome 5 · Goals 7 (exact score; half when one goal off in total) ·
 *   Corners 10 and Cards 10 (half when off by one) · Goal Scorer 20 (anytime, own goals excluded)
 * A cancelled or abandoned match voids the prediction; a market whose
 * result data is missing voids that market only.
 */
export function settle(p: Picks, o: MatchOutcome): Settlement {
  const breakdown = {} as Settlement['breakdown'];
  if (o.status !== 'FINISHED' || !o.regulation) {
    for (const m of Object.keys(MARKET_POINTS_X10) as Market[]) breakdown[m] = { result: 'VOID', pointsX10: 0 };
    return { status: 'VOID', pointsX10: 0, exactHits: 0, breakdown };
  }
  const full = (m: Market): { result: MarketResult; pointsX10: number } => ({ result: 'EXACT', pointsX10: MARKET_POINTS_X10[m] });
  const half = (m: Market): { result: MarketResult; pointsX10: number } => ({ result: 'CLOSE', pointsX10: MARKET_POINTS_X10[m] / 2 });
  const miss = { result: 'MISS' as const, pointsX10: 0 };
  const voided = { result: 'VOID' as const, pointsX10: 0 };
  const closeness = (m: Market, picked: number, actual: number | undefined) =>
    actual === undefined ? voided : picked === actual ? full(m) : Math.abs(picked - actual) === 1 ? half(m) : miss;

  const r = o.regulation;
  breakdown.outcome = outcomeOf(r) === p.outcome ? full('outcome') : miss;
  const goalDistance = Math.abs(p.score.home - r.home) + Math.abs(p.score.away - r.away);
  breakdown.score = goalDistance === 0 ? full('score') : goalDistance === 1 ? half('score') : miss;
  breakdown.corners = closeness('corners', p.corners, o.totalCorners);
  breakdown.cards = closeness('cards', p.cards, o.totalCards);
  breakdown.scorer = o.scorers === undefined ? voided : p.scorerId !== null && o.scorers.includes(p.scorerId) ? full('scorer') : miss;

  const values = Object.values(breakdown);
  return {
    status: 'SETTLED',
    pointsX10: values.reduce((a, b) => a + b.pointsX10, 0),
    exactHits: values.filter((b) => b.result === 'EXACT').length,
    breakdown,
  };
}
