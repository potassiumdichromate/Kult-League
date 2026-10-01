import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AiArenaClient } from '../../src/clients/ai-arena';
import { AiInfraClient } from '../../src/clients/ai-infra';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AiArenaClient', () => {
  it('reads the player and their agents with the player\'s own token, skipping malformed agents', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const client = new AiArenaClient('https://api.example.com', (async (u: string, init: RequestInit) => {
      seen.push({ url: String(u), auth: new Headers(init.headers).get('authorization') });
      return String(u).includes('/auth/me')
        ? json({ user: { id: 'u1', walletAddress: '0xabc', username: null } })
        : json({ agents: [{ id: 'a1', name: 'Kraken', clan: 'ZEROG', isRetired: false }, { name: 'no id' }] });
    }) as typeof fetch);
    const id = await client.identify('tok');
    expect(id).toMatchObject({ userId: 'u1', walletAddress: '0xabc', agents: [{ id: 'a1', name: 'Kraken', clan: 'ZEROG', isRetired: false }] });
    expect(seen.map((s) => s.url).sort()).toEqual(['https://api.example.com/v1/agents/mine?limit=100', 'https://api.example.com/v1/auth/me']);
    expect(seen.every((s) => s.auth === 'Bearer tok')).toBe(true);
  });

  it('maps an expired AI Arena token to 401 and outages to 503', async () => {
    await expect(new AiArenaClient('https://x', (async () => json({}, 401)) as typeof fetch).identify('t')).rejects.toMatchObject({ statusCode: 401 });
    await expect(new AiArenaClient('https://x', (async () => json({}, 502)) as typeof fetch).identify('t')).rejects.toMatchObject({ statusCode: 503 });
    await expect(new AiArenaClient('https://x', (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch).identify('t')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('AiInfraClient', () => {
  const secret = Buffer.alloc(32, 7);
  it('signs requests with HMAC scheme v1', async () => {
    let headers = new Headers();
    let url = '';
    const client = new AiInfraClient({ url: 'http://ai:10000', keyId: 'pixel-agency', secret: secret.toString('base64url') }, (async (u: string, init: RequestInit) => {
      url = String(u);
      headers = new Headers(init.headers);
      return json({ fixtureId: 1 });
    }) as typeof fetch);
    await client.research(1, 'weather');
    expect(url).toBe('http://ai:10000/v1/football/fixtures/1/research/weather');
    const canonical = ['v1', 'GET', '/v1/football/fixtures/1/research/weather', headers.get('x-aii-timestamp'), headers.get('x-aii-nonce'), createHash('sha256').update('').digest('hex')].join('\n');
    expect(headers.get('x-aii-key-id')).toBe('pixel-agency');
    expect(headers.get('x-aii-signature')).toBe(createHmac('sha256', secret).update(canonical).digest('hex'));
  });

  it('passes through actionable errors only', async () => {
    const answer = (status: number, body: unknown) => new AiInfraClient({ url: 'http://ai', keyId: 'k', secret: secret.toString('base64') }, (async () => json(body, status)) as typeof fetch);
    await expect(answer(409, { message: 'predictions are closed' }).context(1)).rejects.toMatchObject({ statusCode: 409, message: 'predictions are closed' });
    await expect(answer(404, {}).context(1)).rejects.toMatchObject({ statusCode: 404 });
    await expect(answer(401, { message: 'bad signature' }).context(1)).rejects.toMatchObject({ statusCode: 503 });
  });
});
