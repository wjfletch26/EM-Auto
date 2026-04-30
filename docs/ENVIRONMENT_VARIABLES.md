# Environment Variables — Deaton Outreach Automation

All configuration is loaded from a `.env` file at the project root. The config module (`src/config/index.ts`) reads these values and validates them with Zod at startup. If any required variable is missing or invalid, the application exits immediately with a descriptive error.

---

## SMTP Configuration

| Variable | Type | Required | Description | Example |
|---|---|---|---|---|
| `SMTP_HOST` | string | Yes | Microsoft SMTP server hostname | `smtp.office365.com` |
| `SMTP_PORT` | number | Yes | SMTP port (587 for STARTTLS) | `587` |
| `SMTP_USER` | string | Yes | Sending email address (also used as the "From" address) | `dave@deatonengineering.us` |
| `SMTP_PASS` | string | Yes | Email account password | `(your password)` |
| `SMTP_SECURE` | boolean | No | Use implicit TLS (true for port 465, false for STARTTLS on 587) | `false` |
| `SMTP_FROM_NAME` | string | No | Display name for the "From" field | `Dave at Deaton Engineering` |
| `REPLY_FORWARD_TO` | string | No | Default mailbox for forwarded inbound replies in Tier 3 workflow | `dknieriem@deatonengineering.com` |

**Notes**:
- `SMTP_SECURE=false` with port 587 means Nodemailer will use STARTTLS (upgrades to TLS after connecting). This is the correct setting for Microsoft 365.
- The `SMTP_USER` value is also used as the envelope sender and Reply-To address.
- `REPLY_FORWARD_TO` controls where inbound replies are forwarded for manual review.

---

## IMAP Configuration (Conditional — for reply processing)

| Variable | Type | Required | Description | Example |
|---|---|---|---|---|
| `IMAP_ENABLED` | boolean | No | Enable IMAP-based reply processing. Default: `false`. | `true` |
| `IMAP_HOST` | string | If IMAP_ENABLED | IMAP server hostname | `outlook.office365.com` |
| `IMAP_PORT` | number | If IMAP_ENABLED | IMAP port (993 for TLS) | `993` |
| `IMAP_USER` | string | If IMAP_ENABLED | Mailbox username (same as SMTP_USER) | `dave@deatonengineering.us` |
| `IMAP_PASS` | string | If IMAP_ENABLED | Mailbox password (same as SMTP_PASS) | `(your password)` |

**Notes**:
- If `IMAP_ENABLED` is `false` or unset, the reply processor is disabled. The system runs in Tier 3 mode (manual reply processing).
- If `IMAP_ENABLED` is `true` but the connection fails at startup, the system logs a warning and falls back to Tier 3.

---

## Google Sheets Configuration

| Variable | Type | Required | Description | Example |
|---|---|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_PATH` | string | Yes | Absolute path to the service account JSON key file | `/home/deaton/app/credentials/service-account.json` |
| `GOOGLE_SPREADSHEET_ID` | string | Yes | The ID of the Google Sheet (from the URL) | `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms` |

**Notes**:
- The spreadsheet ID is the long string in the Google Sheets URL: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit`
- The service account must be shared as an Editor on the spreadsheet.

---

## Unsubscribe Configuration

| Variable | Type | Required | Description | Example |
|---|---|---|---|---|
| `UNSUB_SECRET` | string | Yes | HMAC secret for signing unsubscribe tokens. Must be at least 32 characters. | `a1b2c3d4e5f6...` (generate with `openssl rand -hex 32`) |
| `UNSUB_BASE_URL` | string | Yes | Public base URL for the unsubscribe endpoint | `https://unsub.deatonengineering.us` |
| `UNSUB_EXPIRY_DAYS` | number | No | Days until unsubscribe tokens expire. Default: `90`. | `90` |
| `UNSUB_PORT` | number | No | Local port for the Express.js server. Default: `3000`. | `3000` |

**Notes**:
- The `UNSUB_BASE_URL` must be accessible from the public internet (recipients click this link).
- Caddy reverse proxies `UNSUB_BASE_URL` to `localhost:UNSUB_PORT`.

---

## Scheduling Configuration

| Variable | Type | Required | Description | Example |
|---|---|---|---|---|
| `SEND_CRON` | string | No | Cron expression for the send cycle. Default: `*/5 * * * *` (every 5 min). | `*/5 * * * *` |
| `REPLY_CRON` | string | No | Cron expression for the reply cycle. Default: `*/5 * * * *` (every 5 min). | `*/5 * * * *` |
| `SEND_DELAY_MS` | number | No | Delay in milliseconds between individual email sends. Default: `15000` (15 sec). | `15000` |
| `SEND_BATCH_SIZE` | number | No | Maximum emails to send per cycle. Default: `10`. | `10` |

**Notes**:
- `SEND_DELAY_MS` prevents triggering spam filters by spacing out sends.
- `SEND_BATCH_SIZE` limits how many emails are sent per cron cycle. At 15 seconds between sends and batch size 10, one cycle takes up to 2.5 minutes.
- With `SEND_CRON` every 5 minutes and batch size 10, the theoretical max is ~2,880 emails/day (well over the 50/day target).

---

## Logging Configuration

| Variable | Type | Required | Description | Example |
|---|---|---|---|---|
| `LOG_LEVEL` | string | No | Minimum log level. One of: `debug`, `info`, `warn`, `error`. Default: `info`. | `info` |
| `LOG_DIR` | string | No | Directory for log files. Default: `./data/logs`. | `./data/logs` |
| `LOG_RETENTION_DAYS` | number | No | Days to keep log files. Default: `30`. | `30` |

---

## Application Configuration

| Variable | Type | Required | Description | Example |
|---|---|---|---|---|
| `NODE_ENV` | string | No | Environment. One of: `development`, `production`. Default: `production`. | `production` |
| `PHYSICAL_ADDRESS` | string | Yes | Physical mailing address for CAN-SPAM compliance. Included in email footers. | `123 Main St, Suite 100, Houston, TX 77001` |

---

## Example `.env` File

```env
# ============================================================
# Deaton Outreach Automation — Environment Configuration
# ============================================================

# --- SMTP (Microsoft 365 via GoDaddy) ---
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=dave@deatonengineering.us
SMTP_PASS=your-email-password-here
SMTP_SECURE=false
SMTP_FROM_NAME=Dave at Deaton Engineering
REPLY_FORWARD_TO=dknieriem@deatonengineering.com

# --- IMAP (conditional — set IMAP_ENABLED=true if IMAP works) ---
IMAP_ENABLED=false
IMAP_HOST=outlook.office365.com
IMAP_PORT=993
IMAP_USER=dave@deatonengineering.us
IMAP_PASS=your-email-password-here

# --- Google Sheets ---
GOOGLE_SERVICE_ACCOUNT_PATH=/home/deaton/app/credentials/service-account.json
GOOGLE_SPREADSHEET_ID=your-spreadsheet-id-here

# --- Unsubscribe ---
UNSUB_SECRET=generate-this-with-openssl-rand-hex-32
UNSUB_BASE_URL=https://unsub.deatonengineering.us
UNSUB_EXPIRY_DAYS=90
UNSUB_PORT=3000

# --- Scheduling ---
SEND_CRON=*/5 * * * *
REPLY_CRON=*/5 * * * *
SEND_DELAY_MS=15000
SEND_BATCH_SIZE=10

# --- Logging ---
LOG_LEVEL=info
LOG_DIR=./data/logs
LOG_RETENTION_DAYS=30

# --- Application ---
NODE_ENV=production
PHYSICAL_ADDRESS=123 Main St, Suite 100, City, ST 00000
```

---

## Zod Validation Schema (Reference)

The config module should validate these variables at startup. Here is the expected Zod schema shape:

```typescript
// src/config/schema.ts
import { z } from 'zod';

export const configSchema = z.object({
  smtp: z.object({
    host: z.string().min(1),
    port: z.coerce.number().int().positive(),
    user: z.string().email(),
    pass: z.string().min(1),
    secure: z.coerce.boolean().default(false),
    fromName: z.string().optional().default(''),
    replyForwardTo: z.string().email().optional().default('dknieriem@deatonengineering.com'),
  }),
  imap: z.object({
    enabled: z.coerce.boolean().default(false),
    host: z.string().optional().default('outlook.office365.com'),
    port: z.coerce.number().optional().default(993),
    user: z.string().optional(),
    pass: z.string().optional(),
  }),
  google: z.object({
    serviceAccountPath: z.string().min(1),
    spreadsheetId: z.string().min(1),
  }),
  unsub: z.object({
    secret: z.string().min(32),
    baseUrl: z.string().url(),
    expiryDays: z.coerce.number().int().positive().default(90),
    port: z.coerce.number().int().positive().default(3000),
  }),
  schedule: z.object({
    sendCron: z.string().default('*/5 * * * *'),
    replyCron: z.string().default('*/5 * * * *'),
    sendDelayMs: z.coerce.number().int().nonnegative().default(15000),
    sendBatchSize: z.coerce.number().int().positive().default(10),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    dir: z.string().default('./data/logs'),
    retentionDays: z.coerce.number().int().positive().default(30),
  }),
  app: z.object({
    nodeEnv: z.enum(['development', 'production']).default('production'),
    physicalAddress: z.string().min(1),
  }),
});
```
