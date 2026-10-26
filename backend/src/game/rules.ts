import type { Specialty } from '../clients/ai-infra';

/** Game constants. Points are handled ×10 so every value is an integer. */

export const SPECIALTIES: readonly Specialty[] = ['form', 'lineups', 'weather', 'odds', 'set_pieces', 'discipline', 'scorers'];

export const MARKETS = ['outcome', 'score', 'corners', 'cards', 'scorer'] as const;
export type Market = (typeof MARKETS)[number];

/** Full points per market, ×10: Outcome 5, Goals (exact score) 7, Corners 10, Cards 10, Goal Scorer 20. */
export const MARKET_POINTS_X10: Record<Market, number> = { outcome: 50, score: 70, corners: 100, cards: 100, scorer: 200 };

/** Which markets an analyst of each specialty advises on. */
export const SPECIALTY_MARKETS: Record<Specialty, readonly Market[]> = {
  form: ['outcome', 'score'],
  lineups: ['outcome', 'scorer'],
  weather: ['score', 'corners'],
  odds: ['outcome', 'score'],
  set_pieces: ['corners'],
  discipline: ['cards'],
  scorers: ['scorer'],
};

export const SPECIALTY_TITLES: Record<Specialty, string> = {
  form: 'Form Analyst',
  lineups: 'Team News Scout',
  weather: 'Weather & Pitch Analyst',
  odds: 'Market Analyst',
  set_pieces: 'Set-Piece Coach',
  discipline: 'Discipline Analyst',
  scorers: 'Striker Scout',
};

/**
 * ai-infrastructure grades cards and corners as over/under on fixed lines,
 * so a Mind's exact totals go on the record as the side of these lines.
 */
export const RECORD_LINES = { totalCards: 4.5, totalCorners: 9.5 } as const;

export const STARTING_CREDITS = 1500;
/** Credits earned per point (points ×10 → credits ×1). */
export const CREDITS_PER_POINT_X10 = 1;

/** Index = skill (1–5). */
export const HIRE_COST = [0, 80, 150, 260, 420, 650] as const;
export const WEEKLY_SALARY = [0, 20, 40, 70, 110, 160] as const;
export const MAX_SKILL = 5;
/** XP an analyst needs to rise from `skill` to `skill + 1`. */
export const xpToNextSkill = (skill: number) => skill * 100;

export const TALENT_POOL_SIZE = 10;

/** Agency level from all-time points: 0, 50, 150, 300, 500 → levels 1–5. */
const LEVEL_POINTS = [0, 50, 150, 300, 500];
export function agencyLevel(totalPointsX10: number): number {
  const points = totalPointsX10 / 10;
  let level = 1;
  for (let i = 1; i < LEVEL_POINTS.length; i++) if (points >= LEVEL_POINTS[i]!) level = i + 1;
  return level;
}
/** Desks (analyst seats) in the office: 3 at level 1, one more per level, at most 7. */
export const desksForLevel = (level: number) => Math.min(7, 2 + level);
export const nextLevelPoints = (level: number) => LEVEL_POINTS[level] ?? null;

/** ISO-8601 week of a UTC instant, e.g. "2026-W40". */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day); // Thursday decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Monday 00:00 UTC of the week after `d`'s ISO week. */
export function nextWeekStart(d: Date): Date {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 8 - day);
  return t;
}
