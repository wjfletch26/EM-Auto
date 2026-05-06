/**
 * Config loader — reads .env files, validates with Zod, exports a typed singleton.
 *
 * Load order (predictable, two-step):
 *   1) Project root `.env`
 *   2) `.env.${APP_ENV}` if present (override), e.g. `.env.local`, `.env.production`
 *
 * APP_ENV is read after step 1 (default `local` for choosing step 2 filename).
 *
 * Usage:
 *   import { config } from './config/index.js';
 *
 * If any required env var is missing or invalid, the process exits with a clear error message.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { configSchema, type AppConfig } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Project root: works from src/config and dist/config. */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Partially redacts a Google Spreadsheet ID for logs (first 4 + last 4 chars).
 */
export function redactSpreadsheetId(spreadsheetId: string): string {
  const s = spreadsheetId.trim();
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// Load base `.env`, then choose APP_ENV and merge `.env.${APP_ENV}` if it exists.
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const bootstrapAppEnv = process.env.APP_ENV ?? 'local';
const envSpecificPath = path.join(PROJECT_ROOT, `.env.${bootstrapAppEnv}`);
if (fs.existsSync(envSpecificPath)) {
  dotenv.config({ path: envSpecificPath, override: true });
}

/**
 * Maps flat process.env vars into the nested shape the Zod schema expects.
 * This keeps the schema clean and lets us rename env vars without touching business logic.
 */
export function buildRawConfig() {
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
      productionSpreadsheetId: env.PRODUCTION_GOOGLE_SPREADSHEET_ID,
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
      appEnv: env.APP_ENV,
      nodeEnv: env.NODE_ENV,
      physicalAddress: env.PHYSICAL_ADDRESS,
      dryRun: env.DRY_RUN,
      testRecipient: env.TEST_RECIPIENT,
      schedulerEnabled: env.SCHEDULER_ENABLED,
      safeMode: env.SAFE_MODE,
    },
    admin: {
      apiKey: env.ADMIN_API_KEY,
      uiEnabled: env.ADMIN_UI_ENABLED,
    },
    pipeline: {
      enabled: env.PIPELINE_ENABLED,
      cron: env.PIPELINE_CRON,
      companyRefreshCron: env.PIPELINE_COMPANY_REFRESH_CRON,
      companyRefreshEnabled: env.PIPELINE_COMPANY_REFRESH_ENABLED,
      companyStaleAfterDays: env.PIPELINE_COMPANY_STALE_AFTER_DAYS,
    },
    generationGate: {
      minAlignmentConfidence: env.GENERATION_MIN_ALIGNMENT_CONFIDENCE,
      blockOnEmptyCaseStudies: env.GENERATION_BLOCK_ON_EMPTY_CASE_STUDIES,
      requireProductSummary: env.GENERATION_REQUIRE_PRODUCT_SUMMARY,
      requireSignalSummary: env.GENERATION_REQUIRE_SIGNAL_SUMMARY,
      requireParsableSignalsJson: env.GENERATION_REQUIRE_PARSABLE_SIGNALS_JSON,
    },
    lineage: {
      promptVersion: env.PROMPT_VERSION,
      qcRubricVersion: env.QC_RUBRIC_VERSION,
    },
    perplexity: {
      apiKey: env.PERPLEXITY_API_KEY,
      model: env.PERPLEXITY_MODEL,
    },
    llm: {
      provider: env.LLM_PROVIDER,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL,
      baseUrl: env.LLM_BASE_URL,
    },
    dashboard: {
      secret: env.DASHBOARD_SECRET,
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
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
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
 * Structured fields for the startup log line (safe values only).
 */
export function getStartupEnvironmentSummary(): Record<string, unknown> {
  return {
    appEnv: config.app.appEnv,
    emailMode: config.app.emailMode,
    safeMode: config.app.safeMode,
    schedulerEnabled: config.app.schedulerEnabled,
    activeSpreadsheetIdRedacted: redactSpreadsheetId(config.google.spreadsheetId),
  };
}

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
      spreadsheetId: redactSpreadsheetId(config.google.spreadsheetId),
      productionSpreadsheetId: redactSpreadsheetId(
        config.google.productionSpreadsheetId,
      ),
    },
    unsub: {
      secret: '***REDACTED***',
      baseUrl: config.unsub.baseUrl,
      expiryDays: config.unsub.expiryDays,
      port: config.unsub.port,
    },
    schedule: config.schedule,
    logging: config.logging,
    app: {
      appEnv: config.app.appEnv,
      nodeEnv: config.app.nodeEnv,
      emailMode: config.app.emailMode,
      safeMode: config.app.safeMode,
      dryRun: config.app.dryRun,
      testRecipient: config.app.testRecipient ? '***REDACTED***' : '(not set)',
      schedulerEnabled: config.app.schedulerEnabled,
      physicalAddress: config.app.physicalAddress,
    },
    admin: {
      apiKey: config.admin.apiKey ? '***REDACTED***' : '(not set)',
      uiEnabled: config.admin.uiEnabled,
    },
    pipeline: config.pipeline,
    generationGate: config.generationGate,
    lineage: config.lineage,
    perplexity: {
      apiKey: config.perplexity.apiKey ? '***REDACTED***' : '(not set)',
      model: config.perplexity.model,
    },
    llm: {
      provider: config.llm.provider,
      apiKey: config.llm.apiKey ? '***REDACTED***' : '(not set)',
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
    },
    dashboard: {
      secret: config.dashboard.secret ? '***REDACTED***' : '(not set)',
    },
  };
}
