/**
 * POST hardening for the local console. Mutating routes must look like they
 * came from the console's own page on a loopback origin:
 *   - Origin/Referer, when present, must name a loopback host (blocks
 *     cross-site browser POSTs; sandboxed "null" origins are rejected too);
 *   - the media type must be exactly application/json (a cross-site form or
 *     text/plain fetch cannot produce it without a CORS preflight);
 *   - the per-session CSRF token the page embeds must be echoed in the
 *     x-harness-csrf header (compared in constant time).
 * Local non-browser tools stay usable by scraping the token from GET /.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isLoopbackHost } from './http.js';

export class GuardError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GuardError';
    this.status = status;
  }
}

export function createCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

function urlIsLoopback(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function assertLocalNavigation(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && !urlIsLoopback(origin)) {
    throw new GuardError(
      403,
      'cross-site origin rejected — the console only accepts local requests',
    );
  }
  const referer = req.headers.referer;
  if (typeof referer === 'string' && !urlIsLoopback(referer)) {
    throw new GuardError(
      403,
      'cross-site referer rejected — the console only accepts local requests',
    );
  }
}

function assertJsonContentType(req: IncomingMessage): void {
  const mediaType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new GuardError(415, 'mutating routes accept application/json bodies only');
  }
}

function assertCsrf(req: IncomingMessage, sessionToken: string): void {
  const presented = req.headers['x-harness-csrf'];
  const token = Array.isArray(presented) ? presented[0] : presented;
  if (!token) throw new GuardError(403, 'missing CSRF token — reload the console page');
  const presentedBuf = Buffer.from(token);
  const sessionBuf = Buffer.from(sessionToken);
  if (presentedBuf.length !== sessionBuf.length || !timingSafeEqual(presentedBuf, sessionBuf)) {
    throw new GuardError(403, 'invalid CSRF token — reload the console page');
  }
}

/** Full guard for a mutating (POST) console route. */
export function assertLocalPost(req: IncomingMessage, sessionToken: string): void {
  assertLocalNavigation(req);
  assertJsonContentType(req);
  assertCsrf(req, sessionToken);
}
