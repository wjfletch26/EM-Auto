/**
 * Config loader — reads .env, validates with Zod, exports a typed singleton.
 *
 * Usage:
 *   import { config } from './config/index.js';
 *   console.log(config.smtp.host);
 *
 * If any required env var is missing or invalid, the process exits with a clear error message.
 */

import dotenv from 'dotenv';
import { configSchema, type AppConfig } from './schema.js';

// Load .env from project root into process.env
dotenv.config();

/**
 * Maps flat process.env vars into the nested shape the Zod schema expects.
 * This keeps the schema clean and lets us rename env vars without touching business logic.
 */
function buildRawConfig() {
  const env = process.env;

  return {
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      secure: env.SMTP_SECURE,
      fromName: env.SMTP_FROM_NAME,
      replyForwardTo: env.REPLY_FORWARD_TO,
    },
    imap: {
      enabled: env.IMAP_ENABLED,
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      user: env.IMAP_USER,
      pass: env.IMAP_PASS,
    },
    google: {
      serviceAccountPath: env.GOOGLE_SERVICE_ACCOUNT_PATH,
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    },
    unsub: {
      secret: env.UNSUB_SECRET,
      baseUrl: env.UNSUB_BASE_URL,
      expiryDays: env.UNSUB_EXPIRY_DAYS,
      port: env.UNSUB_PORT,
    },
    schedule: {
      sendCron: env.SEND_CRON,
      replyCron: env.REPLY_CRON,
      sendDelayMs: env.SEND_DELAY_MS,
      sendBatchSize: env.SEND_BATCH_SIZE,
    },
    logging: {
      level: env.LOG_LEVEL,
      dir: env.LOG_DIR,
      retentionDays: env.LOG_RETENTION_DAYS,
    },
    app: {
      nodeEnv: env.NODE_ENV,
      physicalAddress: env.PHYSICAL_ADDRESS,
    },
  };
}

/**
 * Validate and freeze the config. Exits the process on validation failure
 * so we fail fast instead of running with broken config.
 */
function loadConfig(): AppConfig {
  const raw = buildRawConfig();
  const result = configSchema.safeParse(raw);

  if (!result.success) {
    // Format Zod errors into readable lines for the operator
    const errors = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`
    );

    // eslint-disable-next-line no-console
    console.error('CONFIG VALIDATION FAILED:\n' + errors.join('\n'));
    process.exit(1);
  }

  return Object.freeze(result.data) as AppConfig;
}

/** Singleton config — validated at import time. */
export const config: AppConfig = loadConfig();

/**
 * Returns a copy of config with sensitive fields redacted.
 * Safe for logging at startup.
 */
export function getRedactedConfig(): Record<string, unknown> {
  return {
    smtp: {
      host: config.smtp.host,
      port: config.smtp.port,
      user: config.smtp.user,
      pass: '***REDACTED***',
      secure: config.smtp.secure,
      fromName: config.smtp.fromName,
      replyForwardTo: config.smtp.replyForwardTo,
    },
    imap: {
      enabled: config.imap.enabled,
      host: config.imap.host,
      port: config.imap.port,
    },
    google: {
      serviceAccountPath: config.google.serviceAccountPath,
      spreadsheetId: config.google.spreadsheetId,
    },
    unsub: {
      secret: '***REDACTED***',
      baseUrl: config.unsub.baseUrl,
      expiryDays: config.unsub.expiryDays,
      port: config.unsub.port,
    },
    schedule: config.schedule,
    logging: config.logging,
    app: config.app,
  };
}
