# Cursor Build Plan — Deaton Outreach Automation

## Overview

This document defines the build phases, their order, and the entry/exit criteria for each phase. Cursor should follow this plan sequentially. Do not skip phases. Each phase must pass its exit criteria before moving to the next.

---

## Phase 0: Validate Credentials

**Goal**: Confirm that SMTP and IMAP access work before writing any application code.

**Tasks**:
1. Write a standalone test script (`scripts/test-smtp.ts`) that connects to `smtp.office365.com:587` with the provided credentials and sends a test email to the operator's address.
2. Write a standalone test script (`scripts/test-imap.ts`) that connects to `outlook.office365.com:993` and lists the 5 most recent messages in the inbox.
3. (If IMAP fails) Write a standalone test script (`scripts/test-ews.ts`) that connects to the EWS endpoint and lists recent messages.

**Entry Criteria**: Operator has provided SMTP credentials and the `.env` file is populated.

**Exit Criteria**:
- SMTP test sends an email successfully.
- IMAP/EWS test result is documented (works or doesn't).
- Decision recorded: Tier 1, Tier 2, or Tier 3 for reply processing.

---

## Phase 1: Foundation

**Goal**: Set up the project scaffold, config system, logger, Google Sheets service, and local state store.

**Tasks**:
1. Initialize project: `package.json`, `tsconfig.json`, `.eslintrc`, `.gitignore`, `.env.example`
2. Install dependencies: `typescript`, `nodemailer`, `imapflow`, `googleapis`, `handlebars`, `express`, `node-cron`, `zod`, `pino`, `dotenv`
3. Build `src/config/schema.ts` — Zod schema for all env vars
4. Build `src/config/index.ts` — Load `.env`, validate with Zod, export typed config
5. Build `src/logging/logger.ts` — Pino logger with file rotation
6. Build `src/services/sheets.ts` — Google Sheets read/write (full implementation per SOURCE_SYNC.md spec)
7. Build `src/state/local-store.ts` — JSON file read/write for state files
8. Test: config loads and validates, logger writes to file, Sheets reads contacts

**Entry Criteria**: Phase 0 complete. Google Sheets is set up with the correct tab structure.

**Exit Criteria**:
- `npm run build` succeeds with no TypeScript errors.
- Config validation rejects missing required vars.
- Logger writes structured JSON to `data/logs/`.
- Sheets service reads from and writes to the Google Spreadsheet.
- Local state store reads and writes JSON files atomically.

---

## Phase 2: Send Pipeline

**Goal**: Build the complete outbound email pipeline — SMTP service, template renderer, sequence engine, and send engine.

**Tasks**:
1. Build `src/services/smtp.ts` — Nodemailer wrapper per SEND_ENGINE.md spec
2. Build `src/utils/crypto.ts` — HMAC signing utilities per UNSUBSCRIBE_SYSTEM.md spec
3. Build `src/engine/unsubscribe.ts` — Token generation only (web endpoint comes in Phase 4)
4. Build `src/engine/sequence-engine.ts` — Full implementation per SEQUENCE_ENGINE.md spec
5. Build `src/engine/bounce-handler.ts` — Full implementation per BOUNCE_HANDLER.md spec
6. Build `src/engine/send-engine.ts` — Full implementation per SEND_ENGINE.md spec
7. Create a sample Handlebars template in `templates/test_step1.hbs`
8. Test: send a real email to a test address through the full pipeline

**Entry Criteria**: Phase 1 complete. SMTP credentials verified in Phase 0.

**Exit Criteria**:
- SMTP service connects and sends emails.
- Sequence engine correctly identifies eligible contacts (unit tests pass).
- Send engine orchestrates a full cycle: reads Sheets → evaluates eligibility → renders template → sends email → updates Sheets.
- Send Log tab gets new rows after a send cycle.
- Contacts tab gets updated (last_step_sent, last_send_date, status).
- Bounce handler classifies SMTP errors and updates Sheets.

---

## Phase 3: Inbound Processing (Conditional)

**Goal**: Build reply processing if IMAP or EWS access was confirmed in Phase 0.

**If Tier 1 (IMAP) or Tier 2 (EWS)**:

**Tasks**:
1. Build `src/services/imap.ts` (or `src/services/ews.ts`) — Inbox reading service
2. Build `src/classifiers/reply-rules.ts` — Keyword-based reply classifier per REPLY_PROCESSOR.md spec
3. Build `src/engine/reply-processor.ts` — Full implementation per REPLY_PROCESSOR.md spec
4. Test: process a test reply and verify classification + Sheets update

**If Tier 3 (Manual)**:

**Tasks**:
1. Skip all automated reply processing code.
2. Set `IMAP_ENABLED=false` in `.env.example`.
3. Document the manual reply workflow in `docs/OPERATIONS.md` (already done).
4. Ensure the Contacts tab schema supports manual updates.

**Entry Criteria**: Phase 2 complete. Tier decision from Phase 0.

**Exit Criteria** (Tier 1/2):
- Reply processor connects to inbox and fetches messages.
- Classifier correctly categorizes test replies.
- Contacts tab and Reply Log tab are updated.
- Processed messages are tracked (no duplicate processing).

**Exit Criteria** (Tier 3):
- Manual workflow is documented.
- System runs correctly without IMAP.

---

## Phase 4: Unsubscribe System

**Goal**: Build the self-hosted unsubscribe web endpoint.

**Tasks**:
1. Build `src/web/server.ts` — Express.js app with health check and unsubscribe route
2. Build `src/web/routes/unsubscribe.ts` — GET handler per UNSUBSCRIBE_SYSTEM.md spec
3. Build `src/utils/rate-limiter.ts` — Simple in-memory rate limiter
4. Test: generate a token, hit the endpoint, verify unsubscribe is recorded in Sheets

**Entry Criteria**: Phase 2 complete (token generation is already built).

**Exit Criteria**:
- `GET /health` returns 200 with status JSON.
- `GET /unsubscribe?token=VALID` returns 200 with confirmation page and updates Sheets.
- `GET /unsubscribe?token=INVALID` returns 400 with error page.
- `GET /unsubscribe?token=EXPIRED` returns 400 with expired page.
- Rate limiting blocks excessive requests from a single IP.

---

## Phase 5: Scheduling and Integration

**Goal**: Wire everything together with the cron scheduler and entry point.

**Tasks**:
1. Build `src/scheduler/cron.ts` — Register cron jobs for send cycle, reply cycle, health heartbeat
2. Build `src/main.ts` — Entry point: validate config → initialize services → start web server → start scheduler
3. Add graceful shutdown handling (SIGTERM, SIGINT)
4. End-to-end test: start the application, let it run for several cycles, verify sends, replies (if applicable), and unsubscribe all work together

**Entry Criteria**: Phases 2, 3, and 4 complete.

**Exit Criteria**:
- `npm start` launches the application.
- Cron jobs fire on schedule.
- Send cycles execute correctly.
- Reply cycles execute correctly (if enabled).
- Web server responds to health checks and unsubscribe requests.
- Graceful shutdown closes all connections cleanly.
- No overlapping cycles (mutex works).

---

## Phase 6: Deployment

**Goal**: Deploy to VPS and verify production operation.

**Tasks**:
1. Set up the VPS per `docs/DEPLOYMENT.md`
2. Configure Caddy for HTTPS reverse proxy
3. Deploy the application with PM2
4. Verify end-to-end: send an email, click unsubscribe link, check Sheets
5. Set up UptimeRobot monitoring for `/health` endpoint
6. Run for 24 hours and review logs

**Entry Criteria**: Phase 5 complete. VPS provisioned with SSH access.

**Exit Criteria**:
- Application is running on the VPS via PM2.
- Unsubscribe endpoint is reachable over HTTPS.
- Emails are sent on schedule.
- Logs are written and rotated.
- UptimeRobot reports the health endpoint as up.
