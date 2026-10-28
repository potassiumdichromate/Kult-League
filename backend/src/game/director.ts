import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError, conflict, notFound, tooMany } from '../api/errors';
import type { FootballIntel, MatchRecord, RecordSubmission } from '../clients/ai-infra';
import { ArenaMindKeys, hashKey } from '../clients/arena-minds';
import type { MindsGateway, MindSummary } from '../clients/minds';
import type { MindsStore, DirectorRow } from './minds-store';
import { Picks, picksProblems } from './picks';
import { isoWeek, RECORD_LINES } from './rules';
import type { GameService } from './service';
import type { GameStore, MindRecord, PredictionRow } from './store';

/**
 * Mind directors (docs/ARCHITECTURE.md, "Mind directors"). The owner links
 * their Hello Minds account; the Mind they choose then directs the agency
 * through the director API: it reads its analysts' reports, hires and fires,
 * and makes the final call on each match.
 *
 * A Mind's call is final the moment it is made, in the game and on the
 * record: the prediction is locked here and submitted to ai-infrastructure
 * as `mind:<mindId>`, where it is write-once, anchored on 0G Chain before
 * kickoff and graded against the 0G baseline. That record follows the Mind,
 * not the agency.
 */

export const DIRECTOR_KEY_PREFIX = 'pa_mk_';
const MAX_ACTIVE_KEYS = 3;
const NOT_STARTED = new Set(['NS', 'TBD']);

export interface DirectorConfig {
  lockMinutesBeforeKickoff: number;
}

export interface Decision {
  picks: { outcome: 'HOME' | 'DRAW' | 'AWAY'; score: { home: number; away: number }; corners: number; cards: number; scorerId: string | null };
  conviction: 'LOW' | 'MEDIUM' | 'HIGH';
  rationale: string;
  evidence: string[];
}

export function generateDirectorKey(): { key: string; hash: string; prefix: string } {
  const key = DIRECTOR_KEY_PREFIX + randomBytes(32).toString('base64url');
  return { key, hash: hashDirectorKey(key), prefix: key.slice(0, DIRECTOR_KEY_PREFIX.length + 6) };
}

export function hashDirectorKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function looksLikeDirectorKey(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(DIRECTOR_KEY_PREFIX) && v.length >= DIRECTOR_KEY_PREFIX.length + 40 && v.length <= 100;
}

/** The game's exact corners/cards become over/under on the record's fixed lines. */
export function toRecordPicks(p: Picks): RecordSubmission['picks'] {
  return {
    result: p.outcome,
    score: p.score,
    totalCards: p.cards > RECORD_LINES.totalCards ? 'OVER' : 'UNDER',
    totalCorners: p.corners > RECORD_LINES.totalCorners ? 'OVER' : 'UNDER',
    scorerId: p.scorerId,
  };
}

/** Everything the record would reject, checked before anything is locked. */
export function decisionProblems(p: Picks, squad: ReadonlyArray<{ id: string; side: 'HOME' | 'AWAY' }>): string[] {
  const problems = picksProblems(p, new Set(squad.map((x) => x.id)));
  const side = p.scorerId === null ? undefined : squad.find((x) => x.id === p.scorerId)?.side;
  if (side && (side === 'HOME' ? p.score.home : p.score.away) === 0) problems.push('the goal scorer plays for a side your score says will not score');
  return problems;
}

/** Strips control characters (keeps line breaks and tabs). */
export function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

export class DirectorService {
  constructor(
    private readonly game: GameService,
    private readonly gameStore: GameStore,
    private readonly store: MindsStore,
    private readonly minds: MindsGateway,
    private readonly intel: FootballIntel,
    private readonly record: MatchRecord,
    private readonly cfg: DirectorConfig,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
    /** Resolves AI Arena Mind keys (`kult_mk_…`); without it only director keys work. */
    private readonly arenaMinds?: ArenaMindKeys,
  ) {}

  private async agencyIdOf(userId: string): Promise<string> {
    const agency = await this.gameStore.agencyByOwner(userId);
    if (!agency) throw notFound('create your agency first');
    return agency.id;
  }

  // ── owner side ───────────────────────────────────────────────────────
  /**
   * Links the owner's Minds account (proven with their Minds Connect access
   * token) and chooses the Mind that directs: the one asked for, or the
   * account's only Mind. Issues a director key when there is none.
   */
  async linkMind(userId: string, accessToken: string, mindId?: string) {
    const agencyId = await this.agencyIdOf(userId);
    const identity = await this.minds.identify(accessToken);
    const link = await this.store.upsertLink(agencyId, identity.mindsUserId);
    if (link === 'taken') throw conflict('that Minds account already directs another agency');

    let chosen: MindSummary | undefined;
    if (mindId) {
      chosen = identity.minds.find((m) => m.mindId === mindId);
      if (!chosen) throw new AppError(400, 'bad_request', 'that Mind is not on your Minds account');
    } else if (!link.mindId && identity.minds.length === 1) {
      chosen = identity.minds[0];
    }
    const current = chosen ? await this.store.setMind(agencyId, chosen) : link;

    const key = (await this.store.activeKeyCount(agencyId)) === 0 ? await this.issueKey(agencyId) : null;
    return { mind: this.mindView(current), minds: identity.minds, key };
  }

  async mindStatus(userId: string) {
    const agencyId = await this.agencyIdOf(userId);
    const link = await this.store.link(agencyId);
    return { mind: link ? this.mindView(link) : null, keys: link ? await this.store.keys(agencyId) : [] };
  }

  async newKey(userId: string) {
    const agencyId = await this.agencyIdOf(userId);
    if (!(await this.store.link(agencyId))) throw conflict('link your Mind first');
    return { key: await this.issueKey(agencyId) };
  }

  async revokeKey(userId: string, keyId: string) {
    if (!(await this.store.revokeKey(await this.agencyIdOf(userId), keyId))) throw notFound('no active key with that id');
    return { revoked: true };
  }

  async unlink(userId: string) {
    if (!(await this.store.unlink(await this.agencyIdOf(userId)))) throw notFound('no Mind is linked to your agency');
    return { unlinked: true };
  }

  private async issueKey(agencyId: string) {
    const { key, hash, prefix } = generateDirectorKey();
    const row = await this.store.insertKey(agencyId, hash, prefix, MAX_ACTIVE_KEYS);
    if (row === 'limit') throw tooMany(`at most ${MAX_ACTIVE_KEYS} active director keys; revoke one first`);
    return { id: row.id, key, prefix: row.prefix, createdAt: row.createdAt };
  }

  private mindView(link: { mindId: string | null; mindName: string | null; mindEmail: string | null; linkedAt: Date }) {
    return { mindId: link.mindId, name: link.mindName, email: link.mindEmail, linkedAt: link.linkedAt, agentId: link.mindId ? `mind:${link.mindId}` : null };
  }

  // ── director side ────────────────────────────────────────────────────
  /** The agency behind a director key, or undefined for an unknown or revoked key. */
  resolve(key: string): Promise<DirectorRow | undefined> {
    return this.store.director(hashDirectorKey(key));
  }

  /**
   * The agency behind an AI Arena Mind key: the Mind runs an agent, and it
   * directs the agency whose owner owns that agent and whose CEO it is. So a
   * Mind linked once, to the agent, plays here too, with no second key.
   */
  async resolveArenaMind(key: string): Promise<DirectorRow | undefined> {
    const m = await this.arenaMinds?.resolve(key);
    if (!m) return undefined;
    const agencyId = await this.store.agencyRunBy(m.ownerUserId, m.agentId);
    if (!agencyId) return undefined;
    return { keyId: `arena:${hashKey(key).slice(0, 16)}`, agencyId, ownerUserId: m.ownerUserId, mindId: m.mindId, mindName: m.mindName };
  }

  private requireMind(d: DirectorRow): string {
    if (!d.mindId) throw conflict('the owner has not chosen which Mind directs this agency yet');
    return d.mindId;
  }

  /**
   * The Mind's final call on a match. Locks the prediction and submits it to
   * the record; both must still be open. If the record is briefly
   * unreachable the pick stays locked with record status `pending` and the
   * worker submits it before the record closes.
   */
  async decide(d: DirectorRow, fixtureId: number, decision: Decision) {
    const mindId = this.requireMind(d);
    const ctx = await this.intel.context(fixtureId);
    const kickoff = new Date(ctx.fixture.kickoffAt);
    const lockAt = new Date(kickoff.getTime() - this.cfg.lockMinutesBeforeKickoff * 60_000);
    if (!NOT_STARTED.has(ctx.fixture.status) || this.now() >= lockAt) throw conflict('predictions for this match are closed');
    if (!ctx.predictionsOpen) throw conflict('the record for this match has closed; a Mind decides before the record locks (30 minutes before kickoff)');

    const squad = new Map(ctx.squad.map((p) => [p.id, p.name]));
    const picks: Picks = { ...decision.picks, scorerName: decision.picks.scorerId === null ? null : squad.get(decision.picks.scorerId) ?? null };
    const problems = decisionProblems(picks, ctx.squad);
    if (problems.length) throw new AppError(400, 'bad_request', problems.join('; '));

    const record: MindRecord = {
      status: 'pending',
      agentId: `mind:${mindId}`,
      conviction: decision.conviction,
      rationale: cleanText(decision.rationale),
      evidence: decision.evidence.map(cleanText).filter(Boolean),
    };
    const locked = await this.gameStore.tx((c) =>
      this.gameStore.decideAndLock(c, {
        agencyId: d.agencyId, fixtureId, leagueName: ctx.fixture.leagueName, homeTeam: ctx.fixture.homeTeam, awayTeam: ctx.fixture.awayTeam,
        kickoffAt: kickoff, lockAt, week: isoWeek(kickoff), picks, mindId, record,
      }),
    );
    if (!locked) throw conflict('your picks for this match are already locked');

    const synced = await this.submitRecord(locked, d.mindName);
    return { prediction: this.game.predictionView(synced) };
  }

  /** Submits one locked Mind decision; records the outcome on the prediction. */
  private async submitRecord(p: PredictionRow, mindName: string | null): Promise<PredictionRow> {
    const r = p.record!;
    let next: MindRecord;
    try {
      const entry = await this.record.submit(p.fixtureId, {
        agent: { id: r.agentId, name: (mindName ?? 'Mind').slice(0, 80) },
        picks: toRecordPicks(p.picks),
        conviction: r.conviction,
        rationale: r.rationale,
        evidence: r.evidence,
      });
      next = { ...r, status: 'recorded', decisionId: entry.prediction.decisionId };
    } catch (err) {
      if (!(err instanceof AppError) || err.statusCode >= 500) {
        this.log.warn({ predictionId: p.id, err: (err as Error).message }, 'record unavailable; will retry');
        return p;
      }
      // 409 here means the record has closed (or the id is taken by another caller); 400 means it refused the picks.
      next = { ...r, status: err.statusCode === 409 ? 'missed' : 'rejected', error: err.message.slice(0, 300) };
      this.log.warn({ predictionId: p.id, status: next.status, err: err.message }, 'Mind decision not recorded');
    }
    return (await this.gameStore.setRecord(p.id, next)) ?? p;
  }

  /** Worker: submit Mind decisions that are still pending. */
  async syncRecords(): Promise<{ recorded: number; missed: number; pending: number }> {
    let recorded = 0;
    let missed = 0;
    let pending = 0;
    for (const p of await this.gameStore.pendingRecords(50)) {
      const agency = await this.store.link(p.agencyId);
      const after = await this.submitRecord(p, agency?.mindId === p.mindId ? agency.mindName : null);
      const s = after.record?.status;
      if (s === 'recorded') recorded++;
      else if (s === 'pending') pending++;
      else missed++;
    }
    return { recorded, missed, pending };
  }

  /** The Mind's career on the record (follows the Mind across agencies and seasons), plus this agency's standing. */
  async career(d: DirectorRow) {
    const mindId = this.requireMind(d);
    const agentId = `mind:${mindId}`;
    const [profile, agency] = await Promise.all([this.record.profile(agentId), this.game.agency(d.ownerUserId)]);
    return {
      mind: { mindId, name: d.mindName, agentId },
      record: {
        byMarket: profile.record,
        calibration: profile.calibration,
        vsBaseline: profile.baseline,
        lessons: profile.lessons,
        recentOutcomes: profile.recentOutcomes,
      },
      agency: { name: agency.name, level: agency.level, points: agency.points, standings: agency.standings },
    };
  }

  /** Re-exported so the routes need one dependency. */
  readonly forOwner = {
    agency: (d: DirectorRow) => this.game.agency(d.ownerUserId),
    talent: (d: DirectorRow) => this.game.talent(d.ownerUserId),
    hire: (d: DirectorRow, candidateKey: string) => this.game.hire(d.ownerUserId, candidateKey),
    fire: (d: DirectorRow, analystId: string) => this.game.fire(d.ownerUserId, analystId),
    fixtures: (d: DirectorRow, q: { from?: string; to?: string; league?: number }) => this.game.fixtures(d.ownerUserId, q),
    fixture: (d: DirectorRow, id: number) => this.game.fixture(d.ownerUserId, id),
    analyse: (d: DirectorRow, id: number) => this.game.analyse(d.ownerUserId, id),
    predictions: (d: DirectorRow) => this.game.predictions(d.ownerUserId),
  };
}
