import type { Pool, PoolClient } from 'pg';
import type { ArenaAgent, ArenaIdentity } from '../clients/ai-arena';
import type { Specialty } from '../clients/ai-infra';
import type { Candidate } from './talent';
import type { Picks, Settlement } from './picks';

/** All SQL for the game. Credit changes go through `applyCredit` inside a transaction holding the agency row lock. */

export interface PlayerRow {
  userId: string;
  walletAddress: string | null;
  username: string | null;
  agents: ArenaAgent[];
}

export interface AgencyRow {
  id: string;
  ownerUserId: string;
  name: string;
  ceoAgentId: string;
  ceoName: string;
  ceoClan: string | null;
  credits: number;
  payrollWeek: string;
  createdAt: Date;
}

export interface AnalystRow {
  id: string;
  agencyId: string;
  candidateKey: string;
  name: string;
  specialty: Specialty;
  skill: number;
  xp: number;
  hireCost: number;
  weeklySalary: number;
  style: string;
  hiredAt: Date;
  firedAt: Date | null;
  fireReason: 'fired' | 'unpaid' | null;
}

export type PredictionStatus = 'DRAFT' | 'LOCKED' | 'SETTLED' | 'VOID';
export interface PredictionRow {
  id: string;
  agencyId: string;
  fixtureId: number;
  leagueName: string;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: Date;
  lockAt: Date;
  week: string;
  status: PredictionStatus;
  picks: Picks;
  analysisId: string | null;
  edited: boolean;
  lockedAt: Date | null;
  autoLocked: boolean;
  settledAt: Date | null;
  pointsX10: number;
  exactHits: number;
  breakdown: Settlement['breakdown'] | null;
}

export interface AnalysisRow {
  id: string;
  agencyId: string;
  fixtureId: number;
  reports: unknown;
  combined: unknown;
  createdAt: Date;
}

export interface LeaderboardRow {
  rank: number;
  agencyId: string;
  agencyName: string;
  ceoName: string;
  ceoClan: string | null;
  pointsX10: number;
  exactHits: number;
  predictions: number;
}

export type CreditKind = 'grant' | 'hire' | 'salary' | 'winnings';

const agencyCols = `id, owner_user_id AS "ownerUserId", name, ceo_agent_id AS "ceoAgentId", ceo_name AS "ceoName", ceo_clan AS "ceoClan",
  credits::float8 AS credits, payroll_week AS "payrollWeek", created_at AS "createdAt"`;
const analystCols = `id, agency_id AS "agencyId", candidate_key AS "candidateKey", name, specialty, skill, xp, hire_cost AS "hireCost",
  weekly_salary AS "weeklySalary", style, hired_at AS "hiredAt", fired_at AS "firedAt", fire_reason AS "fireReason"`;
const predictionCols = `id, agency_id AS "agencyId", fixture_id::float8 AS "fixtureId", league_name AS "leagueName", home_team AS "homeTeam",
  away_team AS "awayTeam", kickoff_at AS "kickoffAt", lock_at AS "lockAt", week, status, picks, analysis_id AS "analysisId", edited,
  locked_at AS "lockedAt", auto_locked AS "autoLocked", settled_at AS "settledAt", points_x10 AS "pointsX10", exact_hits AS "exactHits", breakdown`;

export class GameStore {
  constructor(private readonly pool: Pool) {}

  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  // ── players ──────────────────────────────────────────────────────────
  async upsertPlayer(id: ArenaIdentity): Promise<void> {
    await this.pool.query(
      `INSERT INTO pixel_agency.players (user_id, wallet_address, username, agents)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET wallet_address = EXCLUDED.wallet_address, username = EXCLUDED.username,
         agents = EXCLUDED.agents, agents_synced_at = now(), last_seen_at = now()`,
      [id.userId, id.walletAddress, id.username, JSON.stringify(id.agents)],
    );
  }

  async getPlayer(userId: string): Promise<PlayerRow | undefined> {
    const { rows } = await this.pool.query<PlayerRow>(
      `SELECT user_id AS "userId", wallet_address AS "walletAddress", username, agents FROM pixel_agency.players WHERE user_id = $1`,
      [userId],
    );
    return rows[0];
  }

  // ── agencies ─────────────────────────────────────────────────────────
  async agencyByOwner(userId: string): Promise<AgencyRow | undefined> {
    const { rows } = await this.pool.query<AgencyRow>(`SELECT ${agencyCols} FROM pixel_agency.agencies WHERE owner_user_id = $1`, [userId]);
    return rows[0];
  }

  async lockAgency(c: PoolClient, agencyId: string): Promise<AgencyRow> {
    const { rows } = await c.query<AgencyRow>(`SELECT ${agencyCols} FROM pixel_agency.agencies WHERE id = $1 FOR UPDATE`, [agencyId]);
    if (!rows[0]) throw new Error(`agency ${agencyId} not found`);
    return rows[0];
  }

  /** Returns undefined when the owner already has an agency or the name is taken (unique violations). */
  async createAgency(a: { ownerUserId: string; name: string; ceo: ArenaAgent; credits: number; week: string }): Promise<AgencyRow | 'name_taken' | 'exists'> {
    try {
      return await this.tx(async (c) => {
        const { rows } = await c.query<AgencyRow>(
          `INSERT INTO pixel_agency.agencies (owner_user_id, name, ceo_agent_id, ceo_name, ceo_clan, credits, payroll_week)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${agencyCols}`,
          [a.ownerUserId, a.name, a.ceo.id, a.ceo.name, a.ceo.clan, a.credits, a.week],
        );
        const agency = rows[0]!;
        await c.query(
          `INSERT INTO pixel_agency.credit_ledger (agency_id, delta, balance_after, kind, ref) VALUES ($1, $2, $2, 'grant', 'founding')`,
          [agency.id, a.credits],
        );
        return agency;
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505') return e.constraint === 'agencies_name_ci' ? 'name_taken' : 'exists';
      throw err;
    }
  }

  async setCeo(agencyId: string, ceo: ArenaAgent): Promise<void> {
    await this.pool.query(`UPDATE pixel_agency.agencies SET ceo_agent_id = $2, ceo_name = $3, ceo_clan = $4 WHERE id = $1`, [agencyId, ceo.id, ceo.name, ceo.clan]);
  }

  /**
   * Moves credits and records the movement. Must run inside `tx` after
   * `lockAgency`. Returns false (and changes nothing) when this
   * (kind, ref) was already applied, or when the balance would go negative.
   */
  async applyCredit(c: PoolClient, agency: AgencyRow, delta: number, kind: CreditKind, ref: string): Promise<boolean> {
    const balance = agency.credits + delta;
    if (balance < 0) return false;
    const { rowCount } = await c.query(
      `INSERT INTO pixel_agency.credit_ledger (agency_id, delta, balance_after, kind, ref) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agency_id, kind, ref) DO NOTHING`,
      [agency.id, delta, balance, kind, ref],
    );
    if (rowCount === 0) return false;
    await c.query(`UPDATE pixel_agency.agencies SET credits = $2 WHERE id = $1`, [agency.id, balance]);
    agency.credits = balance;
    return true;
  }

  async ledger(agencyId: string, limit: number) {
    const { rows } = await this.pool.query(
      `SELECT delta::float8 AS delta, balance_after::float8 AS "balanceAfter", kind, ref, created_at AS "createdAt"
       FROM pixel_agency.credit_ledger WHERE agency_id = $1 ORDER BY id DESC LIMIT $2`,
      [agencyId, limit],
    );
    return rows as Array<{ delta: number; balanceAfter: number; kind: CreditKind; ref: string; createdAt: Date }>;
  }

  async agenciesDuePayroll(week: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(`SELECT id FROM pixel_agency.agencies WHERE payroll_week < $1 ORDER BY created_at`, [week]);
    return rows.map((r) => r.id);
  }

  async setPayrollWeek(c: PoolClient, agencyId: string, week: string): Promise<void> {
    await c.query(`UPDATE pixel_agency.agencies SET payroll_week = $2 WHERE id = $1`, [agencyId, week]);
  }

  // ── analysts ─────────────────────────────────────────────────────────
  async activeAnalysts(agencyId: string, c: Pool | PoolClient = this.pool): Promise<AnalystRow[]> {
    const { rows } = await c.query<AnalystRow>(`SELECT ${analystCols} FROM pixel_agency.analysts WHERE agency_id = $1 AND fired_at IS NULL ORDER BY hired_at, id`, [agencyId]);
    return rows;
  }

  async hiredCandidateKeys(agencyId: string, prefix: string): Promise<Set<string>> {
    const { rows } = await this.pool.query<{ k: string }>(`SELECT candidate_key AS k FROM pixel_agency.analysts WHERE agency_id = $1 AND candidate_key LIKE $2`, [agencyId, `${prefix}%`]);
    return new Set(rows.map((r) => r.k));
  }

  async insertAnalyst(c: PoolClient, agencyId: string, cand: Candidate): Promise<AnalystRow | undefined> {
    const { rows } = await c.query<AnalystRow>(
      `INSERT INTO pixel_agency.analysts (agency_id, candidate_key, name, specialty, skill, hire_cost, weekly_salary, style)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (agency_id, candidate_key) DO NOTHING RETURNING ${analystCols}`,
      [agencyId, cand.candidateKey, cand.name, cand.specialty, cand.skill, cand.hireCost, cand.weeklySalary, cand.style],
    );
    return rows[0];
  }

  async releaseAnalyst(agencyId: string, analystId: string, reason: 'fired' | 'unpaid', c: Pool | PoolClient = this.pool): Promise<AnalystRow | undefined> {
    const { rows } = await c.query<AnalystRow>(
      `UPDATE pixel_agency.analysts SET fired_at = now(), fire_reason = $3 WHERE id = $2 AND agency_id = $1 AND fired_at IS NULL RETURNING ${analystCols}`,
      [agencyId, analystId, reason],
    );
    return rows[0];
  }

  async setAnalystProgress(c: PoolClient, analystId: string, skill: number, xp: number, weeklySalary: number): Promise<void> {
    await c.query(`UPDATE pixel_agency.analysts SET skill = $2, xp = $3, weekly_salary = $4 WHERE id = $1`, [analystId, skill, xp, weeklySalary]);
  }

  // ── analyses ─────────────────────────────────────────────────────────
  async countAnalyses(agencyId: string, fixtureId: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pixel_agency.analyses WHERE agency_id = $1 AND fixture_id = $2`, [agencyId, fixtureId]);
    return rows[0]!.n;
  }

  async insertAnalysis(c: PoolClient, a: { agencyId: string; fixtureId: number; reports: unknown; combined: unknown }): Promise<AnalysisRow> {
    const { rows } = await c.query<AnalysisRow>(
      `INSERT INTO pixel_agency.analyses (agency_id, fixture_id, reports, combined) VALUES ($1, $2, $3, $4)
       RETURNING id, agency_id AS "agencyId", fixture_id::float8 AS "fixtureId", reports, combined, created_at AS "createdAt"`,
      [a.agencyId, a.fixtureId, JSON.stringify(a.reports), JSON.stringify(a.combined)],
    );
    return rows[0]!;
  }

  async getAnalysis(id: string): Promise<AnalysisRow | undefined> {
    const { rows } = await this.pool.query<AnalysisRow>(
      `SELECT id, agency_id AS "agencyId", fixture_id::float8 AS "fixtureId", reports, combined, created_at AS "createdAt" FROM pixel_agency.analyses WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  // ── predictions ──────────────────────────────────────────────────────
  async prediction(agencyId: string, fixtureId: number, c: Pool | PoolClient = this.pool, forUpdate = false): Promise<PredictionRow | undefined> {
    const { rows } = await c.query<PredictionRow>(
      `SELECT ${predictionCols} FROM pixel_agency.predictions WHERE agency_id = $1 AND fixture_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [agencyId, fixtureId],
    );
    return rows[0];
  }

  async predictionsFor(agencyId: string, fixtureIds: number[]): Promise<PredictionRow[]> {
    if (fixtureIds.length === 0) return [];
    const { rows } = await this.pool.query<PredictionRow>(`SELECT ${predictionCols} FROM pixel_agency.predictions WHERE agency_id = $1 AND fixture_id = ANY($2::bigint[])`, [agencyId, fixtureIds]);
    return rows;
  }

  async recentPredictions(agencyId: string, limit: number): Promise<PredictionRow[]> {
    const { rows } = await this.pool.query<PredictionRow>(`SELECT ${predictionCols} FROM pixel_agency.predictions WHERE agency_id = $1 ORDER BY kickoff_at DESC LIMIT $2`, [agencyId, limit]);
    return rows;
  }

  /** Creates the draft, or replaces the picks of an existing draft. Never touches a locked prediction. */
  async saveDraft(
    c: PoolClient,
    p: { agencyId: string; fixtureId: number; leagueName: string; homeTeam: string; awayTeam: string; kickoffAt: Date; lockAt: Date; week: string; picks: Picks; analysisId: string },
  ): Promise<PredictionRow | undefined> {
    const { rows } = await c.query<PredictionRow>(
      `INSERT INTO pixel_agency.predictions (agency_id, fixture_id, league_name, home_team, away_team, kickoff_at, lock_at, week, picks, analysis_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (agency_id, fixture_id) DO UPDATE SET picks = EXCLUDED.picks, analysis_id = EXCLUDED.analysis_id, edited = false,
         kickoff_at = EXCLUDED.kickoff_at, lock_at = EXCLUDED.lock_at, week = EXCLUDED.week, updated_at = now()
       WHERE pixel_agency.predictions.status = 'DRAFT'
       RETURNING ${predictionCols}`,
      [p.agencyId, p.fixtureId, p.leagueName, p.homeTeam, p.awayTeam, p.kickoffAt, p.lockAt, p.week, JSON.stringify(p.picks), p.analysisId],
    );
    return rows[0];
  }

  async editDraft(c: PoolClient, id: string, picks: Picks): Promise<PredictionRow> {
    const { rows } = await c.query<PredictionRow>(
      `UPDATE pixel_agency.predictions SET picks = $2, edited = true, updated_at = now() WHERE id = $1 AND status = 'DRAFT' RETURNING ${predictionCols}`,
      [id, JSON.stringify(picks)],
    );
    return rows[0]!;
  }

  async lock(id: string, auto: boolean, c: Pool | PoolClient = this.pool): Promise<PredictionRow | undefined> {
    const { rows } = await c.query<PredictionRow>(
      `UPDATE pixel_agency.predictions SET status = 'LOCKED', locked_at = now(), auto_locked = $2, updated_at = now()
       WHERE id = $1 AND status = 'DRAFT' RETURNING ${predictionCols}`,
      [id, auto],
    );
    return rows[0];
  }

  /** Drafts whose lock time has passed are locked as they stand. */
  async autoLockDue(now: Date): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE pixel_agency.predictions SET status = 'LOCKED', locked_at = $1, auto_locked = true, updated_at = now()
       WHERE status = 'DRAFT' AND lock_at <= $1`,
      [now],
    );
    return rowCount ?? 0;
  }

  async fixturesAwaitingResult(startedBefore: Date, limit: number): Promise<number[]> {
    const { rows } = await this.pool.query<{ f: number }>(
      `SELECT fixture_id::float8 AS f FROM pixel_agency.predictions WHERE status = 'LOCKED' AND kickoff_at <= $1
       GROUP BY fixture_id ORDER BY min(kickoff_at) LIMIT $2`,
      [startedBefore, limit],
    );
    return rows.map((r) => r.f);
  }

  async lockedForFixture(fixtureId: number): Promise<PredictionRow[]> {
    const { rows } = await this.pool.query<PredictionRow>(`SELECT ${predictionCols} FROM pixel_agency.predictions WHERE fixture_id = $1 AND status = 'LOCKED' ORDER BY id`, [fixtureId]);
    return rows;
  }

  /** A postponed match keeps its picks but moves to its new kickoff (and week). */
  async reschedule(fixtureId: number, kickoffAt: Date, lockMinutes: number, week: string): Promise<void> {
    await this.pool.query(
      `UPDATE pixel_agency.predictions SET kickoff_at = $2, lock_at = $2 - make_interval(mins => $3), week = $4, updated_at = now()
       WHERE fixture_id = $1 AND status IN ('DRAFT', 'LOCKED') AND kickoff_at <> $2`,
      [fixtureId, kickoffAt, lockMinutes, week],
    );
  }

  async recordSettlement(c: PoolClient, id: string, s: Settlement): Promise<boolean> {
    const { rowCount } = await c.query(
      `UPDATE pixel_agency.predictions SET status = $2, points_x10 = $3, exact_hits = $4, breakdown = $5, settled_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'LOCKED'`,
      [id, s.status, s.pointsX10, s.exactHits, JSON.stringify(s.breakdown)],
    );
    return (rowCount ?? 0) > 0;
  }

  // ── leaderboards ─────────────────────────────────────────────────────
  async leaderboard(week: string | null, limit: number, offset: number): Promise<LeaderboardRow[]> {
    const { rows } = await this.pool.query<LeaderboardRow>(
      `WITH t AS (
         SELECT p.agency_id, sum(p.points_x10)::int AS points, sum(p.exact_hits)::int AS exact, count(*)::int AS n
         FROM pixel_agency.predictions p
         WHERE p.status = 'SETTLED' AND ($1::text IS NULL OR p.week = $1)
         GROUP BY p.agency_id
       )
       SELECT (rank() OVER (ORDER BY t.points DESC, t.exact DESC))::int AS rank, a.id AS "agencyId", a.name AS "agencyName",
              a.ceo_name AS "ceoName", a.ceo_clan AS "ceoClan", t.points AS "pointsX10", t.exact AS "exactHits", t.n AS predictions
       FROM t JOIN pixel_agency.agencies a ON a.id = t.agency_id
       ORDER BY t.points DESC, t.exact DESC, a.created_at ASC
       LIMIT $2 OFFSET $3`,
      [week, limit, offset],
    );
    return rows;
  }

  async standing(agencyId: string, week: string | null): Promise<LeaderboardRow | undefined> {
    const { rows } = await this.pool.query<LeaderboardRow>(
      `WITH t AS (
         SELECT p.agency_id, sum(p.points_x10)::int AS points, sum(p.exact_hits)::int AS exact, count(*)::int AS n
         FROM pixel_agency.predictions p
         WHERE p.status = 'SETTLED' AND ($2::text IS NULL OR p.week = $2)
         GROUP BY p.agency_id
       ), r AS (SELECT t.*, (rank() OVER (ORDER BY t.points DESC, t.exact DESC))::int AS rank FROM t)
       SELECT r.rank, a.id AS "agencyId", a.name AS "agencyName", a.ceo_name AS "ceoName", a.ceo_clan AS "ceoClan",
              r.points AS "pointsX10", r.exact AS "exactHits", r.n AS predictions
       FROM r JOIN pixel_agency.agencies a ON a.id = r.agency_id WHERE r.agency_id = $1`,
      [agencyId, week],
    );
    return rows[0];
  }

  async totalPointsX10(agencyId: string, c: Pool | PoolClient = this.pool): Promise<number> {
    const { rows } = await c.query<{ p: number }>(`SELECT coalesce(sum(points_x10), 0)::int AS p FROM pixel_agency.predictions WHERE agency_id = $1 AND status = 'SETTLED'`, [agencyId]);
    return rows[0]!.p;
  }
}
