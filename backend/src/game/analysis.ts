import type { FixtureContext, PublicForecast, ResearchBrief, Specialty } from '../clients/ai-infra';
import { Outcome, outcomeOf, Picks } from './picks';
import { Rng } from './rng';
import { Market, SPECIALTY_MARKETS, SPECIALTY_TITLES } from './rules';

/**
 * How an agency analyses a match.
 *
 * Every analyst starts from the shared 0G forecast but reads it through
 * their own research brief — the form analyst tilts the result by recent
 * points per game, the market analyst trusts bookmaker prices, the weather
 * analyst lowers goals in wind and rain, and so on. Skill (1–5) decides how
 * often they read their signal cleanly; the rest of the time they take a
 * plausible but less likely view. Reads are seeded by (analyst, fixture),
 * so re-running an analysis without changing staff gives the same reports.
 *
 * The CEO then combines the reports market by market with a skill-weighted
 * vote. Markets nobody covers get the CEO's own gut call: a low-skill read.
 */

export interface AnalystInput {
  id: string;
  name: string;
  specialty: Specialty;
  skill: number;
}

type Probs = Record<Outcome, number>;
export interface Recommendation<T> {
  pick: T;
  confidence: number;
}
export interface Recommendations {
  outcome?: Recommendation<Outcome>;
  score?: Recommendation<{ home: number; away: number }>;
  corners?: Recommendation<number>;
  cards?: Recommendation<number>;
  scorer?: Recommendation<{ playerId: string; name: string }>;
}

export interface AnalystReport {
  analystId: string;
  name: string;
  title: string;
  specialty: Specialty;
  skill: number;
  brief: { available: boolean; narrative: string; source: 'llm' | 'template' | 'none' };
  /** What this analyst's own data changed relative to the shared forecast. */
  signals: string[];
  recommendations: Recommendations;
  note: string;
}

export interface CombinedMarket {
  covered: boolean;
  /** Analyst ids whose recommendation matches the combined pick. */
  support: string[];
  source: 'desk' | 'ceo';
}

export interface CombinedAnalysis {
  picks: Picks;
  markets: Record<Market, CombinedMarket>;
  summary: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const OUTCOMES: Outcome[] = ['HOME', 'DRAW', 'AWAY'];
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});

function normalise(p: Probs): Probs {
  const s = p.HOME + p.DRAW + p.AWAY;
  return { HOME: p.HOME / s, DRAW: p.DRAW / s, AWAY: p.AWAY / s };
}

/** Probability that a skill-`s` analyst reads their signal cleanly. */
export const accuracy = (skill: number, hasData: boolean) => clamp(0.45 + 0.1 * skill - (hasData ? 0 : 0.15), 0.25, 0.95);

function badWeather(d: Record<string, unknown>): boolean {
  const cond = String(d.conditions ?? '');
  return (num(d.windKmh) ?? 0) >= 30 || (num(d.rainMm) ?? 0) >= 2 || /snow|thunder|heavy/.test(cond);
}

/** A score consistent with `outcome` near `expectedGoals`, for when the forecast lists none. */
export function syntheticScore(outcome: Outcome, expectedGoals: number): { home: number; away: number } {
  if (outcome === 'DRAW') {
    const k = clamp(Math.round(expectedGoals / 2), 0, 3);
    return { home: k, away: k };
  }
  const total = clamp(Math.round(expectedGoals), 1, 6);
  const loser = Math.floor((total - 1) / 2);
  const winner = total - loser;
  return outcome === 'HOME' ? { home: winner, away: loser } : { home: loser, away: winner };
}

interface View {
  probs: Probs;
  expectedGoals: number;
  corners: number;
  cards: number;
  scorers: Array<{ playerId: string; name: string; p: number }>;
  signals: string[];
}

/** The shared forecast seen through one specialty's brief. */
function viewFor(specialty: Specialty, f: PublicForecast, ctx: FixtureContext, brief: ResearchBrief | undefined): View {
  const names = new Map(ctx.squad.map((p) => [p.id, p.name]));
  const v: View = {
    probs: { ...f.result },
    expectedGoals: f.totalGoals.expected,
    corners: f.totalCorners.expected,
    cards: f.totalCards.expected,
    scorers: f.scorers.filter((s) => names.has(s.playerId)).map((s) => ({ playerId: s.playerId, name: names.get(s.playerId)!, p: s.p })),
    signals: [],
  };
  const d = brief?.available ? brief.data : undefined;
  if (!d) return v;
  const home = ctx.fixture.homeTeam;
  const away = ctx.fixture.awayTeam;

  switch (specialty) {
    case 'form': {
      const h = rec(d.home);
      const a = rec(d.away);
      const ppg = (t: Record<string, unknown>) => {
        const played = num(t.played) ?? 0;
        return played > 0 ? (3 * (num(t.wins) ?? 0) + (num(t.draws) ?? 0)) / played : undefined;
      };
      const ph = ppg(h);
      const pa = ppg(a);
      if (ph !== undefined && pa !== undefined) {
        const tilt = clamp(((ph - pa) / 3) * 0.15, -0.1, 0.1);
        v.probs = normalise({ HOME: Math.max(0.02, v.probs.HOME + tilt), DRAW: v.probs.DRAW, AWAY: Math.max(0.02, v.probs.AWAY - tilt) });
        if (Math.abs(tilt) >= 0.02) v.signals.push(`${tilt > 0 ? home : away} in better recent form`);
        const gpg = ((num(h.goalsFor) ?? 0) / (num(h.played) || 1) + (num(a.goalsFor) ?? 0) / (num(a.played) || 1));
        v.expectedGoals = (v.expectedGoals + gpg) / 2;
      }
      break;
    }
    case 'lineups': {
      const c = rec(d.absentCount);
      const ah = num(c.home) ?? 0;
      const aa = num(c.away) ?? 0;
      const shift = clamp((aa - ah) * 0.02, -0.1, 0.1);
      if (shift !== 0) {
        v.probs = normalise({ HOME: Math.max(0.02, v.probs.HOME + shift), DRAW: v.probs.DRAW, AWAY: Math.max(0.02, v.probs.AWAY - shift) });
        v.signals.push(`${shift > 0 ? away : home} missing more players`);
      }
      break;
    }
    case 'weather': {
      if (badWeather(d)) {
        v.expectedGoals = Math.max(0.5, v.expectedGoals - 0.4);
        v.signals.push(`${String(d.conditions ?? 'rough')} conditions should slow the game`);
      }
      if ((num(d.windKmh) ?? 0) >= 25) {
        v.corners += 1;
        v.signals.push('wind pushes more balls out for corners');
      }
      break;
    }
    case 'odds': {
      const ip = rec(d.impliedPct);
      const [h, dr, a] = [num(ip.home), num(ip.draw), num(ip.away)];
      if (h !== undefined && dr !== undefined && a !== undefined && h + dr + a > 0) {
        v.probs = normalise({ HOME: h, DRAW: dr, AWAY: a });
        v.signals.push('reading bookmaker prices');
      }
      const og = num(rec(d.overGoalsPct).pct);
      if (og !== undefined) v.expectedGoals = Math.max(0.5, v.expectedGoals + ((og - 50) / 50) * 0.5);
      break;
    }
    case 'set_pieces':
    case 'discipline': {
      const key = specialty === 'set_pieces' ? 'corners' : 'cards';
      const h = rec(d.home);
      const a = rec(d.away);
      const hist = [num(h.avgFor), num(h.avgAgainst), num(a.avgFor), num(a.avgAgainst)];
      const fromHistory = hist.every((x) => x !== undefined) ? (hist as number[]).reduce((s, x) => s + x, 0) / 2 : undefined;
      const expected = num(d.expectedTotal);
      const estimate = expected !== undefined && fromHistory !== undefined ? (expected + fromHistory) / 2 : expected ?? fromHistory;
      if (estimate !== undefined) {
        v[key] = estimate;
        v.signals.push(`recent ${key} averages point to about ${Math.round(estimate)}`);
      }
      break;
    }
    case 'scorers': {
      const cands = Array.isArray(d.candidates) ? d.candidates.map(rec) : [];
      const list = cands
        .filter((c) => typeof c.playerId === 'string' && names.has(c.playerId))
        .map((c) => ({ playerId: c.playerId as string, name: names.get(c.playerId as string)!, p: (num(c.scoreChancePct) ?? 0) / 100 }));
      if (list.length > 0) {
        v.scorers = list;
        v.signals.push(`${list[0]!.name} leads the scorer chart`);
      }
      break;
    }
  }
  return v;
}

function readOutcome(rng: Rng, probs: Probs, acc: number): Outcome {
  const best = OUTCOMES.reduce((a, b) => (probs[b] > probs[a] ? b : a));
  return rng.next() < acc ? best : OUTCOMES[rng.weighted(OUTCOMES.map((o) => probs[o]))]!;
}

function readScore(rng: Rng, outcome: Outcome, expectedGoals: number, f: PublicForecast, acc: number): { home: number; away: number } {
  const options = f.correctScore.scores
    .filter((s) => outcomeOf(s) === outcome)
    .map((s) => ({ s: { home: s.home, away: s.away }, w: s.p * Math.exp(-Math.abs(s.home + s.away - expectedGoals) * 0.5) }));
  if (options.length === 0) return syntheticScore(outcome, expectedGoals);
  const i = rng.next() < acc ? options.reduce((bi, o, j, arr) => (o.w > arr[bi]!.w ? j : bi), 0) : rng.weighted(options.map((o) => o.w));
  return options[i]!.s;
}

function readCount(rng: Rng, expected: number, skill: number, max: number): number {
  return clamp(Math.round(rng.normal(expected, (6 - skill) * 0.5)), 0, max);
}

function readScorer(rng: Rng, scorers: View['scorers'], acc: number): { playerId: string; name: string; p: number } | undefined {
  if (scorers.length === 0) return undefined;
  const top = [...scorers].sort((a, b) => b.p - a.p).slice(0, 5);
  return rng.next() < acc ? top[0] : top[rng.weighted(top.map((s) => s.p))];
}

function recommend(markets: readonly Market[], view: View, f: PublicForecast, rng: Rng, skill: number, acc: number): Recommendations {
  const r: Recommendations = {};
  // Outcome is read first because the score must agree with it.
  const outcome = readOutcome(rng, view.probs, acc);
  if (markets.includes('outcome')) r.outcome = { pick: outcome, confidence: round2(view.probs[outcome]) };
  if (markets.includes('score')) r.score = { pick: readScore(rng, outcome, view.expectedGoals, f, acc), confidence: round2(acc) };
  if (markets.includes('corners')) r.corners = { pick: readCount(rng, view.corners, skill, 30), confidence: round2(acc) };
  if (markets.includes('cards')) r.cards = { pick: readCount(rng, view.cards, skill, 20), confidence: round2(acc) };
  if (markets.includes('scorer')) {
    const s = readScorer(rng, view.scorers, acc);
    if (s) r.scorer = { pick: { playerId: s.playerId, name: s.name }, confidence: round2(s.p) };
  }
  return r;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function analystReport(a: AnalystInput, ctx: FixtureContext, brief: ResearchBrief | undefined): AnalystReport {
  const f = ctx.forecast!;
  const hasData = !!brief?.available;
  const view = viewFor(a.specialty, f, ctx, brief);
  const rng = new Rng(`read:${a.id}:${ctx.fixture.fixtureId}`);
  const recommendations = recommend(SPECIALTY_MARKETS[a.specialty], view, f, rng, a.skill, accuracy(a.skill, hasData));
  return {
    analystId: a.id,
    name: a.name,
    title: SPECIALTY_TITLES[a.specialty],
    specialty: a.specialty,
    skill: a.skill,
    brief: brief ? { available: brief.available, narrative: brief.narrative, source: brief.source } : { available: false, narrative: 'No brief could be fetched.', source: 'none' },
    signals: view.signals,
    recommendations,
    note: hasData ? describe(recommendations, ctx) : `Working without ${a.specialty.replace('_', ' ')} data, so this read leans on the shared forecast. ${describe(recommendations, ctx)}`,
  };
}

function outcomeLabel(o: Outcome, ctx: FixtureContext): string {
  return o === 'DRAW' ? 'a draw' : `${o === 'HOME' ? ctx.fixture.homeTeam : ctx.fixture.awayTeam} to win`;
}

function describe(r: Recommendations, ctx: FixtureContext): string {
  const parts: string[] = [];
  if (r.outcome) parts.push(outcomeLabel(r.outcome.pick, ctx));
  if (r.score) parts.push(`${r.score.pick.home}-${r.score.pick.away}`);
  if (r.corners) parts.push(`${r.corners.pick} corners`);
  if (r.cards) parts.push(`${r.cards.pick} cards`);
  if (r.scorer) parts.push(`${r.scorer.pick.name} to score`);
  return parts.length ? `Recommends ${parts.join(', ')}.` : 'No recommendation possible with the data available.';
}

/** Skill-weighted plurality; ties go to the first key in `tiebreak` order. */
function vote<K extends string>(entries: Array<{ key: K; weight: number }>, tiebreak: (a: K, b: K) => number): K | undefined {
  const tally = new Map<K, number>();
  for (const e of entries) tally.set(e.key, (tally.get(e.key) ?? 0) + e.weight);
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || tiebreak(a[0], b[0]))[0]?.[0];
}

export function combine(reports: AnalystReport[], ctx: FixtureContext, ceo: { id: string; name: string }): CombinedAnalysis {
  const f = ctx.forecast!;
  const gut = new Rng(`ceo:${ceo.id}:${ctx.fixture.fixtureId}`);
  const gutView = viewFor('form', f, ctx, undefined);
  const gutAcc = accuracy(1, false);
  const markets = {} as Record<Market, CombinedMarket>;
  const withRec = <M extends keyof Recommendations>(m: M) => reports.filter((r) => r.recommendations[m] !== undefined);

  // Outcome
  const outcomeVoters = withRec('outcome');
  const outcome =
    vote(outcomeVoters.map((r) => ({ key: r.recommendations.outcome!.pick, weight: r.skill })), (a, b) => f.result[b] - f.result[a]) ??
    readOutcome(gut, gutView.probs, gutAcc);
  markets.outcome = { covered: outcomeVoters.length > 0, source: outcomeVoters.length ? 'desk' : 'ceo', support: outcomeVoters.filter((r) => r.recommendations.outcome!.pick === outcome).map((r) => r.analystId) };

  // Exact score: only scores that agree with the combined outcome count.
  const scoreVoters = withRec('score').filter((r) => outcomeOf(r.recommendations.score!.pick) === outcome);
  const key = (s: { home: number; away: number }) => `${s.home}-${s.away}`;
  const prob = (k: string) => f.correctScore.scores.find((s) => key(s) === k)?.p ?? 0;
  const votedScore = vote(scoreVoters.map((r) => ({ key: key(r.recommendations.score!.pick), weight: r.skill })), (a, b) => prob(b) - prob(a));
  const score = votedScore ? { home: Number(votedScore.split('-')[0]), away: Number(votedScore.split('-')[1]) } : readScore(gut, outcome, gutView.expectedGoals, f, gutAcc);
  markets.score = { covered: withRec('score').length > 0, source: scoreVoters.length ? 'desk' : 'ceo', support: scoreVoters.filter((r) => key(r.recommendations.score!.pick) === key(score)).map((r) => r.analystId) };

  // Counts: skill-weighted mean.
  const count = (m: 'corners' | 'cards', fallback: number, max: number) => {
    const voters = withRec(m);
    if (voters.length === 0) {
      markets[m] = { covered: false, source: 'ceo', support: [] };
      return readCount(gut, fallback, 1, max);
    }
    const w = voters.reduce((s, r) => s + r.skill, 0);
    const value = clamp(Math.round(voters.reduce((s, r) => s + r.recommendations[m]!.pick * r.skill, 0) / w), 0, max);
    markets[m] = { covered: true, source: 'desk', support: voters.filter((r) => r.recommendations[m]!.pick === value).map((r) => r.analystId) };
    return value;
  };
  const corners = count('corners', f.totalCorners.expected, 30);
  const cards = count('cards', f.totalCards.expected, 20);

  // Scorer
  const scorerVoters = withRec('scorer');
  const fp = (id: string) => f.scorers.find((s) => s.playerId === id)?.p ?? 0;
  const votedScorer = vote(scorerVoters.map((r) => ({ key: r.recommendations.scorer!.pick.playerId, weight: r.skill })), (a, b) => fp(b) - fp(a));
  const scorer = votedScorer
    ? scorerVoters.find((r) => r.recommendations.scorer!.pick.playerId === votedScorer)!.recommendations.scorer!.pick
    : readScorer(gut, gutView.scorers, gutAcc);
  markets.scorer = { covered: scorerVoters.length > 0, source: scorerVoters.length ? 'desk' : 'ceo', support: scorerVoters.filter((r) => r.recommendations.scorer!.pick.playerId === scorer?.playerId).map((r) => r.analystId) };

  const picks: Picks = { outcome, score, corners, cards, scorerId: scorer?.playerId ?? null, scorerName: scorer?.name ?? null };
  const gutCalls = (Object.keys(markets) as Market[]).filter((m) => markets[m].source === 'ceo');
  const summary =
    `${ceo.name}'s desk: ${outcomeLabel(outcome, ctx)}, ${score.home}-${score.away}, ${corners} corners, ${cards} cards` +
    (picks.scorerName ? `, ${picks.scorerName} to score.` : '.') +
    (reports.length ? ` Built from ${reports.length} analyst report${reports.length === 1 ? '' : 's'}.` : ' No analysts on staff.') +
    (gutCalls.length ? ` Gut calls (no analyst covers them): ${gutCalls.join(', ')}.` : '');
  return { picks, markets, summary };
}
