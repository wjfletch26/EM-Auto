/**
 * Main application entrypoint.
 *
 * Startup flow:
 * 1) Validate and log config
 * 2) Verify SMTP connection
 * 3) Start web server
 * 4) Start scheduler
 *
 * Shutdown flow:
 * - Stop scheduler
 * - Close web server
 * - Close SMTP connection
 */
import path from 'node:path';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { config, getRedactedConfig } from './config/index.js';
import { logger, cleanOldLogs } from './logging/logger.js';
import { verifyConnection, disconnect } from './services/smtp.js';
import { startWebServer } from './web/server.js';
import { startScheduler, type SchedulerHandle } from './scheduler/cron.js';

let server: Server | null = null;
let scheduler: SchedulerHandle | null = null;
let isShuttingDown = false;

function closeServerGracefully(activeServer: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    activeServer.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * Starts the integrated application runtime.
 */
export async function startApplication(): Promise<void> {
  cleanOldLogs();

  logger.info({ module: 'main', config: getRedactedConfig() }, 'Configuration loaded');

  const smtpOk = await verifyConnection();
  if (!smtpOk) {
    throw new Error('Startup aborted: SMTP verification failed');
  }

  server = startWebServer(config.unsub.port);
  scheduler = startScheduler();

  logger.info({ module: 'main' }, 'Application started');
}

/**
 * Stops background jobs and open connections.
 */
export async function shutdownApplication(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ module: 'main', signal }, 'Shutdown started');

  try {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }

    if (server) {
      await closeServerGracefully(server);
      server = null;
      logger.info({ module: 'main' }, 'Web server closed');
    }

    await disconnect();

    logger.info({ module: 'main' }, 'Shutdown complete');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'main', error: message }, 'Shutdown failed');
  }
}

async function handleSignal(signal: string): Promise<void> {
  await shutdownApplication(signal);
  process.exit(0);
}

process.once('SIGINT', () => {
  void handleSignal('SIGINT');
});

process.once('SIGTERM', () => {
  void handleSignal('SIGTERM');
});

// Run startup when executed directly (`npm start` / `node dist/main.js`).
const isDirectRun = process.argv[1] !== undefined
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectRun) {
  startApplication().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'main', error: message }, 'Application failed to start');
    process.exit(1);
  });
}
