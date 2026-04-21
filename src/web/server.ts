/**
 * Small web server for health checks, unsubscribe links, and the operator dashboard.
 */
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import { createRateLimiterMiddleware } from '../utils/rate-limiter.js';
import { dashboardSummaryHandler } from './routes/dashboard-api.js';
import { unsubscribeHandler } from './routes/unsubscribe.js';

const healthHandler: RequestHandler = (_req, res) => {
  res.status(200).json({ status: 'ok' });
};

/**
 * Starts the unsubscribe web server.
 * Phase 5 can import and call this from the main entrypoint.
 */
export function startWebServer(port = config.unsub.port): Server {
  const app = express();
  const unsubscribeRateLimiter = createRateLimiterMiddleware();
  // Dashboard summary hits Google Sheets several times — keep abuse away from the API quota.
  const dashboardApiLimiter = createRateLimiterMiddleware({
    maxRequests: 24,
    windowMs: 60_000,
  });

  const publicRoot = path.join(process.cwd(), 'public');

  app.get('/health', healthHandler);
  app.get('/unsubscribe', unsubscribeRateLimiter, unsubscribeHandler);
  app.get('/api/dashboard/summary', dashboardApiLimiter, dashboardSummaryHandler);
  app.use('/dashboard', express.static(path.join(publicRoot, 'dashboard'), { index: 'index.html' }));

  const server = app.listen(port, () => {
    logger.info(
      { module: 'web', port },
      'Web server listening (health, unsubscribe, dashboard)',
    );
  });

  return server;
}

// Auto-start only when this file is run directly (not when imported by tests/scripts).
const isDirectRun = process.argv[1] !== undefined
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectRun) {
  startWebServer();
}
