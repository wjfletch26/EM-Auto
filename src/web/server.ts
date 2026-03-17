/**
 * Small web server for health checks and unsubscribe links.
 */
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import { createRateLimiterMiddleware } from '../utils/rate-limiter.js';
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

  app.get('/health', healthHandler);
  app.get('/unsubscribe', unsubscribeRateLimiter, unsubscribeHandler);

  const server = app.listen(port, () => {
    logger.info(
      { module: 'web', port },
      'Unsubscribe server listening',
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
