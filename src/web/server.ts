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
import { buildHealthPayload, healthHttpStatus } from '../ops/health-checks.js';

const healthHandler: RequestHandler = async (_req, res) => {
  try {
    const payload = await buildHealthPayload();
    res.status(healthHttpStatus(payload)).json(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'web', error: message }, '/health failed');
    res.status(503).json({
      status: 'failed' as const,
      error: message,
      appEnv: config.app.appEnv,
      safeMode: config.app.safeMode,
      dryRun: config.app.dryRun,
      emailMode: config.app.emailMode,
      deploy: {
        sha: '',
        branch: '',
        time: '',
        deployer: '',
        appEnv: config.app.appEnv,
      },
      checks: { webServer: 'fail' as const },
    });
  }
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

  // Dashboard static root: anchored to this file (`src/web/` or compiled `dist/web/`) so the
  // correct `public/dashboard` is used even when `process.cwd()` is not the repo root (PM2).
  const webDir = path.dirname(fileURLToPath(import.meta.url));
  const dashboardDir = path.resolve(webDir, '..', '..', 'public', 'dashboard');
  const dashboardIndex = path.resolve(dashboardDir, 'index.html');
  const sendDashboardIndex: RequestHandler = (_req, res) => {
    res.sendFile(dashboardIndex);
  };

  // `/` is registered below when admin UI is enabled (redirect → /admin/).
  app.get('/health', healthHandler);
  app.get('/unsubscribe', unsubscribeRateLimiter, unsubscribeHandler);
  app.use('/api/dashboard', createDashboardRouter());
  // Dashboard HTML entry — register BOTH exact paths before any static mount so no router or
  // serve-static slash logic can ever turn `/dashboard/` into a redirect (we have seen Express 5
  // + serve-static loop on that exact URL even with `redirect: false`).
  app.get('/dashboard', sendDashboardIndex);
  app.get('/dashboard/', sendDashboardIndex);
  // Static assets like `/dashboard/app.js`, `/dashboard/style.css`, etc.
  app.use(
    '/dashboard',
    express.static(dashboardDir, { index: false, redirect: false }),
  );

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
