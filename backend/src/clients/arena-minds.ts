import { createHash } from 'node:crypto';
import { upstreamUnavailable } from '../api/errors';

/**
 * A Mind linked to an AI Arena agent (0g-AIArena docs/minds/AGENT_MINDS.md)
 * holds one key for every KULT product: `kult_mk_…`. Pixel Agency accepts it
 * in place of its own director key by asking AI Arena whose it is
 * (GET /v1/marketplace/mind/me with the key). AI Arena stays the only
 * authority on agents and their Minds; this service never stores the key.
 */

export const ARENA_MIND_KEY_PREFIX = 'kult_mk_';

export interface ArenaMind {
  agentId: string;
  ownerUserId: string;
  mindId: string;
  mindName: string | null;
}

export interface ArenaMindKeys {
  /** The agent and Mind behind a key, or undefined for an unknown or revoked key. */
  resolve(key: string): Promise<ArenaMind | undefined>;
}

export function looksLikeArenaMindKey(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(ARENA_MIND_KEY_PREFIX) && v.length >= ARENA_MIND_KEY_PREFIX.length + 40 && v.length <= 100;
}

export const hashKey = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');

export class AiArenaMindKeys implements ArenaMindKeys {
  // Keyed by the key's hash, so the key itself is never held in memory longer than a request.
  private readonly cache = new Map<string, { value: ArenaMind | undefined; until: number }>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(key: string): Promise<ArenaMind | undefined> {
    const id = hashKey(key);
    const hit = this.cache.get(id);
    if (hit && hit.until > this.now()) return hit.value;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/marketplace/mind/me`, { headers: { 'x-mind-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw upstreamUnavailable('AI Arena is unreachable');
    }
    let value: ArenaMind | undefined;
    if (res.status === 401) value = undefined;
    else if (!res.ok) throw upstreamUnavailable(`AI Arena answered ${res.status}`);
    else {
      const body = (await res.json().catch(() => null)) as { agent?: { agentId?: unknown }; ownerUserId?: unknown; mind?: { mindId?: unknown; name?: unknown } } | null;
      const agentId = body?.agent?.agentId, ownerUserId = body?.ownerUserId, mindId = body?.mind?.mindId;
      if (typeof agentId !== 'string' || typeof ownerUserId !== 'string' || typeof mindId !== 'string') throw upstreamUnavailable('AI Arena returned an unexpected response');
      value = { agentId, ownerUserId, mindId, mindName: typeof body?.mind?.name === 'string' ? body.mind.name : null };
    }
    // A revoked key stops working within the cache lifetime; an unknown key is re-checked sooner.
    this.cache.set(id, { value, until: this.now() + (value ? this.ttlMs : 10_000) });
    if (this.cache.size > 5_000) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }
}
