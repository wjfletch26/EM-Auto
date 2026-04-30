/**
 * Web server: health, unsubscribe, admin API, and optional admin SPA.
 */
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import { createRateLimiterMiddleware } from '../utils/rate-limiter.js';
import { createDashboardRouter } from './routes/dashboard-router.js';
import { unsubscribeHandler } from './routes/unsubscribe.js';
import { requireAdminApiKey } from './middleware/admin-auth.js';
import { createAdminRouter } from './routes/admin/router.js';

const healthHandler: RequestHandler = (_req, res) => {
  res.status(200).json({ status: 'ok' });
};

/** Absolute path to Vite build output (`npm run build:admin`). */
function getAdminStaticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../dist/admin');
}

/**
 * Starts the unsubscribe web server.
 * Phase 5 can import and call this from the main entrypoint.
 */
export function startWebServer(port = config.unsub.port): Server {
  const app = express();
  const unsubscribeRateLimiter = createRateLimiterMiddleware();

  const publicRoot = path.join(process.cwd(), 'public');

  app.get('/', rootHandler);
  app.get('/health', healthHandler);
  app.get('/unsubscribe', unsubscribeRateLimiter, unsubscribeHandler);
  app.use('/api/dashboard', createDashboardRouter());
  app.use('/dashboard', express.static(path.join(publicRoot, 'dashboard'), { index: 'index.html' }));

  app.use('/api/admin', express.json({ limit: '10mb' }), requireAdminApiKey, createAdminRouter());

  app.use(
    (err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!req.originalUrl.startsWith('/api/admin')) {
        next(err);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ module: 'web', path: req.path, error: message }, 'Admin API error');
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    },
  );

  if (config.admin.apiKey && config.admin.uiEnabled) {
    const adminDir = getAdminStaticDir();
    // Root URL has no static files — send operators straight to the SPA.
    app.get('/', (_req, res) => {
      res.redirect(302, '/admin/');
    });
    app.use('/admin', express.static(adminDir));
    app.use('/admin', (_req, res) => {
      res.sendFile(path.join(adminDir, 'index.html'));
    });
    logger.info({ module: 'web', adminDir }, 'Admin UI static files mounted at /admin');
  }

  const server = app.listen(port, () => {
    logger.info(
      { module: 'web', port, adminApi: Boolean(config.admin.apiKey) },
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
