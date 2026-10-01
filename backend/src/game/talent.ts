import type { Specialty } from '../clients/ai-infra';
import { Rng } from './rng';
import { HIRE_COST, SPECIALTIES, SPECIALTY_MARKETS, SPECIALTY_TITLES, TALENT_POOL_SIZE, WEEKLY_SALARY } from './rules';

/**
 * The weekly talent pool: candidates an agency can hire this ISO week.
 * Generated from (agency, week), so it is stable all week without storage
 * and refreshes every Monday. Every specialty appears at least once.
 */

export interface Candidate {
  candidateKey: string;
  name: string;
  specialty: Specialty;
  title: string;
  markets: readonly string[];
  skill: number;
  hireCost: number;
  weeklySalary: number;
  style: string;
}

const FIRST = ['Ada', 'Bruno', 'Chen', 'Dara', 'Emil', 'Farah', 'Gus', 'Hana', 'Ivo', 'Jules', 'Kofi', 'Lena', 'Milo', 'Nia', 'Oskar', 'Pia', 'Quinn', 'Rafa', 'Sana', 'Theo', 'Uma', 'Vik', 'Wren', 'Yara', 'Zed'];
const LAST = ['Pixel', 'Byte', 'Grid', 'Vector', 'Sprite', 'Bitwise', 'Hex', 'Raster', 'Voxel', 'Kernel', 'Cache', 'Buffer', 'Packet', 'Shader', 'Frame'];

const STYLES: Record<Specialty, readonly string[]> = {
  form: ['streak hunter', 'home-and-away purist', 'goal-difference nerd'],
  lineups: ['training-ground insider', 'injury-table reader', 'rotation spotter'],
  weather: ['wind watcher', 'rain-delay veteran', 'pitch inspector'],
  odds: ['line mover', 'sharp-money tracker', 'value seeker'],
  set_pieces: ['corner counter', 'dead-ball specialist', 'wide-play tracker'],
  discipline: ['referee profiler', 'derby-heat reader', 'foul-count grinder'],
  scorers: ['box-presence scout', 'penalty-taker tracker', 'hot-streak spotter'],
};

/** Skill 1–5, rarer at the top. */
const SKILL_WEIGHTS = [0, 30, 30, 22, 13, 5];

export function talentPool(agencyId: string, week: string): Candidate[] {
  const rng = new Rng(`talent:${agencyId}:${week}`);
  const specialties: Specialty[] = rng.shuffle(SPECIALTIES);
  while (specialties.length < TALENT_POOL_SIZE) specialties.push(rng.pick(SPECIALTIES));
  return specialties.map((specialty, i) => {
    const skill = rng.weighted(SKILL_WEIGHTS);
    // ±10% so two candidates of the same skill are not identical deals.
    const hireCost = Math.round((HIRE_COST[skill]! * (0.9 + rng.next() * 0.2)) / 5) * 5;
    return {
      candidateKey: `${week}:${i}`,
      name: `${rng.pick(FIRST)} ${rng.pick(LAST)}`,
      specialty,
      title: SPECIALTY_TITLES[specialty],
      markets: SPECIALTY_MARKETS[specialty],
      skill,
      hireCost,
      weeklySalary: WEEKLY_SALARY[skill]!,
      style: rng.pick(STYLES[specialty]),
    };
  });
}
