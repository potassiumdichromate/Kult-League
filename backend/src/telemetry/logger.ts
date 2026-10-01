import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { LoggerOptions } from 'pino';

/**
 * Structured JSON logs. Bodies are never logged; known secret-bearing fields
 * are redacted wherever they appear, as a second line of defence.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.secret',
  '*.password',
  '*.privateKey',
  '*.apiKey',
  '*.token',
  '*.databaseUrl',
  '*.redisUrl',
  'secret',
  'privateKey',
  'apiKey',
];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: { service: 'pixel-agency' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  };
}

export const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Accept a caller-supplied correlation id when it is well formed, so one id
 * follows a request across services; otherwise mint one. A malformed value
 * is replaced, never reflected (log/header injection).
 */
export function genCorrelationId(req: IncomingMessage): string {
  const incoming = req.headers[CORRELATION_HEADER];
  if (typeof incoming === 'string' && CORRELATION_PATTERN.test(incoming)) return incoming;
  return randomUUID();
}
