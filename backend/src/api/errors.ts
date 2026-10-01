import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { z, ZodTypeAny } from 'zod';

/**
 * Errors whose `message` is safe to return to the caller. Anything else is
 * reported as a generic 500 — internals, SQL, stack traces and upstream
 * provider messages never leave the service.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string) => new AppError(400, 'bad_request', message);
export const notFound = (message = 'not found') => new AppError(404, 'not_found', message);
export const unauthorized = (message = 'sign in required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message: string) => new AppError(403, 'forbidden', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const insufficientCredits = (message: string) => new AppError(402, 'insufficient_credits', message);
export const tooMany = (message: string) => new AppError(429, 'limit_reached', message);
export const upstreamUnavailable = (message: string) => new AppError(503, 'upstream_unavailable', message);

/** Validate with zod; the error names failing fields, never echoes their values. */
export function parseOrThrow<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const res = schema.safeParse(value);
  if (!res.success) {
    const fields = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw badRequest(`invalid request: ${fields.join('; ')}`);
  }
  return res.data;
}

// Statuses Fastify itself raises for malformed input; their built-in messages are generic.
const PASS_THROUGH: Record<number, string> = {
  400: 'bad_request',
  404: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  const correlationId = req.id;

  if (err instanceof AppError) {
    if (err.statusCode >= 500) req.log.error({ err }, 'request failed');
    reply.status(err.statusCode).send({ error: err.code, message: err.message, correlationId });
    return;
  }

  const status = (err as FastifyError).statusCode;
  if (status && PASS_THROUGH[status]) {
    req.log.warn({ statusCode: status, code: (err as FastifyError).code }, 'request rejected');
    reply.status(status).send({ error: PASS_THROUGH[status], correlationId });
    return;
  }

  req.log.error({ err }, 'unhandled error');
  reply.status(500).send({ error: 'internal_error', correlationId });
}
