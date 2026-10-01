import { describe, expect, it } from 'vitest';
import { issueSession, verifySession } from '../../src/auth/session';
import { agencyLevel, desksForLevel, isoWeek, nextWeekStart, SPECIALTIES } from '../../src/game/rules';
import { talentPool } from '../../src/game/talent';
import { loadConfig } from '../../src/config/env';

describe('weeks', () => {
  it('uses ISO-8601 weeks in UTC', () => {
    expect(isoWeek(new Date('2026-10-01T12:00:00Z'))).toBe('2026-W40');
    expect(isoWeek(new Date('2026-10-04T23:59:59Z'))).toBe('2026-W40'); // Sunday
    expect(isoWeek(new Date('2026-10-05T00:00:00Z'))).toBe('2026-W41'); // Monday
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(nextWeekStart(new Date('2026-10-01T12:00:00Z')).toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('agency progression', () => {
  it('adds a desk per level, from 3 to 7', () => {
    expect([0, 499, 500, 1500, 3000, 5000, 99999].map((p) => agencyLevel(p))).toEqual([1, 1, 2, 3, 4, 5, 5]);
    expect([1, 3, 5, 9].map(desksForLevel)).toEqual([3, 5, 7, 7]);
  });
});

describe('talent pool', () => {
  it('is stable within a week, differs between weeks, and covers every specialty', () => {
    const a = talentPool('agency-1', '2026-W40');
    expect(talentPool('agency-1', '2026-W40')).toEqual(a);
    expect(talentPool('agency-1', '2026-W41')).not.toEqual(a);
    expect(a).toHaveLength(10);
    expect(new Set(a.map((c) => c.specialty))).toEqual(new Set(SPECIALTIES));
    for (const c of a) {
      expect(c.skill).toBeGreaterThanOrEqual(1);
      expect(c.skill).toBeLessThanOrEqual(5);
      expect(c.candidateKey).toMatch(/^2026-W40:\d+$/);
    }
  });
});

describe('sessions', () => {
  const secret = 's'.repeat(40);
  it('round-trips and expires', () => {
    const { token } = issueSession(secret, 'user-1', 60, 1_000_000_000_000);
    expect(verifySession(secret, token, 1_000_000_000_000 + 59 * 60_000)?.userId).toBe('user-1');
    expect(verifySession(secret, token, 1_000_000_000_000 + 61 * 60_000)).toBeUndefined();
  });
  it('rejects forged, re-signed and alg-swapped tokens', () => {
    const { token } = issueSession(secret, 'user-1', 60);
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ iss: 'pixel-agency', sub: 'admin', iat: 1, exp: 9_999_999_999 })).toString('base64url');
    expect(verifySession(secret, `${h}.${forged}.${s}`)).toBeUndefined();
    expect(verifySession('x'.repeat(40), token)).toBeUndefined();
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(verifySession(secret, `${none}.${p}.`)).toBeUndefined();
    expect(verifySession(secret, 'garbage')).toBeUndefined();
  });
});

describe('config', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db', SESSION_SECRET: 'k'.repeat(40), AI_ARENA_API_URL: 'https://api.example.com',
    AI_INFRA_URL: 'http://ai-infrastructure:10000', AI_INFRA_KEY_ID: 'pixel-agency', AI_INFRA_SECRET: 'A'.repeat(43),
  };
  it('fails closed on missing secrets and wildcard CORS', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: '' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, CORS_ORIGINS: '*' })).toThrow(/not \*/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'http://game.example.com' })).toThrow(/https/);
    expect(loadConfig({ ...base, CORS_ORIGINS: 'https://game.example.com, http://localhost:5173' }).corsOrigins).toEqual(['https://game.example.com', 'http://localhost:5173']);
  });
});
