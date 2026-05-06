# Environment Variables — Deaton Outreach Automation

The config module ([`src/config/index.ts`](../src/config/index.ts)) loads environment variables, validates them with Zod, and exits with a clear error if anything is invalid or unsafe.

## How env files are loaded (two-step, predictable)

1. **Base file:** project root **`.env`**
2. **Environment-specific file (optional):** **`.env.${APP_ENV}`** with **override** if the file exists, e.g.:
   - `APP_ENV=local` → `.env.local`
   - `APP_ENV=staging` → `.env.staging`
   - `APP_ENV=production` → `.env.production`

`APP_ENV` is read from the process environment **after** step 1. If it is not set in `.env`, it defaults to **`local`** for the purpose of choosing the second filename.

**Important:** Put `APP_ENV` in **`.env`** (or in **`.env.local`** when you rely on the default `local` bootstrap) so the correct override file is chosen. If `APP_ENV=production` exists **only** inside `.env.production`, that file is never loaded (chicken-and-egg). Typical VPS pattern: `APP_ENV=production` in `.env`, secrets in `.env.production`.

**Security and behavior use `APP_ENV`**, not `NODE_ENV`. `NODE_ENV` is only for developer conveniences (e.g. Pino pretty printing). Do not rely on `NODE_ENV` for “can this send real email?”

---

## Deployment identity and safety (`APP_ENV`)

| Variable   | Type   | Required | Description                                                                 |
| ---------- | ------ | -------- | --------------------------------------------------------------------------- |
| `APP_ENV`  | string | No       | `local` \| `staging` \| `production`. **Default: `local`.** Drives sheet guards, email mode, and scheduler default. |
| `NODE_ENV` | string | No       | `development` \| `production`. Default: `production`. Used for logging output style only. |

---

## Google Sheets (active sheet + production canonical ID)

| Variable                            | Type   | Required | Description |
| ----------------------------------- | ------ | -------- | ----------- |
| `GOOGLE_SERVICE_ACCOUNT_PATH`       | string | Yes      | Path to the service account JSON key file. |
| `GOOGLE_SPREADSHEET_ID`             | string | Yes      | The Sheet the app **reads and writes** (from the URL). |
| `PRODUCTION_GOOGLE_SPREADSHEET_ID`  | string | Yes      | The **real production** sheet ID. Required in every environment so the app can refuse bad combinations. |

**Rules (enforced at startup):**

- **`APP_ENV=production`:** `GOOGLE_SPREADSHEET_ID` must **equal** `PRODUCTION_GOOGLE_SPREADSHEET_ID`.
- **`APP_ENV=local` or `staging`:** `GOOGLE_SPREADSHEET_ID` must **not** equal `PRODUCTION_GOOGLE_SPREADSHEET_ID`.

The spreadsheet ID is the long string in: `https://docs.google.com/spreadsheets/d/{ID}/edit`. The service account must be an Editor on the **active** sheet.

---

## Email safety (non-production vs production)

| Variable          | Type    | Required | Description |
| ----------------- | ------- | -------- | ----------- |
| `DRY_RUN`         | boolean | No       | Default `false`. When `true` with `APP_ENV` local/staging: **Simulated send** (see below). **Must be false or unset when `APP_ENV=production`.** |
| `TEST_RECIPIENT`  | string  | No       | When set (valid email) and `DRY_RUN=false` on local/staging: all outbound mail is sent **only** to this address; real contact addresses are never used in the SMTP envelope. Header `X-Original-To` holds the intended recipient. **Must be empty when `APP_ENV=production`.** |

**Non-production (`local` / `staging`)** must use one of:

1. **Simulated send** — `DRY_RUN=true`  
   - No SMTP. The app logs what would be sent. The **send engine still updates the active (test) Google Sheet as if the message was sent**, so you can test admin UI / API → Sheets → state end-to-end.  
   - **No email is delivered.** Do not treat Sheet “sent” state as proof of delivery in this mode. The production sheet is blocked by the rules above.
2. **Test recipient** — `DRY_RUN=false` and a valid `TEST_RECIPIENT`  
   - Real SMTP, but only to the test mailbox.

**Production** is the only `APP_ENV` where real contact addresses can receive mail. Startup fails if `DRY_RUN=true` or if `TEST_RECIPIENT` is set in production.

At startup, the app logs an **email mode** string: `simulated_send`, `test_recipient`, or `production_live`.

---

## Scheduler (cron)

| Variable              | Type    | Required | Description |
| --------------------- | ------- | -------- | ----------- |
| `SCHEDULER_ENABLED`   | boolean | No       | **Default:** `true` when `APP_ENV=production`, **`false` when `APP_ENV` is `local` or `staging`.** Set to `true` explicitly to run background crons on a dev machine. |

When the scheduler is off, the process still runs the web server and you can use the **admin API or `/admin` UI** to run send cycle, pipeline, and approval watcher manually — unless **`SAFE_MODE=true`**, which blocks **POST/PATCH** (see below).

---

## SAFE_MODE (production debugging)

| Variable      | Type    | Required | Description |
| ------------- | ------- | -------- | ----------- |
| `SAFE_MODE`   | boolean | No       | Default `false`. When **`true`**: **cron is not started** (same effect as forcing scheduler off), and **Admin API** rejects **non-GET** requests so sheets are not mutated and automation is not triggered from the UI. **`/health`**, **unsubscribe**, and **read-only Admin inspection** still work. |

Use this instead of stopping PM2 or editing live cron when you need a stable HTTP surface while investigating issues.

---

## Deploy metadata (optional, VPS)

Written by **`scripts/write-deploy-manifest.mjs`** during **`scripts/vps-deploy.sh`** (or CI deploy). Read at startup for logs and exposed on **`/health`** under **`deploy`**.

| Variable | Type | Required | Description |
| -------- | ---- | -------- | ----------- |
| `DEPLOY_MANIFEST_PATH` | string | No | Relative or absolute path to manifest JSON. Default: **`deploy-manifest.json`** at project root. |

Manifest fields (typical): `sha`, `branch`, `time`, `deployer`, `appEnv`, `deploymentStatus` (`healthy`, `rollback`, etc.). See `scripts/write-deploy-manifest.mjs`.

---

## SMTP Configuration

| Variable           | Type    | Required | Description                                                      | Example                           |
| ------------------ | ------- | -------- | ---------------------------------------------------------------- | --------------------------------- |
| `SMTP_HOST`        | string  | Yes      | Microsoft SMTP server hostname                                   | `smtp.office365.com`              |
| `SMTP_PORT`        | number  | Yes      | SMTP port (587 for STARTTLS)                                     | `587`                             |
| `SMTP_USER`        | string  | Yes      | Sending email address (also used as the "From" address)          | `dave@deatonengineering.us`       |
| `SMTP_PASS`        | string  | Yes      | Email account password                                           | `(your password)`                 |
| `SMTP_SECURE`      | boolean | No       | Use implicit TLS (true for port 465, false for STARTTLS on 587)  | `false`                           |
| `SMTP_FROM_NAME`   | string  | No       | Display name for the "From" field                                | `Dave at Deaton Engineering`      |
| `REPLY_FORWARD_TO` | string  | No       | Default mailbox for forwarded inbound replies in Tier 3 workflow | `dknieriem@deatonengineering.com` |

**Notes:**

- `SMTP_SECURE=false` with port 587 means Nodemailer uses STARTTLS (correct for Microsoft 365).
- In **simulated send** mode, SMTP verification is **skipped** (no mail is sent). In **test recipient** or **production live**, verification runs at startup.

---

## IMAP Configuration (Conditional — for reply processing)

| Variable       | Type    | Required        | Description                                           | Example                     |
| -------------- | ------- | --------------- | ----------------------------------------------------- | --------------------------- |
| `IMAP_ENABLED` | boolean | No              | Enable IMAP-based reply processing. Default: `false`. | `true`                      |
| `IMAP_HOST`    | string  | If IMAP_ENABLED | IMAP server hostname                                  | `outlook.office365.com`     |
| `IMAP_PORT`    | number  | If IMAP_ENABLED | IMAP port (993 for TLS)                               | `993`                       |
| `IMAP_USER`    | string  | If IMAP_ENABLED | Mailbox username (same as SMTP_USER)                  | `dave@deatonengineering.us` |
| `IMAP_PASS`    | string  | If IMAP_ENABLED | Mailbox password (same as SMTP_PASS)                  | `(your password)`           |

---

## Unsubscribe Configuration

| Variable            | Type   | Required | Description                                                                 | Example                                                  |
| ------------------- | ------ | -------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `UNSUB_SECRET`      | string | Yes      | HMAC secret for signing unsubscribe tokens. Must be at least 32 characters. | `(openssl rand -hex 32)` |
| `UNSUB_BASE_URL`    | string | Yes      | Public base URL for the unsubscribe endpoint                                | `https://unsub.deatonengineering.us`                     |
| `UNSUB_EXPIRY_DAYS` | number | No       | Days until unsubscribe tokens expire. Default: `90`.                        | `90`                                                     |
| `UNSUB_PORT`        | number | No       | Local port for the Express.js server. Default: `3000`.                      | `3000`                                                   |

---

## Scheduling Configuration (cron expressions)

| Variable          | Type   | Required | Description                                                                      | Example       |
| ----------------- | ------ | -------- | -------------------------------------------------------------------------------- | ------------- |
| `SEND_CRON`       | string | No       | Cron expression for the send cycle. Default: `*/5 * * * *` (every 5 min).        | `*/5 * * * *` |
| `REPLY_CRON`      | string | No       | Cron expression for the reply cycle. Default: `*/5 * * * *` (every 5 min).       | `*/5 * * * *` |
| `SEND_DELAY_MS`   | number | No       | Delay in milliseconds between individual email sends. Default: `15000` (15 sec). | `15000`       |
| `SEND_BATCH_SIZE` | number | No       | Maximum emails to send per cycle. Default: `10`.                                 | `10`          |

---

## Logging Configuration

| Variable             | Type   | Required | Description                                                                   | Example       |
| -------------------- | ------ | -------- | ----------------------------------------------------------------------------- | ------------- |
| `LOG_LEVEL`          | string | No       | Minimum log level. One of: `debug`, `info`, `warn`, `error`. Default: `info`. | `info`        |
| `LOG_DIR`            | string | No       | Directory for log files. Default: `./data/logs`.                              | `./data/logs` |
| `LOG_RETENTION_DAYS` | number | No       | Days to keep log files. Default: `30`.                                        | `30`          |

---

## Application (CAN-SPAM)

| Variable           | Type   | Required | Description                                                                  | Example                                                                  |
| ------------------ | ------ | -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `PHYSICAL_ADDRESS` | string | Yes      | Physical mailing address for CAN-SPAM compliance. Included in email footers. | `Deaton Engineering Building, 2 Sierra Way St #110, Georgetown, TX 78626` |

---

## Admin API and UI (optional)

| Variable           | Type    | Required | Description                                                                                                                                                                                                                            | Example                |
| ------------------ | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `ADMIN_API_KEY`    | string  | No       | Shared secret for `/api/admin/*`. If unset or empty, admin JSON routes return **503** and the SPA is not served. Send as `Authorization: Bearer <key>` or `X-Admin-Key: <key>`. | `(long random secret)` |
| `ADMIN_UI_ENABLED` | boolean | No       | When `ADMIN_API_KEY` is set, serve the built admin app at `/admin`. Default: `true`.                                                                                             | `true`                 |

---

## Recipes

### Local manual testing (safe default)

**`.env` (shared secrets / paths):**

- `APP_ENV=local`
- `GOOGLE_SPREADSHEET_ID=<your test copy sheet ID>`
- `PRODUCTION_GOOGLE_SPREADSHEET_ID=<exact production sheet ID from ops>` (must differ from `GOOGLE_SPREADSHEET_ID`)
- `DRY_RUN=true` for Simulated send, **or** `DRY_RUN=false` and `TEST_RECIPIENT=you@example.com`
- Leave `SCHEDULER_ENABLED` unset (defaults **false** so only manual actions—admin UI/API or scripts—run jobs)

Optionally add **`.env.local`** for overrides (same as env-specific file when `APP_ENV=local`).

Use `NODE_ENV=development` in `.env.local` if you want pretty console logs.

### Staging server

Same pattern as local: `APP_ENV=staging`, a **staging-only** `GOOGLE_SPREADSHEET_ID`, same `PRODUCTION_GOOGLE_SPREADSHEET_ID` as production for comparison, simulated send or test recipient, scheduler usually on (`SCHEDULER_ENABLED=true`) if you want background jobs.

### VPS production (PM2)

**`.env` and/or `.env.production`:**

- `APP_ENV=production`
- `NODE_ENV=production`
- `GOOGLE_SPREADSHEET_ID` and `PRODUCTION_GOOGLE_SPREADSHEET_ID` set to the **same** real production ID
- `DRY_RUN=false`
- `TEST_RECIPIENT` unset
- `SCHEDULER_ENABLED` unset (defaults **true** in production)

---

## Example `.env` skeleton

See [`.env.example`](../.env.example) in the repo root for a commented template.

---

## Startup logging

On boot, the app logs **runtime environment** (structured): `appEnv`, `emailMode`, `schedulerEnabled`, and a **partially redacted** active spreadsheet ID. Full redacted config may also be logged for operators.

---

## Zod schema

The source of truth is [`src/config/schema.ts`](../src/config/schema.ts). The markdown “reference schema” is intentionally omitted here to avoid drift.

---

## Unit tests and `npm test`

`npm test` preloads [`test-env-bootstrap.mjs`](../test-env-bootstrap.mjs) so modules that import config still validate when your personal `.env` is mid-migration. For running the real app, always set `PRODUCTION_GOOGLE_SPREADSHEET_ID` and the rules above explicitly.
