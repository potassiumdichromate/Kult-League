import { describe, expect, it } from 'vitest';
import { AiArenaMindKeys, looksLikeArenaMindKey } from '../../src/clients/arena-minds';

const KEY = 'kult_mk_' + 'a'.repeat(43);
const me = { agent: { agentId: 'agent-1' }, ownerUserId: 'user-1', mind: { mindId: 'mind-1', name: 'Gaffer' } };

describe('AI Arena Mind keys', () => {
  it('recognises only full kult keys', () => {
    expect(looksLikeArenaMindKey(KEY)).toBe(true);
    for (const bad of [undefined, 'kult_mk_short', 'pa_mk_' + 'a'.repeat(43), ['kult_mk_x']]) expect(looksLikeArenaMindKey(bad)).toBe(false);
  });

  it('asks AI Arena whose key it is, then caches the answer briefly', async () => {
    const calls: Array<{ url: string; key: string | null }> = [];
    let clock = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, key: new Headers(init.headers).get('x-mind-key') });
      return new Response(JSON.stringify(me), { status: 200 });
    }) as unknown as typeof fetch;
    const keys = new AiArenaMindKeys('https://gw.test', fetchImpl, 60_000, () => clock);
    expect(await keys.resolve(KEY)).toEqual({ agentId: 'agent-1', ownerUserId: 'user-1', mindId: 'mind-1', mindName: 'Gaffer' });
    expect(calls).toEqual([{ url: 'https://gw.test/v1/marketplace/mind/me', key: KEY }]);
    await keys.resolve(KEY);
    expect(calls).toHaveLength(1);
    clock = 61_000; // past the cache: a revoked key stops working within a minute
    await keys.resolve(KEY);
    expect(calls).toHaveLength(2);
  });

  it('an unknown key is undefined; an outage is an error, never a pass', async () => {
    const respond = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await new AiArenaMindKeys('https://gw', respond(401)).resolve(KEY)).toBeUndefined();
    await expect(new AiArenaMindKeys('https://gw', respond(502)).resolve(KEY)).rejects.toMatchObject({ statusCode: 503 });
    await expect(new AiArenaMindKeys('https://gw', respond(200, { agent: {} })).resolve(KEY)).rejects.toMatchObject({ statusCode: 503 });
  });
});
