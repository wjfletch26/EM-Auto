/**
 * Main application entrypoint.
 *
 * Startup flow:
 * 1) Validate and log config
 * 2) Verify SMTP connection (skipped when email mode is simulated send)
 * 3) Start web server
 * 4) Start scheduler when SCHEDULER_ENABLED / APP_ENV allows it
 *
 * Shutdown flow:
 * - Stop scheduler
 * - Close web server
 * - Close SMTP connection
 */
import type { Server } from "node:http";
import {
  config,
  getRedactedConfig,
  getStartupEnvironmentSummary,
} from "./config/index.js";
import { logger, cleanOldLogs } from "./logging/logger.js";
import { verifyConnection, disconnect } from "./services/smtp.js";
import { startWebServer } from "./web/server.js";
import { startScheduler, type SchedulerHandle } from "./scheduler/cron.js";

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

  logger.info(
    { module: "main", ...getStartupEnvironmentSummary() },
    "Runtime environment",
  );

  logger.info(
    { module: "main", config: getRedactedConfig() },
    "Configuration loaded",
  );

  const smtpOk = await verifyConnection();
  if (!smtpOk) {
    throw new Error("Startup aborted: SMTP verification failed");
  }

  server = startWebServer(config.unsub.port);

  if (config.app.schedulerEnabled) {
    scheduler = startScheduler();
    logger.info(
      {
        module: "main",
        scheduler: "started",
        schedulerEnabled: true,
      },
      "Scheduler started",
    );
  } else {
    logger.info(
      {
        module: "main",
        scheduler: "skipped",
        schedulerEnabled: false,
        appEnv: config.app.appEnv,
      },
      "Scheduler disabled (manual/admin triggers only)",
    );
  }

  logger.info({ module: "main" }, "Application started");
}

/**
 * Stops background jobs and open connections.
 */
export async function shutdownApplication(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ module: "main", signal }, "Shutdown started");

  try {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }

    if (server) {
      await closeServerGracefully(server);
      server = null;
      logger.info({ module: "main" }, "Web server closed");
    }

    await disconnect();

    logger.info({ module: "main" }, "Shutdown complete");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ module: "main", error: message }, "Shutdown failed");
  }
}

async function handleSignal(signal: string): Promise<void> {
  await shutdownApplication(signal);
  process.exit(0);
}

process.once("SIGINT", () => {
  void handleSignal("SIGINT");
});

process.once("SIGTERM", () => {
  void handleSignal("SIGTERM");
});

// Run startup when executed directly (`npm start` / `node dist/main.js`).
startApplication().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(
    { module: "main", error: message },
    "Application failed to start",
  );
  process.exit(1);
});
