import { z } from 'zod';
import { unauthorized, upstreamUnavailable } from '../api/errors';

/**
 * Reads the signed-in player and their agents from the AI Arena gateway,
 * forwarding the player's own AI Arena token. The gateway is the only
 * authority on who the player is and which agents they own.
 */

const userSchema = z.object({
  user: z.object({
    id: z.string().min(1),
    walletAddress: z.string().nullable().optional(),
    username: z.string().nullable().optional(),
  }),
});

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  clan: z.string().nullable().optional(),
  archetype: z.string().nullable().optional(),
  evolutionStage: z.string().nullable().optional(),
  eloRating: z.number().nullable().optional(),
  isRetired: z.boolean().optional(),
});
const agentsSchema = z.object({ agents: z.array(z.unknown()) });

export interface ArenaAgent {
  id: string;
  name: string;
  clan: string | null;
  archetype: string | null;
  evolutionStage: string | null;
  eloRating: number | null;
  isRetired: boolean;
}

export interface ArenaIdentity {
  userId: string;
  walletAddress: string | null;
  username: string | null;
  agents: ArenaAgent[];
}

export interface ArenaGateway {
  identify(aiArenaToken: string): Promise<ArenaIdentity>;
}

export class AiArenaClient implements ArenaGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  private async get(path: string, token: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: controller.signal });
    } catch {
      throw upstreamUnavailable('AI Arena is unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw unauthorized('AI Arena session is invalid or expired');
    if (!res.ok) throw upstreamUnavailable(`AI Arena answered ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw upstreamUnavailable('AI Arena returned an unreadable response');
    }
  }

  async identify(aiArenaToken: string): Promise<ArenaIdentity> {
    const [me, mine] = await Promise.all([this.get('/v1/auth/me', aiArenaToken), this.get('/v1/agents/mine?limit=100', aiArenaToken)]);
    const user = userSchema.safeParse(me);
    const list = agentsSchema.safeParse(mine);
    if (!user.success || !list.success) throw upstreamUnavailable('AI Arena returned an unexpected response');
    // One malformed agent should not lock the player out; skip it.
    const agents = list.data.agents.flatMap((a) => {
      const r = agentSchema.safeParse(a);
      if (!r.success) return [];
      const x = r.data;
      return [{ id: x.id, name: x.name, clan: x.clan ?? null, archetype: x.archetype ?? null, evolutionStage: x.evolutionStage ?? null, eloRating: x.eloRating ?? null, isRetired: x.isRetired ?? false }];
    });
    return { userId: user.data.user.id, walletAddress: user.data.user.walletAddress ?? null, username: user.data.user.username ?? null, agents };
  }
}
