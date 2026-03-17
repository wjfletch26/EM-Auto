# Cursor Implementation Guide — Deaton Outreach Automation

## How to Use This Build Kit

This guide tells Cursor (or any implementation engineer) exactly how to build the Deaton Outreach Automation system from these documents. Follow it step by step.

---

## Progress Tracker

> **Tier Decision**: Tier 3 — Manual Reply Processing (see `cursor/PHASE0_RESULTS.md`)
> **Last Updated**: 2026-03-16

### Phase 0: Validate Credentials — COMPLETE

- [x] 0.1 Write `scripts/test-smtp.ts` — test SMTP connection and send a test email
- [x] 0.2 Write `scripts/test-imap.ts` — test IMAP connection and list recent messages
- [x] 0.3 Write `scripts/test-ews.ts` — test EWS endpoint (fallback)
- [x] 0.4 Document result: Tier 3 decided, `PHASE0_RESULTS.md` written
- [x] **Exit**: SMTP sends email successfully
- [x] **Exit**: IMAP/EWS result documented (both fail — basic auth blocked)
- [x] **Exit**: Decision recorded — Tier 3

### Phase 1: Foundation — COMPLETE

- [x] 1.1 Initialize project scaffold (`package.json`, `tsconfig.json`, `.eslintrc.json`, `.gitignore`, `.env.example`)
- [x] 1.2 Install all dependencies
- [x] 1.3 Build `src/config/schema.ts` — Zod schema for all env vars
- [x] 1.4 Build `src/config/index.ts` — Load `.env`, validate with Zod, export typed config
- [x] 1.5 Build `src/logging/logger.ts` — Pino logger with file rotation
- [x] 1.6 Build `src/services/sheets.ts` — Google Sheets read/write (per SOURCE_SYNC.md)
- [x] 1.7 Build `src/state/local-store.ts` — JSON file read/write with atomic writes
- [x] 1.8 Integration test: config + logger + Sheets all work together
- [x] **Exit**: `npm run build` succeeds with no TypeScript errors
- [x] **Exit**: Config validation rejects missing required vars
- [x] **Exit**: Logger writes structured JSON to `data/logs/`
- [x] **Exit**: Sheets service reads from and writes to the Google Spreadsheet
- [x] **Exit**: Local state store reads and writes JSON files atomically

### Phase 2: Send Pipeline — COMPLETE

- [x] 2.1 Build `src/services/smtp.ts` — Nodemailer SMTP wrapper
- [x] 2.2 Build `src/utils/crypto.ts` — HMAC + base64url utilities
- [x] 2.3 Build `src/engine/unsubscribe.ts` — Token generation only
- [x] 2.4 Build `src/engine/sequence-engine.ts` — `evaluateContact()` function
- [x] 2.5 Write unit tests for sequence engine (9 test cases from spec)
- [x] 2.6 Build `src/engine/bounce-handler.ts` — `classifySmtpError()`, `recordBounce()`
- [x] 2.7 Build `src/engine/send-engine.ts` — `executeSendCycle()` function
- [x] 2.8 Create sample template `templates/test_step1.hbs`
- [x] 2.9 End-to-end test: send a real email through the full pipeline
- [x] **Exit**: SMTP service connects and sends emails
- [x] **Exit**: Sequence engine correctly identifies eligible contacts
- [x] **Exit**: Send engine orchestrates a full cycle (Sheets → eligibility → template → send → update)
- [x] **Exit**: Send Log tab gets new rows after a send cycle
- [x] **Exit**: Contacts tab gets updated (last_step_sent, last_send_date, status)
- [x] **Exit**: Bounce handler classifies SMTP errors and updates Sheets

### Phase 3: Inbound Processing — TIER 3 PATH — COMPLETE

- [x] 3.1T3 Set `IMAP_ENABLED=false` in `.env.example` (already set with Tier 3 comment)
- [x] 3.2T3 Verify system works without IMAP (build clean, 9/9 tests pass, no imapflow imports)
- [x] **Exit**: Manual workflow is documented (already in `docs/OPERATIONS.md`)
- [x] **Exit**: System runs correctly without IMAP

### Phase 4: Unsubscribe System — COMPLETE

- [x] 4.1 Build `src/utils/rate-limiter.ts` — In-memory rate limiter middleware
- [x] 4.2 Build `src/web/routes/unsubscribe.ts` — GET handler + HTML pages
- [x] 4.3 Build `src/web/server.ts` — Express app with health + unsubscribe routes
- [x] 4.4 Test: generate token → hit endpoint → verify Sheets update
- [x] **Exit**: `GET /health` returns 200 with status JSON
- [x] **Exit**: `GET /unsubscribe?token=VALID` returns 200 + updates Sheets
- [x] **Exit**: `GET /unsubscribe?token=INVALID` returns 400
- [x] **Exit**: `GET /unsubscribe?token=EXPIRED` returns 400
- [x] **Exit**: Rate limiting blocks excessive requests

### Phase 5: Scheduling and Integration — COMPLETE

- [x] 5.1 Build `src/scheduler/cron.ts` — Cron jobs for send cycle, health heartbeat
- [x] 5.2 Build `src/main.ts` — Entry point with startup sequence + shutdown handling
- [x] 5.3 Create `ecosystem.config.js` for PM2
- [x] 5.4 End-to-end integration test (run 2+ cycles, verify all features)
- [x] **Exit**: `npm start` launches the application
- [x] **Exit**: Cron jobs fire on schedule
- [x] **Exit**: Send cycles execute correctly
- [x] **Exit**: Web server responds to health checks and unsubscribe
- [x] **Exit**: Graceful shutdown closes all connections cleanly
- [x] **Exit**: No overlapping cycles (mutex works)

### Phase 6: Deployment

- [ ] 6.1 Provision and harden VPS
- [ ] 6.2 Configure DNS and Caddy for HTTPS
- [ ] 6.3 Deploy application to VPS via PM2
- [ ] 6.4 Production verification (email sent, unsubscribe works, Sheets updated)
- [ ] 6.5 Set up UptimeRobot monitoring for `/health`
- [ ] 6.6 24-hour soak test — review logs, verify no errors
- [ ] **Exit**: App running on VPS via PM2
- [ ] **Exit**: Unsubscribe endpoint reachable over HTTPS
- [ ] **Exit**: Emails sent on schedule
- [ ] **Exit**: Logs written and rotated
- [ ] **Exit**: UptimeRobot reports health endpoint as up

---

## Step 1: Read the Docs in This Order

Before writing any code, read these documents to understand the system:

1. **[docs/SYSTEM_OVERVIEW.md](../docs/SYSTEM_OVERVIEW.md)** — What the system does. 5-minute read.
2. **[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)** — How the modules fit together. 10-minute read.
3. **[docs/DATA_MODEL.md](../docs/DATA_MODEL.md)** — The Google Sheets schema. You'll reference this constantly.
4. **[docs/ENVIRONMENT_VARIABLES.md](../docs/ENVIRONMENT_VARIABLES.md)** — Every config variable. Build the config module from this.

---

## Step 2: Follow the Build Plan

Open **[cursor/BUILD_PLAN.md](./BUILD_PLAN.md)** and execute phases in order:

- Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6

For granular task lists within each phase, see **[cursor/TASKS.md](./TASKS.md)**.

---

## Step 3: Use Specs as Blueprints

When building each module, open the corresponding spec from `/specs/`. Each spec contains:

- The **public interface** (function signatures, types).
- The **algorithm** (step-by-step pseudocode).
- The **error handling** rules.
- **Code examples** for key implementation details.

The specs are written so you can translate them almost directly into TypeScript.

| Module                           | Spec File                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `src/services/smtp.ts`           | [specs/SEND_ENGINE.md](../specs/SEND_ENGINE.md) (SMTP section)                 |
| `src/services/imap.ts`           | [specs/REPLY_PROCESSOR.md](../specs/REPLY_PROCESSOR.md) (IMAP section)         |
| `src/services/sheets.ts`         | [specs/SOURCE_SYNC.md](../specs/SOURCE_SYNC.md)                                |
| `src/engine/send-engine.ts`      | [specs/SEND_ENGINE.md](../specs/SEND_ENGINE.md)                                |
| `src/engine/sequence-engine.ts`  | [specs/SEQUENCE_ENGINE.md](../specs/SEQUENCE_ENGINE.md)                        |
| `src/engine/reply-processor.ts`  | [specs/REPLY_PROCESSOR.md](../specs/REPLY_PROCESSOR.md)                        |
| `src/engine/bounce-handler.ts`   | [specs/BOUNCE_HANDLER.md](../specs/BOUNCE_HANDLER.md)                          |
| `src/engine/unsubscribe.ts`      | [specs/UNSUBSCRIBE_SYSTEM.md](../specs/UNSUBSCRIBE_SYSTEM.md)                  |
| `src/classifiers/reply-rules.ts` | [specs/REPLY_PROCESSOR.md](../specs/REPLY_PROCESSOR.md) (rules section)        |
| `src/web/routes/unsubscribe.ts`  | [specs/UNSUBSCRIBE_SYSTEM.md](../specs/UNSUBSCRIBE_SYSTEM.md) (web section)    |
| `src/utils/crypto.ts`            | [specs/UNSUBSCRIBE_SYSTEM.md](../specs/UNSUBSCRIBE_SYSTEM.md) (crypto section) |

---

## Step 4: Key Implementation Rules

### File Size

Every source file should be under 200 lines. If a file exceeds 200 lines, split it.

### Error Handling

- **Services** throw typed errors. Engines catch and handle them.
- **Never swallow errors silently.** At minimum, log them.
- **SMTP auth failures** halt the send cycle. Don't retry auth errors.
- **Sheets API errors** use retry with exponential backoff (max 3 retries).
- **Use try/catch around every external call** (SMTP, IMAP, Sheets).

### No Direct I/O in Engine Modules

Engine files (`src/engine/`) should NOT import `nodemailer`, `imapflow`, `googleapis`, or `fs` directly. They receive service instances via parameters or dependency injection.

In practice, for this MVP it's acceptable to import the service singletons, but keep the interfaces clean so they can be mocked for testing.

### Comments

- Add comments explaining WHY, not WHAT.
- Document every public function with a brief JSDoc comment.
- Do not add comments that restate the code.

### Logging

Every significant action gets a log entry. Use structured fields:

```typescript
logger.info(
  {
    module: "send-engine",
    contactEmail: contact.email,
    step: 2,
    messageId: result.messageId,
  },
  "Email sent successfully",
);
```

Always include `module` and the relevant context fields.

### Config

Never hardcode values that should be configurable. If it might change (delays, batch sizes, file paths), put it in `.env` and validate with Zod.

---

## Step 5: Testing Protocol

### After Each Task

1. Run `npm run build` — must compile with no TypeScript errors.
2. Run the specific test described in the task.
3. Check `data/logs/` for expected log output.

### After Each Phase

1. Run all tests: `npm test`
2. Manually verify the phase's exit criteria (see BUILD_PLAN.md).
3. Check Google Sheets for expected data.

### Quick Smoke Tests

**Send pipeline smoke test:**

```bash
# Run one full send cycle:
npx tsx scripts/test-send-cycle.ts
```

**Unsubscribe smoke test:**

```bash
# Run endpoint smoke checks (/health, invalid, expired, valid token):
npm run test:unsub-web
```

For full command recipes and local/manual test flows, see `docs/TESTING.md`.

---

## Step 6: Dependencies Reference

Install these exact packages (use latest versions):

```bash
# Runtime dependencies
npm install nodemailer imapflow googleapis handlebars express node-cron zod pino pino-pretty dotenv mailparser

# Type definitions
npm install -D typescript @types/node @types/nodemailer @types/express @types/mailparser

# Development tools
npm install -D ts-node tsx eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
```

### `tsconfig.json` Settings

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "data", "scripts"]
}
```

### `package.json` Scripts

```json
{
  "scripts": {
    "build": "tsc",
    "build:watch": "tsc --watch",
    "start": "node dist/main.js",
    "dev": "tsx watch src/main.ts",
    "lint": "eslint src/ --ext .ts",
    "test": "tsx --test src/**/*.test.ts"
  }
}
```

---

## Step 7: Common Pitfalls to Avoid

1. **Don't batch-read the entire Send Log every cycle.** At scale, this gets expensive. For MVP (<50/day), it's fine. But build the `getSendLog()` function so it can be optimized later (e.g., filter by date).

2. **Don't forget `List-Unsubscribe` headers.** Gmail and other providers check for this. Missing it hurts deliverability.

3. **Don't cache the email-to-row-index map across cycles.** The operator may add, reorder, or delete rows. Rebuild the map on every cycle.

4. **Don't use `setTimeout` for scheduling.** Use `node-cron` for reliability. `setTimeout` drifts and doesn't survive restarts.

5. **Don't store the HMAC secret in Google Sheets.** It goes in `.env` only.

6. **Don't forget to handle SIGTERM.** PM2 sends SIGTERM on restart/stop. If you don't handle it, in-progress sends may be interrupted without cleanup.

7. **Don't log the SMTP password.** When logging config at startup, redact sensitive fields.

8. **Don't use `fs.writeFileSync` for state files.** Use write-to-temp-then-rename for atomicity.

---

## Step 8: File Creation Order

When building inside Cursor, create files in this order to minimize import errors:

```
1. package.json, tsconfig.json, .eslintrc.json, .gitignore, .env.example
2. src/config/schema.ts
3. src/config/index.ts
4. src/logging/logger.ts
5. src/utils/crypto.ts
6. src/utils/rate-limiter.ts
7. src/state/local-store.ts
8. src/services/sheets.ts
9. src/services/smtp.ts
10. src/services/imap.ts (if Tier 1/2)
11. src/engine/unsubscribe.ts
12. src/engine/sequence-engine.ts
13. src/engine/bounce-handler.ts
14. src/classifiers/reply-rules.ts (if Tier 1/2)
15. src/engine/send-engine.ts
16. src/engine/reply-processor.ts (if Tier 1/2)
17. src/web/routes/unsubscribe.ts
18. src/web/server.ts
19. src/scheduler/cron.ts
20. src/main.ts
```

This order ensures that when you create file N, all its dependencies (files 1 through N-1) already exist.
