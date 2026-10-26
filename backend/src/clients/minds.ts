import { AppError, unauthorized, upstreamUnavailable } from '../api/errors';

/**
 * Hello Minds (Animoca Brands): proves who a Minds Connect access token
 * belongs to and lists their Minds.
 *
 * Minds publishes no JWKS, so the token's signature can't be checked here.
 * The token is used instead: GET /v1/users/{sub}/minds succeeds only if
 * Minds accepts it for that `sub`. It is the path Minds' own client library
 * (@animocabrands/minds-client-lib 0.1.7) calls for listMinds() with an
 * access token; it is not in their published OpenAPI spec, so a change on
 * their side shows up here as a failed link.
 */

export interface MindSummary {
  mindId: string;
  name: string | null;
  email: string | null;
  model: string | null;
}

export interface MindsIdentity {
  mindsUserId: string;
  minds: MindSummary[];
}

export interface MindsGateway {
  identify(accessToken: string): Promise<MindsIdentity>;
}

/** Reads (does not verify) the `sub` of a Minds access token. */
export function mindsSubject(accessToken: string): string | undefined {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.length > 0 && payload.sub.length <= 200 ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

export class MindsClient implements MindsGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async identify(accessToken: string): Promise<MindsIdentity> {
    const sub = mindsSubject(accessToken);
    if (!sub) throw unauthorized('that is not a Minds access token');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/users/${encodeURIComponent(sub)}/minds`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: controller.signal,
      });
    } catch {
      throw upstreamUnavailable('Hello Minds is unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw unauthorized('Hello Minds rejected the sign-in; sign in with Minds again');
    if (!res.ok) throw upstreamUnavailable(`Hello Minds answered ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw upstreamUnavailable('Hello Minds returned an unreadable response');
    }
    const rows = Array.isArray(body) ? body : Array.isArray((body as { items?: unknown })?.items) ? (body as { items: unknown[] }).items : undefined;
    if (!rows) throw new AppError(503, 'upstream_unavailable', 'Hello Minds returned an unexpected response');
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const minds = rows.flatMap((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return typeof o.mindId === 'string' && o.mindId ? [{ mindId: o.mindId, name: str(o.name), email: str(o.email), model: str(o.model) }] : [];
    });
    return { mindsUserId: sub, minds };
  }
}
