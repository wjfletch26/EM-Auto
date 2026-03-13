/**
 * Structured JSON logger using Pino.
 *
 * - Writes to stdout (for development / pino-pretty) and to a daily log file.
 * - Handles log directory creation and file rotation by date.
 * - Old log files are cleaned up based on LOG_RETENTION_DAYS.
 *
 * Usage:
 *   import { logger } from './logging/logger.js';
 *   logger.info({ module: 'sheets', contactEmail: 'a@b.com' }, 'Row updated');
 */

import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

// --- Ensure the log directory exists ---
const logDir = path.resolve(config.logging.dir);
fs.mkdirSync(logDir, { recursive: true });

/**
 * Builds the path for today's log file.
 * Format: app-YYYY-MM-DD.log
 */
function todayLogFile(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(logDir, `app-${date}.log`);
}

/**
 * Creates a Pino multistream that writes to both stdout (pretty) and a file (JSON).
 * In production, stdout is JSON too — pino-pretty is for dev convenience.
 */
function buildTransport(): pino.TransportMultiOptions {
  const targets: pino.TransportTargetOptions[] = [];

  // Pretty output to stdout in development, plain JSON in production
  if (config.app.nodeEnv === 'development') {
    targets.push({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
      level: config.logging.level,
    });
  } else {
    targets.push({
      target: 'pino/file',
      options: { destination: 1 }, // fd 1 = stdout
      level: config.logging.level,
    });
  }

  // Always write JSON to a daily log file for durable records
  targets.push({
    target: 'pino/file',
    options: { destination: todayLogFile(), mkdir: true },
    level: config.logging.level,
  });

  return { targets };
}

/** The singleton logger instance used throughout the application. */
export const logger = pino({
  level: config.logging.level,
  transport: buildTransport(),
});

/**
 * Deletes log files older than the configured retention period.
 * Called once at startup so old files don't accumulate on the VPS.
 */
export function cleanOldLogs(): void {
  const maxAge = config.logging.retentionDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let files: string[];
  try {
    files = fs.readdirSync(logDir);
  } catch {
    return; // Directory might not exist yet — that's fine
  }

  for (const file of files) {
    if (!file.startsWith('app-') || !file.endsWith('.log')) continue;

    const filePath = path.join(logDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(filePath);
        logger.info({ module: 'logger', file }, 'Deleted old log file');
      }
    } catch {
      // Skip files we can't stat — not critical
    }
  }
}
