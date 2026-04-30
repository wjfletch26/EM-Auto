/**
 * Validates ADMIN_API_KEY for /api/admin routes.
 * Accepts Authorization: Bearer <key> or X-Admin-Key: <key>.
 */
import type { RequestHandler } from 'express';
import { config } from '../../config/index.js';
import { extractAdminKeyFromHeaders } from './admin-key.js';

export const requireAdminApiKey: RequestHandler = (req, res, next) => {
  if (!config.admin.apiKey) {
    res.status(503).json({ error: 'Admin API disabled (set ADMIN_API_KEY to enable)' });
    return;
  }

  const raw = extractAdminKeyFromHeaders(req.headers);
  if (!raw || raw !== config.admin.apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
};
