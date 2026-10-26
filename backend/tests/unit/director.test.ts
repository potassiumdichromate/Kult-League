import Fastify from 'fastify';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { registerDirectorRoutes } from '../../src/api/director-routes';
import { directorOpenApi } from '../../src/api/director-openapi';
import { MindsClient, mindsSubject } from '../../src/clients/minds';
import { cleanText, decisionProblems, DirectorService, generateDirectorKey, hashDirectorKey, looksLikeDirectorKey, toRecordPicks } from '../../src/game/director';
import type { Picks } from '../../src/game/picks';

const squad = [{ id: '1001', side: 'HOME' as const }, { id: '2001', side: 'AWAY' as const }];
const picks = (over: Partial<Picks> = {}): Picks => ({ outcome: 'HOME', score: { home: 2, away: 1 }, corners: 10, cards: 4, scorerId: '1001', scorerName: 'B', ...over });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('director keys', () => {
  it('are prefixed, random, and stored only as a hash', () => {
    const a = generateDirectorKey();
    const b = generateDirectorKey();
    expect(a.key).toMatch(/^pa_mk_[A-Za-z0-9_-]{43}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.hash).toBe(hashDirectorKey(a.key));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.key.startsWith(a.prefix)).toBe(true);
    expect(looksLikeDirectorKey(a.key)).toBe(true);
    for (const bad of [undefined, 'pa_mk_short', `arena_mk_${'x'.repeat(43)}`, ['pa_mk_x'], `pa_mk_${'x'.repeat(200)}`]) expect(looksLikeDirectorKey(bad)).toBe(false);
  });
});

describe('a Mind decision on the record', () => {
  it('maps exact cards and corners onto the record\'s over/under lines', () => {
    expect(toRecordPicks(picks())).toEqual({ result: 'HOME', score: { home: 2, away: 1 }, totalCards: 'UNDER', totalCorners: 'OVER', scorerId: '1001' });
    expect(toRecordPicks(picks({ cards: 5, corners: 9 }))).toMatchObject({ totalCards: 'OVER', totalCorners: 'UNDER' });
  });

  it('catches everything the record would reject before anything is locked', () => {
    expect(decisionProblems(picks(), squad)).toEqual([]);
    expect(decisionProblems(picks({ outcome: 'AWAY' }), squad)).toEqual(['the exact score must agree with the outcome']);
    expect(decisionProblems(picks({ scorerId: '9999' }), squad)).toEqual(['the goal scorer must be a player in either squad']);
    expect(decisionProblems(picks({ outcome: 'HOME', score: { home: 1, away: 0 }, scorerId: '2001' }), squad)).toEqual(['the goal scorer plays for a side your score says will not score']);
    expect(decisionProblems(picks({ scorerId: null }), squad)).toEqual([]);
  });

  it('strips control characters from the Mind\'s words', () => {
    expect(cleanText(' why\u0000\u0007 now\n ')).toBe('why now');
  });
});

describe('Minds client', () => {
  const token = `${b64({ alg: 'RS256' })}.${b64({ sub: 'user/1' })}.sig`;

  it('reads the token subject without trusting anything else', () => {
    expect(mindsSubject(token)).toBe('user/1');
    expect(mindsSubject('nope')).toBeUndefined();
    expect(mindsSubject(`a.${b64({ sub: 7 })}.c`)).toBeUndefined();
  });

  it('proves the token by listing the account\'s Minds with it', async () => {
    let seen = { url: '', auth: '' };
    const fetchImpl = (async (u: string, init: RequestInit) => {
      seen = { url: u, auth: new Headers(init.headers).get('authorization') ?? '' };
      return new Response(JSON.stringify([{ mindId: 'm1', name: 'Gaffer', email: 'g@hellominds.ai', model: 'x' }, { name: 'no id' }]), { status: 200 });
    }) as unknown as typeof fetch;
    const id = await new MindsClient('https://api.build.hellominds.ai', fetchImpl).identify(token);
    expect(seen).toEqual({ url: 'https://api.build.hellominds.ai/v1/users/user%2F1/minds', auth: `Bearer ${token}` });
    expect(id).toEqual({ mindsUserId: 'user/1', minds: [{ mindId: 'm1', name: 'Gaffer', email: 'g@hellominds.ai', model: 'x' }] });
  });

  it('maps a rejected token to 401 and an outage to 503', async () => {
    const respond = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    await expect(new MindsClient('https://m', respond(401)).identify(token)).rejects.toMatchObject({ statusCode: 401 });
    await expect(new MindsClient('https://m', respond(500)).identify(token)).rejects.toMatchObject({ statusCode: 503 });
    await expect(new MindsClient('https://m', respond(200)).identify('garbage')).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('director OpenAPI spec', () => {
  it('lists only registered routes', async () => {
    const app = Fastify({ logger: false });
    registerDirectorRoutes(app, new DirectorService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { lockMinutesBeforeKickoff: 5 }, pino({ level: 'silent' })), { sessionSecret: 's'.repeat(32), publicApiUrl: 'https://x.test' });
    await app.ready();
    const spec = directorOpenApi('https://x.test');
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods)) {
        const route = path.replace(/\{(\w+)\}/g, ':$1');
        expect(app.hasRoute({ method: method.toUpperCase() as 'GET', url: route }), `${method} ${route}`).toBe(true);
      }
    }
    await app.close();
  });
});
