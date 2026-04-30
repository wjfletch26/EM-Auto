/**
 * Zod validation schema for all environment variables.
 * Loaded and validated at startup — the app exits immediately if anything is missing or invalid.
 *
 * Reference: docs/ENVIRONMENT_VARIABLES.md
 */

import { z } from 'zod';

/**
 * Custom boolean parser for env vars.
 * z.coerce.boolean() treats "false" as true (non-empty string).
 * This correctly maps "true"/"1" → true and "false"/"0"/undefined → false.
 */
const envBoolean = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((val) => {
    if (typeof val === 'boolean') return val;
    if (val === undefined || val === '') return undefined; // let .default() handle it
    return val.toLowerCase() === 'true' || val === '1';
  });

// --- SMTP settings for Microsoft 365 outbound email ---
const smtpSchema = z.object({
  host: z.string().min(1, 'SMTP_HOST is required'),
  port: z.coerce.number().int().positive(),
  user: z.string().email('SMTP_USER must be a valid email'),
  pass: z.string().min(1, 'SMTP_PASS is required'),
  secure: envBoolean.default(false),
  fromName: z.string().optional().default(''),
  // Default human-review mailbox for forwarded replies.
  // Can be overridden per environment with REPLY_FORWARD_TO.
  replyForwardTo: z
    .string()
    .email('REPLY_FORWARD_TO must be a valid email')
    .optional()
    .default('dknieriem@deatonengineering.com'),
});

// --- IMAP settings (conditional — disabled for Tier 3) ---
const imapSchema = z.object({
  enabled: envBoolean.default(false),
  host: z.string().optional().default('outlook.office365.com'),
  port: z.coerce.number().optional().default(993),
  user: z.string().optional(),
  pass: z.string().optional(),
});

// --- Google Sheets connection ---
const googleSchema = z.object({
  serviceAccountPath: z.string().min(1, 'GOOGLE_SERVICE_ACCOUNT_PATH is required'),
  spreadsheetId: z.string().min(1, 'GOOGLE_SPREADSHEET_ID is required'),
  /** Canonical production sheet ID — required in every environment for safety checks. */
  productionSpreadsheetId: z
    .string()
    .min(1, 'PRODUCTION_GOOGLE_SPREADSHEET_ID is required'),
});

// --- Unsubscribe endpoint settings ---
const unsubSchema = z.object({
  secret: z.string().min(32, 'UNSUB_SECRET must be at least 32 characters'),
  baseUrl: z.string().url('UNSUB_BASE_URL must be a valid URL'),
  expiryDays: z.coerce.number().int().positive().default(90),
  port: z.coerce.number().int().positive().default(3000),
});

// --- Cron scheduling and send pacing ---
const scheduleSchema = z.object({
  sendCron: z.string().default('*/5 * * * *'),
  replyCron: z.string().default('*/5 * * * *'),
  sendDelayMs: z.coerce.number().int().nonnegative().default(15000),
  sendBatchSize: z.coerce.number().int().positive().default(10),
});

// --- Pino logger settings ---
const loggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  dir: z.string().default('./data/logs'),
  retentionDays: z.coerce.number().int().positive().default(30),
});

// --- Intelligence pipeline LLM settings ---
const pipelineSchema = z.object({
  enabled: envBoolean.default(false),
  cron: z.string().default('*/5 * * * *'),
});

const perplexitySchema = z.object({
  apiKey: z.string().optional().default(''),
  model: z.string().optional().default('sonar'),
});

const llmSchema = z.object({
  provider: z.string().optional().default('perplexity'),
  apiKey: z.string().optional().default(''),
  model: z.string().optional().default('sonar'),
  baseUrl: z.string().url().optional().default('https://api.perplexity.ai'),
});

/** Deployment identity — drives sheet guards, email modes, and scheduler defaults. */
export const appEnvSchema = z.enum(['local', 'staging', 'production']);

/** How outbound email behaves at runtime (for logs and operators). */
export type EmailMode = 'simulated_send' | 'test_recipient' | 'production_live';

// --- App-level settings ---
const appSchemaBase = z.object({
  /** Real environment: local / staging / production (not NODE_ENV). */
  appEnv: appEnvSchema.default('local'),
  nodeEnv: z.enum(['development', 'production']).default('production'),
  physicalAddress: z.string().min(1, 'PHYSICAL_ADDRESS is required for CAN-SPAM compliance'),
  /**
   * Simulated send: no SMTP; Sheet rows still update as if sent (only on non-production sheets).
   */
  dryRun: envBoolean.default(false),
  /** When set with dryRun=false (non-production), all mail goes here with X-Original-To. */
  testRecipient: z
    .string()
    .optional()
    .transform((s) => (s === undefined ? '' : s.trim())),
  /** Explicit override; when omitted, true only for APP_ENV=production. */
  schedulerEnabled: envBoolean.optional(),
});

// --- Admin API + static UI (optional; routes return 503 when key unset) ---
const adminSchema = z.object({
  /** Bearer / X-Admin-Key token. Empty = admin API and UI disabled. */
  apiKey: z.string().optional().default(''),
  /** Serve built SPA from dist/admin at /admin. Default true when apiKey is set. */
  uiEnabled: envBoolean.default(true),
}).default({
  apiKey: '',
  uiEnabled: true,
});

// --- Operator dashboard (mutations + list APIs that expose contact data) ---
const dashboardSchema = z.object({
  /** Required for protected routes — send the same value in the `X-Dashboard-Token` header. */
  secret: z.string().optional().default(''),
}).default({
  secret: '',
});

const configSchemaBase = z.object({
  smtp: smtpSchema,
  imap: imapSchema,
  google: googleSchema,
  unsub: unsubSchema,
  schedule: scheduleSchema,
  logging: loggingSchema,
  app: appSchemaBase,
  admin: adminSchema,
  pipeline: pipelineSchema,
  perplexity: perplexitySchema,
  llm: llmSchema,
  dashboard: dashboardSchema,
});

function deriveEmailMode(
  appEnv: z.infer<typeof appEnvSchema>,
  dryRun: boolean,
): EmailMode {
  if (appEnv === 'production') return 'production_live';
  if (dryRun) return 'simulated_send';
  return 'test_recipient';
}

/**
 * Full validation: sheet guards, email safety, defaults for scheduler.
 */
export const configSchema = configSchemaBase
  .superRefine((data, ctx) => {
    const { app, google } = data;

    // --- Production spreadsheet must match canonical ID ---
    if (app.appEnv === 'production') {
      if (google.spreadsheetId !== google.productionSpreadsheetId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Production requires GOOGLE_SPREADSHEET_ID to equal PRODUCTION_GOOGLE_SPREADSHEET_ID',
          path: ['google', 'spreadsheetId'],
        });
      }
    } else {
      // Local/staging must never point at the production sheet ID.
      if (google.spreadsheetId === google.productionSpreadsheetId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Non-production cannot use the production spreadsheet (GOOGLE_SPREADSHEET_ID must differ from PRODUCTION_GOOGLE_SPREADSHEET_ID)',
          path: ['google', 'spreadsheetId'],
        });
      }
    }

    const testRecipientOk =
      app.testRecipient.length > 0 &&
      z.string().email().safeParse(app.testRecipient).success;

    if (app.appEnv !== 'production') {
      // Must use simulated send OR test recipient — never real contacts without those guards.
      if (!app.dryRun && !testRecipientOk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Non-production requires DRY_RUN=true (simulated send) or a valid TEST_RECIPIENT email',
          path: ['app', 'dryRun'],
        });
      }
    } else {
      if (app.dryRun) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DRY_RUN must not be enabled when APP_ENV=production',
          path: ['app', 'dryRun'],
        });
      }
      if (app.testRecipient.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'TEST_RECIPIENT must be unset when APP_ENV=production',
          path: ['app', 'testRecipient'],
        });
      }
    }
  })
  .transform((data) => {
    const schedulerEnabled =
      data.app.schedulerEnabled !== undefined
        ? data.app.schedulerEnabled
        : data.app.appEnv === 'production';

    const emailMode = deriveEmailMode(data.app.appEnv, data.app.dryRun);

    return {
      ...data,
      app: {
        ...data.app,
        schedulerEnabled,
        emailMode,
      },
    };
  });

/** TypeScript type inferred from the schema — used throughout the codebase. */
export type AppConfig = z.infer<typeof configSchema>;

/**
 * Used by tests: validate a raw config object without loading dotenv.
 */
export function safeParseConfig(raw: unknown) {
  return configSchema.safeParse(raw);
}
