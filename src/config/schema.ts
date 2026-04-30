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

// --- App-level settings ---
const appSchema = z.object({
  nodeEnv: z.enum(['development', 'production']).default('production'),
  physicalAddress: z.string().min(1, 'PHYSICAL_ADDRESS is required for CAN-SPAM compliance'),
});

// --- Admin API + static UI (optional; routes return 503 when key unset) ---
const adminSchema = z.object({
  /** Bearer / X-Admin-Key token. Empty = admin API and UI disabled. */
  apiKey: z.string().optional().default(''),
  /** Serve built SPA from dist/admin at /admin. Default true when apiKey is set. */
  uiEnabled: envBoolean.default(true),
});

/**
 * Top-level config schema. Each section maps to a group of env vars.
 * The config loader (src/config/index.ts) maps raw env vars into this shape.
 */
export const configSchema = z.object({
  smtp: smtpSchema,
  imap: imapSchema,
  google: googleSchema,
  unsub: unsubSchema,
  schedule: scheduleSchema,
  logging: loggingSchema,
  app: appSchema,
  admin: adminSchema,
  pipeline: pipelineSchema,
  perplexity: perplexitySchema,
  llm: llmSchema,
});

/** TypeScript type inferred from the schema — used throughout the codebase. */
export type AppConfig = z.infer<typeof configSchema>;
