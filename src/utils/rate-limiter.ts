/**
 * Very small in-memory rate limiter middleware.
 *
 * This is intentionally simple for the unsubscribe endpoint:
 * - default: max 10 requests per IP per 60 seconds
 * - process-local memory (resets on restart)
 */
import type { RequestHandler } from 'express';

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type RateLimiterOptions = {
  maxRequests?: number;
  windowMs?: number;
};

/**
 * Creates an Express middleware that limits requests by client IP.
 * The endpoint only needs basic abuse protection, so a Map is enough.
 */
export function createRateLimiterMiddleware(options: RateLimiterOptions = {}): RequestHandler {
  const maxRequests = options.maxRequests ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const store = new Map<string, RateLimitEntry>();

  return (req, res, next) => {
    // req.ip is populated by Express and may include proxy handling later.
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const existing = store.get(ip);

    if (!existing || now > existing.resetAt) {
      store.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > maxRequests) {
      res.status(429).type('text/plain').send('Too many requests');
      return;
    }

    next();
  };
}
