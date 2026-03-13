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

// --- App-level settings ---
const appSchema = z.object({
  nodeEnv: z.enum(['development', 'production']).default('production'),
  physicalAddress: z.string().min(1, 'PHYSICAL_ADDRESS is required for CAN-SPAM compliance'),
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
});

/** TypeScript type inferred from the schema — used throughout the codebase. */
export type AppConfig = z.infer<typeof configSchema>;
