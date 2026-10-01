import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The game's own session token: a compact HS256 JWT carrying the AI Arena
 * user id. Issued after the AI Arena token has been checked against the
 * AI Arena gateway, so the game never needs AI Arena's signing secret.
 * Only HS256 is accepted; `alg` is fixed, never read from the token.
 */

export interface Session {
  userId: string;
  issuedAt: number;
  expiresAt: number;
}

const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const ISSUER = 'pixel-agency';

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString('base64url');
}

function sign(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueSession(secret: string, userId: string, ttlMinutes: number, now = Date.now()): { token: string; expiresAt: Date } {
  const iat = Math.floor(now / 1000);
  const exp = iat + ttlMinutes * 60;
  const payload = b64url(JSON.stringify({ iss: ISSUER, sub: userId, iat, exp }));
  const data = `${HEADER}.${payload}`;
  return { token: `${data}.${sign(secret, data)}`, expiresAt: new Date(exp * 1000) };
}

/** Returns the session, or undefined for anything malformed, forged or expired. */
export function verifySession(secret: string, token: string, now = Date.now()): Session | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return undefined;
  const expected = Buffer.from(sign(secret, `${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  let claims: { iss?: unknown; sub?: unknown; iat?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (claims.iss !== ISSUER || typeof claims.sub !== 'string' || typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return undefined;
  if (claims.exp * 1000 <= now) return undefined;
  return { userId: claims.sub, issuedAt: claims.iat, expiresAt: claims.exp };
}
