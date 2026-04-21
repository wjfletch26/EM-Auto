/**
 * Protects dashboard routes that expose PII or perform spreadsheet / LLM mutations.
 * Operators set `DASHBOARD_SECRET` in `.env` and send `X-Dashboard-Token: <secret>` on each request.
 */

import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { config } from '../config/index.js';

function timingSafeEqualString(expected: string, received: string): boolean {
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Rejects requests when the secret is not configured, or the header does not match.
 */
export const requireDashboardAuth: RequestHandler = (req, res, next) => {
  const expected = config.dashboard.secret.trim();
  if (!expected) {
    res.status(403).json({
      error: 'Dashboard operator APIs are disabled',
      hint: 'Set DASHBOARD_SECRET in your .env file, restart the app, then send the same value in the X-Dashboard-Token header.',
    });
    return;
  }

  const token = (req.header('x-dashboard-token') ?? '').trim();
  if (!timingSafeEqualString(expected, token)) {
    res.status(401).json({ error: 'Invalid or missing X-Dashboard-Token header' });
    return;
  }

  next();
};
