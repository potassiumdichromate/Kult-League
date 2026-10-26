import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import { badRequest, conflict, forbidden, insufficientCredits, notFound, tooMany } from '../api/errors';
import type { ArenaAgent, ArenaGateway } from '../clients/ai-arena';
import type { FixtureContext, FootballIntel, ResearchBrief, Specialty } from '../clients/ai-infra';
import { issueSession } from '../auth/session';
import { analystReport, AnalystReport, combine, CombinedAnalysis } from './analysis';
import { Picks, PicksEdit, picksProblems, settle } from './picks';
import {
  agencyLevel, CREDITS_PER_POINT_X10, desksForLevel, isoWeek, MAX_SKILL, nextLevelPoints, nextWeekStart,
  SPECIALTY_MARKETS, SPECIALTY_TITLES, STARTING_CREDITS, WEEKLY_SALARY, xpToNextSkill,
} from './rules';
import type { AgencyRow, AnalystRow, GameStore, PredictionRow } from './store';
import { talentPool } from './talent';

export interface GameConfig {
  sessionSecret: string;
  sessionTtlMinutes: number;
  lockMinutesBeforeKickoff: number;
  maxAnalysesPerFixture: number;
}

/** Fixture statuses before kickoff (API-Football short codes). */
const NOT_STARTED = new Set(['NS', 'TBD']);
/** Results are looked for once a match should be over. */
const RESULT_AFTER_MS = 115 * 60_000;

export class GameService {
  constructor(
    private readonly store: GameStore,
    private readonly arena: ArenaGateway,
    private readonly intel: FootballIntel,
    private readonly cfg: GameConfig,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── session ──────────────────────────────────────────────────────────
  async startSession(aiArenaToken: string) {
    const identity = await this.arena.identify(aiArenaToken);
    await this.store.upsertPlayer(identity);
    const { token, expiresAt } = issueSession(this.cfg.sessionSecret, identity.userId, this.cfg.sessionTtlMinutes, this.now().getTime());
    const agency = await this.store.agencyByOwner(identity.userId);
    return {
      token,
      expiresAt,
      player: { userId: identity.userId, username: identity.username, walletAddress: identity.walletAddress },
      agents: identity.agents.filter((a) => !a.isRetired),
      agency: agency ? await this.agencyView(agency) : null,
    };
  }

  async me(userId: string) {
    const player = await this.store.getPlayer(userId);
    if (!player) throw notFound('player not found');
    const agency = await this.store.agencyByOwner(userId);
    return {
      player: { userId: player.userId, username: player.username, walletAddress: player.walletAddress },
      agents: player.agents.filter((a) => !a.isRetired),
      agency: agency ? await this.agencyView(agency) : null,
    };
  }

  private async ownAgent(userId: string, agentId: string): Promise<ArenaAgent> {
    const player = await this.store.getPlayer(userId);
    const agent = player?.agents.find((a) => a.id === agentId);
    if (!agent) throw forbidden('that agent is not one of yours (sign in again if you created it recently)');
    if (agent.isRetired) throw badRequest('a retired agent cannot run an agency');
    return agent;
  }

  private async agencyOf(userId: string): Promise<AgencyRow> {
    const agency = await this.store.agencyByOwner(userId);
    if (!agency) throw notFound('create your agency first');
    return agency;
  }

  // ── agency ───────────────────────────────────────────────────────────
  async createAgency(userId: string, name: string, ceoAgentId: string) {
    const ceo = await this.ownAgent(userId, ceoAgentId);
    const res = await this.store.createAgency({ ownerUserId: userId, name, ceo, credits: STARTING_CREDITS, week: isoWeek(this.now()) });
    if (res === 'exists') throw conflict('you already run an agency');
    if (res === 'name_taken') throw conflict('that agency name is taken');
    return this.agencyView(res);
  }

  async changeCeo(userId: string, ceoAgentId: string) {
    const agency = await this.agencyOf(userId);
    const ceo = await this.ownAgent(userId, ceoAgentId);
    await this.store.setCeo(agency.id, ceo);
    return this.agencyView((await this.store.agencyByOwner(userId))!);
  }

  async agency(userId: string) {
    return this.agencyView(await this.agencyOf(userId));
  }

  private async agencyView(a: AgencyRow) {
    const [analysts, totalPointsX10, weekly, allTime] = await Promise.all([
      this.store.activeAnalysts(a.id),
      this.store.totalPointsX10(a.id),
      this.store.standing(a.id, isoWeek(this.now())),
      this.store.standing(a.id, null),
    ]);
    const level = agencyLevel(totalPointsX10);
    const payroll = analysts.reduce((s, x) => s + x.weeklySalary, 0);
    return {
      id: a.id,
      name: a.name,
      ceo: { agentId: a.ceoAgentId, name: a.ceoName, clan: a.ceoClan },
      credits: a.credits,
      level,
      points: totalPointsX10 / 10,
      nextLevelAt: nextLevelPoints(level),
      desks: desksForLevel(level),
      staff: analysts.map((x) => this.analystView(x)),
      payroll: { weeklyTotal: payroll, nextDueAt: nextWeekStart(this.now()) },
      standings: {
        weekly: weekly ? { rank: weekly.rank, points: weekly.pointsX10 / 10 } : null,
        allTime: allTime ? { rank: allTime.rank, points: allTime.pointsX10 / 10 } : null,
      },
      createdAt: a.createdAt,
    };
  }

  private analystView(x: AnalystRow) {
    return {
      id: x.id,
      name: x.name,
      specialty: x.specialty,
      title: SPECIALTY_TITLES[x.specialty],
      markets: SPECIALTY_MARKETS[x.specialty],
      skill: x.skill,
      xp: x.xp,
      xpToNext: x.skill >= MAX_SKILL ? null : xpToNextSkill(x.skill),
      weeklySalary: x.weeklySalary,
      style: x.style,
      hiredAt: x.hiredAt,
    };
  }

  // ── staff ────────────────────────────────────────────────────────────
  async talent(userId: string) {
    const agency = await this.agencyOf(userId);
    const week = isoWeek(this.now());
    const hired = await this.store.hiredCandidateKeys(agency.id, `${week}:`);
    return {
      week,
      refreshesAt: nextWeekStart(this.now()),
      candidates: talentPool(agency.id, week).filter((c) => !hired.has(c.candidateKey)),
    };
  }

  async hire(userId: string, candidateKey: string) {
    const agency = await this.agencyOf(userId);
    const week = isoWeek(this.now());
    const cand = talentPool(agency.id, week).find((c) => c.candidateKey === candidateKey);
    if (!cand) throw notFound('that candidate is not in this week\'s talent pool');
    const level = agencyLevel(await this.store.totalPointsX10(agency.id));
    const analyst = await this.store.tx(async (c) => {
      const a = await this.store.lockAgency(c, agency.id);
      const staff = await this.store.activeAnalysts(a.id, c);
      if (staff.length >= desksForLevel(level)) throw conflict(`all ${desksForLevel(level)} desks are taken; fire someone or level up the agency`);
      const row = await this.store.insertAnalyst(c, a.id, cand);
      if (!row) throw conflict('you already hired this candidate');
      if (!(await this.store.applyCredit(c, a, -cand.hireCost, 'hire', row.id))) throw insufficientCredits(`hiring costs ${cand.hireCost} credits; you have ${a.credits}`);
      return row;
    });
    return { analyst: this.analystView(analyst), agency: await this.agency(userId) };
  }

  async fire(userId: string, analystId: string) {
    const agency = await this.agencyOf(userId);
    const released = await this.store.releaseAnalyst(agency.id, analystId, 'fired');
    if (!released) throw notFound('no such analyst on your staff');
    return { fired: this.analystView(released), agency: await this.agency(userId) };
  }

  async ledger(userId: string) {
    const agency = await this.agencyOf(userId);
    return { credits: agency.credits, entries: await this.store.ledger(agency.id, 100) };
  }

  // ── fixtures ─────────────────────────────────────────────────────────
  async fixtures(userId: string, q: { from?: string; to?: string; league?: number }) {
    const [fixtures, agency] = await Promise.all([this.intel.listFixtures(q), this.store.agencyByOwner(userId)]);
    const mine = agency ? await this.store.predictionsFor(agency.id, fixtures.map((f) => f.fixtureId)) : [];
    const byFixture = new Map(mine.map((p) => [p.fixtureId, p]));
    return {
      fixtures: fixtures.map((f) => {
        const lockAt = this.lockAt(new Date(f.kickoffAt));
        const p = byFixture.get(f.fixtureId);
        return { ...f, lockAt, open: NOT_STARTED.has(f.status) && this.now() < lockAt, prediction: p ? { status: p.status, points: p.pointsX10 / 10 } : null };
      }),
    };
  }

  async fixture(userId: string, fixtureId: number) {
    const [ctx, agency] = await Promise.all([this.intel.context(fixtureId), this.store.agencyByOwner(userId)]);
    const prediction = agency ? await this.store.prediction(agency.id, fixtureId) : undefined;
    const analysis = prediction?.analysisId ? await this.store.getAnalysis(prediction.analysisId) : undefined;
    const lockAt = this.lockAt(new Date(ctx.fixture.kickoffAt));
    return {
      fixture: { ...ctx.fixture, lockAt, open: this.isOpen(ctx) },
      squad: ctx.squad,
      absences: ctx.absences,
      outcome: ctx.outcome,
      analysesUsed: agency ? await this.store.countAnalyses(agency.id, fixtureId) : 0,
      analysesAllowed: this.cfg.maxAnalysesPerFixture,
      prediction: prediction ? this.predictionView(prediction) : null,
      analysis: analysis ? { id: analysis.id, reports: analysis.reports, combined: analysis.combined, createdAt: analysis.createdAt } : null,
    };
  }

  private lockAt(kickoff: Date): Date {
    return new Date(kickoff.getTime() - this.cfg.lockMinutesBeforeKickoff * 60_000);
  }

  private isOpen(ctx: FixtureContext): boolean {
    return NOT_STARTED.has(ctx.fixture.status) && this.now() < this.lockAt(new Date(ctx.fixture.kickoffAt));
  }

  predictionView(p: PredictionRow) {
    return {
      id: p.id,
      fixtureId: p.fixtureId,
      match: `${p.homeTeam} vs ${p.awayTeam}`,
      leagueName: p.leagueName,
      kickoffAt: p.kickoffAt,
      lockAt: p.lockAt,
      week: p.week,
      status: p.status,
      picks: p.picks,
      edited: p.edited,
      lockedAt: p.lockedAt,
      autoLocked: p.autoLocked,
      settledAt: p.settledAt,
      points: p.pointsX10 / 10,
      exactHits: p.exactHits,
      breakdown: p.breakdown
        ? Object.fromEntries(Object.entries(p.breakdown).map(([m, b]) => [m, { result: b.result, points: b.pointsX10 / 10 }]))
        : null,
      decidedBy: p.decidedBy,
      // A Mind's call, as it stands on the ai-infrastructure record.
      mindDecision: p.record
        ? { mindId: p.mindId, conviction: p.record.conviction, rationale: p.record.rationale, evidence: p.record.evidence, record: { status: p.record.status, agentId: p.record.agentId, decisionId: p.record.decisionId ?? null, error: p.record.error ?? null } }
        : null,
    };
  }

  async predictions(userId: string) {
    const agency = await this.agencyOf(userId);
    return { predictions: (await this.store.recentPredictions(agency.id, 50)).map((p) => this.predictionView(p)) };
  }

  // ── analysis ─────────────────────────────────────────────────────────
  /**
   * The desk analyses the match: each analyst reads their specialty's brief
   * and recommends picks for their markets, then the CEO combines them into
   * the draft. Re-running replaces the draft (and any CEO edits).
   */
  async analyse(userId: string, fixtureId: number) {
    const agency = await this.agencyOf(userId);
    if ((await this.store.countAnalyses(agency.id, fixtureId)) >= this.cfg.maxAnalysesPerFixture) {
      throw tooMany(`your desk has already analysed this match ${this.cfg.maxAnalysesPerFixture} times`);
    }
    const existing = await this.store.prediction(agency.id, fixtureId);
    if (existing && existing.status !== 'DRAFT') throw conflict('your picks for this match are already locked');

    let ctx = await this.intel.context(fixtureId);
    if (!this.isOpen(ctx)) throw conflict('predictions for this match are closed');
    if (!ctx.forecast) {
      if (!ctx.predictionsOpen) throw conflict('no match forecast is available for this fixture');
      ctx = await this.intel.forecastNow(fixtureId);
      if (!ctx.forecast) throw conflict('no match forecast is available for this fixture yet');
    }

    const staff = await this.store.activeAnalysts(agency.id);
    const specialties = [...new Set(staff.map((a) => a.specialty))];
    const briefs = new Map<Specialty, ResearchBrief>();
    const settled = await Promise.allSettled(specialties.map((s) => this.intel.research(fixtureId, s)));
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') briefs.set(specialties[i]!, r.value);
      else this.log.warn({ fixtureId, specialty: specialties[i], err: (r.reason as Error).message }, 'research brief unavailable');
    });

    const reports: AnalystReport[] = staff.map((a) => analystReport(a, ctx, briefs.get(a.specialty)));
    const combined: CombinedAnalysis = combine(reports, ctx, { id: agency.ceoAgentId, name: agency.ceoName });
    const kickoff = new Date(ctx.fixture.kickoffAt);

    const { analysis, prediction } = await this.store.tx(async (c) => {
      const analysis = await this.store.insertAnalysis(c, { agencyId: agency.id, fixtureId, reports, combined });
      const prediction = await this.store.saveDraft(c, {
        agencyId: agency.id, fixtureId, leagueName: ctx.fixture.leagueName, homeTeam: ctx.fixture.homeTeam, awayTeam: ctx.fixture.awayTeam,
        kickoffAt: kickoff, lockAt: this.lockAt(kickoff), week: isoWeek(kickoff), picks: combined.picks, analysisId: analysis.id,
      });
      if (!prediction) throw conflict('your picks for this match are already locked');
      return { analysis, prediction };
    });
    return {
      analysis: { id: analysis.id, reports, combined, createdAt: analysis.createdAt },
      prediction: this.predictionView(prediction),
      analysesUsed: (await this.store.countAnalyses(agency.id, fixtureId)),
      analysesAllowed: this.cfg.maxAnalysesPerFixture,
    };
  }

  // ── CEO edits and lock ───────────────────────────────────────────────
  async editPicks(userId: string, fixtureId: number, edit: PicksEdit) {
    const agency = await this.agencyOf(userId);
    const ctx = await this.intel.context(fixtureId);
    if (!this.isOpen(ctx)) throw conflict('predictions for this match are closed');
    const squad = new Map(ctx.squad.map((p) => [p.id, p.name]));
    const updated = await this.store.tx(async (c) => {
      const p = await this.store.prediction(agency.id, fixtureId, c, true);
      if (!p) throw conflict('run the desk analysis first; your analysts draft the picks');
      if (p.status !== 'DRAFT') throw conflict('your picks for this match are already locked');
      const scorerId = edit.scorerId === undefined ? p.picks.scorerId : edit.scorerId;
      const next: Picks = {
        outcome: edit.outcome ?? p.picks.outcome,
        score: edit.score ?? p.picks.score,
        corners: edit.corners ?? p.picks.corners,
        cards: edit.cards ?? p.picks.cards,
        scorerId,
        scorerName: scorerId === null ? null : squad.get(scorerId) ?? null,
      };
      const problems = picksProblems(next, new Set(squad.keys()));
      if (problems.length) throw badRequest(problems.join('; '));
      return this.store.editDraft(c, p.id, next);
    });
    return { prediction: this.predictionView(updated) };
  }

  async lock(userId: string, fixtureId: number) {
    const agency = await this.agencyOf(userId);
    const p = await this.store.prediction(agency.id, fixtureId);
    if (!p) throw conflict('run the desk analysis first');
    if (p.status !== 'DRAFT') throw conflict('your picks for this match are already locked');
    if (this.now() >= p.lockAt) throw conflict('predictions for this match are closed');
    const locked = await this.store.lock(p.id, false);
    if (!locked) throw conflict('your picks for this match are already locked');
    return { prediction: this.predictionView(locked) };
  }

  // ── leaderboards ─────────────────────────────────────────────────────
  async leaderboard(kind: 'weekly' | 'all-time', opts: { week?: string; limit: number; offset: number }, userId?: string) {
    const week = kind === 'weekly' ? opts.week ?? isoWeek(this.now()) : null;
    const rows = await this.store.leaderboard(week, opts.limit, opts.offset);
    const agency = userId ? await this.store.agencyByOwner(userId) : undefined;
    const me = agency ? await this.store.standing(agency.id, week) : undefined;
    const view = (r: (typeof rows)[number]) => ({ rank: r.rank, agencyId: r.agencyId, agencyName: r.agencyName, ceo: { name: r.ceoName, clan: r.ceoClan }, points: r.pointsX10 / 10, exactHits: r.exactHits, predictions: r.predictions });
    return { kind, week, entries: rows.map(view), me: me ? view(me) : null };
  }

  // ── background jobs ──────────────────────────────────────────────────
  async autoLock(): Promise<number> {
    return this.store.autoLockDue(this.now());
  }

  /** Settles locked predictions whose match result is known. */
  async settleDue(): Promise<{ settled: number; voided: number; pending: number }> {
    const fixtures = await this.store.fixturesAwaitingResult(new Date(this.now().getTime() - RESULT_AFTER_MS), 50);
    let settled = 0;
    let voided = 0;
    let pending = 0;
    for (const fixtureId of fixtures) {
      let ctx: FixtureContext;
      try {
        ctx = await this.intel.context(fixtureId);
      } catch (err) {
        this.log.warn({ fixtureId, err: (err as Error).message }, 'result lookup failed');
        pending++;
        continue;
      }
      if (!ctx.outcome) {
        const kickoff = new Date(ctx.fixture.kickoffAt);
        await this.store.reschedule(fixtureId, kickoff, this.cfg.lockMinutesBeforeKickoff, isoWeek(kickoff));
        pending++;
        continue;
      }
      for (const p of await this.store.lockedForFixture(fixtureId)) {
        const s = settle(p.picks, ctx.outcome);
        const applied = await this.store.tx(async (c) => {
          if (!(await this.store.recordSettlement(c, p.id, s))) return false;
          if (s.pointsX10 > 0) {
            const a = await this.store.lockAgency(c, p.agencyId);
            await this.store.applyCredit(c, a, s.pointsX10 * CREDITS_PER_POINT_X10, 'winnings', p.id);
          }
          await this.awardXp(c, p, s.breakdown);
          return true;
        });
        if (applied) s.status === 'VOID' ? voided++ : settled++;
      }
    }
    return { settled, voided, pending };
  }

  /** Analysts who worked on the prediction gain XP: 10 for the job plus a share of the points in their markets. */
  private async awardXp(c: PoolClient, p: PredictionRow, breakdown: ReturnType<typeof settle>['breakdown']) {
    if (!p.analysisId) return;
    const analysis = await this.store.getAnalysis(p.analysisId);
    const workers = new Set(((analysis?.reports ?? []) as AnalystReport[]).map((r) => r.analystId));
    for (const a of await this.store.activeAnalysts(p.agencyId, c)) {
      if (!workers.has(a.id)) continue;
      let xp = a.xp + 10 + SPECIALTY_MARKETS[a.specialty].reduce((s, m) => s + breakdown[m].pointsX10, 0) / 5;
      let skill = a.skill;
      while (skill < MAX_SKILL && xp >= xpToNextSkill(skill)) {
        xp -= xpToNextSkill(skill);
        skill++;
      }
      if (skill >= MAX_SKILL) xp = Math.min(xp, xpToNextSkill(MAX_SKILL));
      const salary = skill > a.skill ? Math.max(a.weeklySalary, WEEKLY_SALARY[skill]!) : a.weeklySalary;
      await this.store.setAnalystProgress(c, a.id, skill, Math.round(xp), salary);
    }
  }

  /**
   * Weekly payroll, once per agency per ISO week. Analysts are paid in
   * hiring order; anyone the agency cannot afford quits.
   */
  async runPayroll(): Promise<{ agencies: number; paid: number; quit: number }> {
    const week = isoWeek(this.now());
    let paid = 0;
    let quit = 0;
    const due = await this.store.agenciesDuePayroll(week);
    for (const id of due) {
      await this.store.tx(async (c) => {
        const a = await this.store.lockAgency(c, id);
        if (a.payrollWeek >= week) return;
        for (const analyst of await this.store.activeAnalysts(id, c)) {
          if (await this.store.applyCredit(c, a, -analyst.weeklySalary, 'salary', `${week}:${analyst.id}`)) paid++;
          else {
            await this.store.releaseAnalyst(id, analyst.id, 'unpaid', c);
            quit++;
          }
        }
        await this.store.setPayrollWeek(c, id, week);
      });
    }
    return { agencies: due.length, paid, quit };
  }
}
