# Task Breakdown — Deaton Outreach Automation

Each task is sized for one focused implementation session. Tasks within a phase should be completed in order. Cross-phase dependencies are noted.

---

## Phase 0: Validate Credentials

| # | Task | Inputs | Outputs | Est. Time |
|---|---|---|---|---|
| 0.1 | Write `scripts/test-smtp.ts` — test SMTP connection and send a test email | SMTP credentials in `.env` | Console output: success or error | 30 min |
| 0.2 | Write `scripts/test-imap.ts` — test IMAP connection and list recent messages | Same credentials | Console output: message subjects or auth error | 30 min |
| 0.3 | (If needed) Write `scripts/test-ews.ts` — test EWS endpoint | Same credentials | Console output: success or error | 45 min |
| 0.4 | Document the result: update `.env.example` with `IMAP_ENABLED` value | Test results | Updated `.env.example` | 10 min |

---

## Phase 1: Foundation

| # | Task | Inputs | Outputs | Est. Time |
|---|---|---|---|---|
| 1.1 | Initialize project scaffold | None | `package.json`, `tsconfig.json`, `.eslintrc.json`, `.gitignore`, `.env.example` | 30 min |
| 1.2 | Install all dependencies | `package.json` | `node_modules/`, `package-lock.json` | 10 min |
| 1.3 | Build `src/config/schema.ts` | [docs/ENVIRONMENT_VARIABLES.md](../docs/ENVIRONMENT_VARIABLES.md) | Zod schema | 30 min |
| 1.4 | Build `src/config/index.ts` | schema.ts | Config loader + validator | 20 min |
| 1.5 | Build `src/logging/logger.ts` | [docs/LOGGING_AND_MONITORING.md](../docs/LOGGING_AND_MONITORING.md) | Pino logger with file rotation | 45 min |
| 1.6 | Build `src/services/sheets.ts` | [specs/SOURCE_SYNC.md](../specs/SOURCE_SYNC.md) | Full Sheets service (read + write) | 90 min |
| 1.7 | Build `src/state/local-store.ts` | Architecture docs | JSON file read/write with atomic writes | 30 min |
| 1.8 | Integration test: config + logger + Sheets | All above | Verified working together | 30 min |

---

## Phase 2: Send Pipeline

| # | Task | Inputs | Outputs | Est. Time |
|---|---|---|---|---|
| 2.1 | Build `src/services/smtp.ts` | [specs/SEND_ENGINE.md](../specs/SEND_ENGINE.md) | Nodemailer SMTP wrapper | 45 min |
| 2.2 | Build `src/utils/crypto.ts` | [specs/UNSUBSCRIBE_SYSTEM.md](../specs/UNSUBSCRIBE_SYSTEM.md) | HMAC + base64url utilities | 30 min |
| 2.3 | Build `src/engine/unsubscribe.ts` (token gen only) | crypto.ts, spec | `generateUnsubscribeUrl()`, `validateUnsubscribeToken()` | 30 min |
| 2.4 | Build `src/engine/sequence-engine.ts` | [specs/SEQUENCE_ENGINE.md](../specs/SEQUENCE_ENGINE.md) | `evaluateContact()` function | 45 min |
| 2.5 | Write unit tests for sequence engine | sequence-engine.ts | Test file with all 9 test cases from spec | 30 min |
| 2.6 | Build `src/engine/bounce-handler.ts` | [specs/BOUNCE_HANDLER.md](../specs/BOUNCE_HANDLER.md) | `recordBounce()`, `classifySmtpError()` | 30 min |
| 2.7 | Build `src/engine/send-engine.ts` | [specs/SEND_ENGINE.md](../specs/SEND_ENGINE.md) | `executeSendCycle()` function | 90 min |
| 2.8 | Create sample template `templates/test_step1.hbs` | Template example from spec | Working Handlebars template | 15 min |
| 2.9 | End-to-end test: send a real email through the pipeline | All above | Email received, Sheets updated | 30 min |

---

## Phase 3: Inbound Processing

### Tier 1/2 Path (IMAP/EWS available)

| # | Task | Inputs | Outputs | Est. Time |
|---|---|---|---|---|
| 3.1 | Build `src/services/imap.ts` (or `ews.ts`) | [specs/REPLY_PROCESSOR.md](../specs/REPLY_PROCESSOR.md) | Inbox reading service | 60 min |
| 3.2 | Build `src/classifiers/reply-rules.ts` | Spec (classification rules table) | `classifyReply()` function | 30 min |
| 3.3 | Write unit tests for reply classifier | reply-rules.ts | Tests for all 6 classifications | 30 min |
| 3.4 | Build `src/engine/reply-processor.ts` | Spec | `executeReplyCycle()` function | 60 min |
| 3.5 | Integration test: process a test reply | All above | Reply classified, Sheets updated | 30 min |

### Tier 3 Path (Manual)

| # | Task | Inputs | Outputs | Est. Time |
|---|---|---|---|---|
| 3.1T3 | Set `IMAP_ENABLED=false` in `.env.example` | Phase 0 results | Updated config | 5 min |
| 3.2T3 | Verify system works without IMAP | Run send cycle | No errors related to IMAP | 15 min |

---

## Phase 4: Unsubscribe System

| # | Task | Inputs | Outputs | Est. Time |
|---|---|---|---|---|
| 4.1 | Build `src/utils/rate-limiter.ts` | Spec | In-memory rate limiter middleware | 20 min |
| 4.2 | Build `src/web/routes/unsubscribe.ts` | [specs/UNSUBSCRIBE_SYSTEM.md](../specs/UNSUBSCRIBE_SYSTEM.md) | GET handler + HTML response pages | 45 min |
| 4.3 | Build `src/web/server.ts` | Spec | Express app with health + unsubscribe routes | 30 min |
| 4.4 | Test: generate token → hit endpoint → verify Sheets update | All above | End-to-end unsubscribe works | 20 min |

---

## Phase 5: Scheduling and Integration

| # | Task | Inputs | Outputs | Est. Time |
|---|---|---|---|---|
| 5.1 | Build `src/scheduler/cron.ts` | [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) | Cron job registration for send, reply, health | 30 min |
| 5.2 | Build `src/main.ts` | All modules | Entry point with startup sequence and shutdown handling | 45 min |
| 5.3 | Create `ecosystem.config.js` for PM2 | [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) | PM2 config file | 10 min |
| 5.4 | End-to-end integration test | Full application | Run for 2+ cycles, verify all features | 45 min |

---

## Phase 6: Deployment

| # | Task | Inputs | Outputs | Est. Time |
|---|---|---|---|---|
| 6.1 | Provision and harden VPS | [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) | Secured server with Node.js, PM2, Caddy | 60 min |
| 6.2 | Configure DNS and Caddy for HTTPS | Deployment doc | `unsub.deatonengineering.us` reachable over HTTPS | 30 min |
| 6.3 | Deploy application to VPS | Deployment doc | App running via PM2 | 30 min |
| 6.4 | Production verification | Deployment doc | Email sent, unsubscribe works, Sheets updated | 30 min |
| 6.5 | Set up UptimeRobot monitoring | [docs/LOGGING_AND_MONITORING.md](../docs/LOGGING_AND_MONITORING.md) | Health endpoint monitored | 15 min |
| 6.6 | 24-hour soak test | Logs | Review logs, verify no errors | Next day |

---

## Total Estimated Time

| Phase | Tasks | Estimated Time |
|---|---|---|
| Phase 0: Validate Credentials | 3–4 | 1.5–2 hours |
| Phase 1: Foundation | 8 | 4.5 hours |
| Phase 2: Send Pipeline | 9 | 5.5 hours |
| Phase 3: Inbound Processing | 5 (Tier 1/2) or 2 (Tier 3) | 3.5 hours or 20 min |
| Phase 4: Unsubscribe System | 4 | 2 hours |
| Phase 5: Scheduling + Integration | 4 | 2 hours |
| Phase 6: Deployment | 6 | 3 hours |

**Total**: ~20–22 hours of implementation time (Tier 1/2) or ~17–19 hours (Tier 3).
