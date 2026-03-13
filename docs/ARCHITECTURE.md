# Architecture — Deaton Outreach Automation

## Architecture Principles

1. **Separation of concerns**: Services (I/O) are isolated from engines (business logic).
2. **Fail-safe defaults**: If a component fails, the system stops sending rather than sending incorrectly.
3. **Idempotency**: Re-running a job does not send duplicate emails. State is checked before every send.
4. **Auditability**: Every action is logged with enough context to reconstruct what happened.
5. **Modularity**: Each component can be tested, replaced, or extended independently.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         VPS (Ubuntu 22.04+)                     │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  Node.js Process (PM2)                    │   │
│  │                                                          │   │
│  │  ┌────────────┐                                          │   │
│  │  │ Scheduler  │──┬── sendJob()     (every 5 min)         │   │
│  │  │ (node-cron)│  ├── replyJob()    (every 5 min)         │   │
│  │  │            │  └── healthJob()   (every 1 min)         │   │
│  │  └────────────┘                                          │   │
│  │                                                          │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │              ENGINE LAYER (business logic)          │ │   │
│  │  │                                                     │ │   │
│  │  │  send-engine.ts      — Orchestrates send runs       │ │   │
│  │  │  sequence-engine.ts  — Step advancement logic       │ │   │
│  │  │  reply-processor.ts  — Classify + route replies     │ │   │
│  │  │  bounce-handler.ts   — Detect + record bounces      │ │   │
│  │  │  unsubscribe.ts      — Token gen + processing       │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  │                          │                                │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │              SERVICE LAYER (external I/O)           │ │   │
│  │  │                                                     │ │   │
│  │  │  smtp.ts    — Nodemailer SMTP connection            │ │   │
│  │  │  imap.ts    — imapflow IMAP connection              │ │   │
│  │  │  sheets.ts  — Google Sheets API client              │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  │                                                          │   │
│  │  ┌────────────┐  ┌──────────────┐  ┌────────────────┐   │   │
│  │  │ Express.js │  │ Local State  │  │ Logger (Pino)  │   │   │
│  │  │ (unsub web)│  │ (JSON files) │  │ (disk + stdout)│   │   │
│  │  └────────────┘  └──────────────┘  └────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────┐  ┌──────────────┐                                  │
│  │ Caddy   │  │ data/        │                                  │
│  │ (proxy) │  │ ├─ state/    │                                  │
│  │         │  │ └─ logs/     │                                  │
│  └─────────┘  └──────────────┘                                  │
└─────────────────────────────────────────────────────────────────┘
         │              │              │
         ▼              ▼              ▼
   Google Sheets    SMTP Server    IMAP Server
   (googleapis)     (office365)    (office365)
```

## Module Dependency Graph

Arrows mean "depends on" / "calls into".

```
main.ts
  ├── scheduler/cron.ts
  │     ├── engine/send-engine.ts
  │     │     ├── engine/sequence-engine.ts
  │     │     ├── services/smtp.ts
  │     │     ├── services/sheets.ts
  │     │     ├── templates/ (Handlebars files)
  │     │     ├── state/local-store.ts
  │     │     └── logging/logger.ts
  │     ├── engine/reply-processor.ts
  │     │     ├── services/imap.ts
  │     │     ├── classifiers/reply-rules.ts
  │     │     ├── engine/bounce-handler.ts
  │     │     ├── services/sheets.ts
  │     │     └── logging/logger.ts
  │     └── logging/logger.ts
  ├── web/server.ts
  │     ├── web/routes/unsubscribe.ts
  │     │     ├── engine/unsubscribe.ts
  │     │     ├── services/sheets.ts
  │     │     └── logging/logger.ts
  │     └── logging/logger.ts
  └── config/index.ts
        └── config/schema.ts (Zod)
```

## Layer Responsibilities

### Config Layer (`src/config/`)

- Loads all configuration from environment variables.
- Validates using Zod schemas at startup. If validation fails, the process exits with a clear error message.
- Exports a frozen, typed config object used by all other modules.

### Service Layer (`src/services/`)

Each service wraps a single external system and exposes a clean async interface.

| Service | External System | Key Methods |
|---|---|---|
| `smtp.ts` | Microsoft SMTP (`smtp.office365.com:587`) | `sendEmail(to, subject, html, text)` → `{messageId, accepted, rejected}` |
| `imap.ts` | Microsoft IMAP (`outlook.office365.com:993`) | `fetchNewMessages(since)` → `Message[]`, `markAsRead(uid)` |
| `sheets.ts` | Google Sheets API v4 | `getContacts()`, `getCampaigns()`, `updateContactStatus()`, `batchUpdate()` |

**Rules for services:**
- Services do NOT contain business logic.
- Services handle connection lifecycle (connect, reconnect, disconnect).
- Services throw typed errors that the engine layer can handle.
- Services are instantiated once and reused (singleton pattern).

### Engine Layer (`src/engine/`)

Engines contain business logic. They call services but are not called by services.

| Engine | Responsibility |
|---|---|
| `send-engine.ts` | Orchestrates a send run: fetch eligible contacts → check sequence position → render template → send → record status |
| `sequence-engine.ts` | Determines the next step for each contact: checks timing, skip conditions, halt conditions |
| `reply-processor.ts` | Polls IMAP for new messages → classifies each reply → updates Sheets |
| `bounce-handler.ts` | Detects bounces from SMTP errors and IMAP NDR messages → marks contacts as bounced |
| `unsubscribe.ts` | Generates signed unsubscribe tokens, validates tokens, processes unsubscribe requests |

### Web Layer (`src/web/`)

A minimal Express.js server that handles:
- `GET /unsubscribe?token=<signed-token>` — Renders a confirmation page and processes the unsubscribe.
- `GET /health` — Returns 200 OK for monitoring.

Runs on a local port (e.g., 3000), reverse-proxied by Caddy with automatic TLS.

### State Layer (`src/state/`)

Local JSON files that track in-flight operations. Protects against crashes mid-run.

- `data/state/last-run.json` — Timestamp of the last completed send run.
- `data/state/pending-sends.json` — Contacts currently being processed (cleared after success).
- `data/state/processed-messages.json` — IMAP message UIDs already processed (prevents duplicate classification).

### Scheduler Layer (`src/scheduler/`)

Uses `node-cron` to define recurring jobs:

| Job | Interval | What It Does |
|---|---|---|
| `sendJob` | Every 5 minutes | Runs the send engine |
| `replyJob` | Every 5 minutes | Runs the reply processor (if inbox access available) |
| `healthJob` | Every 1 minute | Writes a heartbeat to the health file |

Jobs are non-overlapping: if a previous run is still in progress, the next invocation is skipped (mutex lock).

## Data Flow: Send Cycle

```
1. Scheduler triggers sendJob
2. Source Sync reads "Contacts" tab from Google Sheets
3. Source Sync reads "Campaigns" tab from Google Sheets
4. Sequence Engine filters contacts to those eligible for the next step:
   - Not unsubscribed
   - Not bounced
   - Current step delay has elapsed since last send
   - Not already sent this step
5. For each eligible contact:
   a. Template Renderer loads the Handlebars template for the current step
   b. Template Renderer merges contact fields into the template
   c. Send Engine sends the email via SMTP service
   d. On success: Send Engine writes status to Sheets (step sent, timestamp)
   e. On failure: Send Engine logs the error and records the failure
6. Local state is updated with the run results
7. Logger records the complete run summary
```

## Data Flow: Reply Processing

```
1. Scheduler triggers replyJob
2. Reply Processor fetches new (unseen) messages from IMAP
3. For each message:
   a. Check if already processed (by UID in processed-messages.json)
   b. Match sender email to a contact in the Sheets data
   c. Classify the reply using keyword rules:
      - "unsubscribe", "remove", "stop" → UNSUBSCRIBE
      - "not interested", "no thank you" → NOT_INTERESTED
      - "out of office", "OOO", "vacation" → OUT_OF_OFFICE
      - Bounce NDR patterns → BOUNCE
      - Positive interest signals → QUALIFIED
      - Everything else → UNCLEAR
   d. Update the contact's status in Google Sheets
   e. If UNSUBSCRIBE: also mark as unsubscribed
   f. Mark message as processed in local state
4. Logger records the classification summary
```

## Error Handling Strategy

| Error Type | Response |
|---|---|
| SMTP auth failure | Log critical error, halt all sending, alert operator |
| SMTP send failure (single email) | Log error, mark contact as "send_failed", continue to next contact |
| SMTP rate limit / throttle | Back off exponentially, retry up to 3 times |
| Google Sheets API error | Retry with exponential backoff (max 3 retries), then log and skip |
| Google Sheets quota exceeded | Pause for 60 seconds, retry |
| IMAP connection failure | Log warning, skip reply processing this cycle, retry next cycle |
| Template render failure | Log error with contact data, skip contact, continue |
| Unsubscribe endpoint down | Caddy returns 502; logged by monitoring. Reply-based unsubscribe still works. |
| Local state file corruption | Log error, rebuild from Google Sheets on next run |

## Security Boundaries

See [SECURITY.md](./SECURITY.md) for the full threat model. Key boundaries:

- **Credentials** are stored in `.env` on the VPS, readable only by the application user.
- **Google service account JSON key** is stored on disk, readable only by the application user.
- **Unsubscribe tokens** are HMAC-signed to prevent forgery.
- **No secrets in Google Sheets** — Sheets contain only contact data and status.
- **No admin UI** — no attack surface for web-based exploits beyond the unsubscribe endpoint.

## Technology Decision Records

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript on Node.js 20 | User preference. Good SMTP/IMAP ecosystem. |
| SMTP library | Nodemailer | Industry standard, 15+ years of maintenance, handles all edge cases |
| IMAP library | imapflow | Modern, promise-based, active maintenance, handles IDLE |
| Google Sheets | googleapis (official SDK) | Most reliable, direct API access, free tier sufficient |
| Template engine | Handlebars | Logic-light (prevents injection), familiar syntax, Node.js native |
| HTTP framework | Express.js | Minimal surface, only needed for one route |
| Scheduler | node-cron | In-process, no external dependency, cron syntax |
| Config validation | Zod | Runtime validation, great TypeScript inference, small footprint |
| Logger | Pino | Fastest Node.js logger, structured JSON output, low overhead |
| Process manager | PM2 | Restart on crash, log management, startup scripts |
| Reverse proxy | Caddy | Automatic HTTPS via Let's Encrypt, minimal config |
