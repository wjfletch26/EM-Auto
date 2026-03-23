# System Overview — Deaton Outreach Automation

## What This System Does

Deaton Outreach Automation is an unattended email outreach system. It sends personalized cold email campaigns from a Microsoft 365 mailbox, tracks every message through its lifecycle, and writes all status data back to a Google Sheet that serves as the operational dashboard.

The system runs on a Linux VPS with no human interaction required during normal operation.

## Sending Address

- **From**: `dave@deatonengineering.us`
- **Provider**: Microsoft 365 via GoDaddy
- **Protocol**: SMTP with basic auth (SMTP AUTH confirmed enabled)
- **Reply forwarding**: An Outlook rule forwards inbound replies to the mailbox configured in `REPLY_FORWARD_TO` for human review

## Core Capabilities

| Capability | Description |
|---|---|
| **Outbound sending** | Send personalized emails via SMTP from `dave@deatonengineering.us` |
| **Multi-step sequences** | Execute linear email sequences (Step 1 → Step 2 → Step 3) with configurable delays |
| **Template personalization** | Render email body and subject using contact fields via Handlebars templates |
| **Campaign tracking** | Record send status, timestamps, and sequence position per contact in Google Sheets |
| **Unsubscribe compliance** | Self-hosted unsubscribe page + reply-based keyword detection |
| **Bounce detection** | Detect bounces from SMTP error codes at send time |
| **Reply processing** | (Conditional) If IMAP/EWS access is available: poll inbox, classify replies, update Sheets |
| **Audit logging** | Structured logs on disk for every system action |

## What It Does NOT Do (MVP Scope)

- Does not provide a web dashboard or admin UI
- Does not use a database (Google Sheets is the data store)
- Does not support branching sequences (linear only)
- Does not support multiple sending addresses
- Does not use AI/ML for reply classification (keyword rules only)
- Does not manage DNS, SPF, DKIM, or DMARC configuration (those are set at the domain/hosting level)

## Components

```
┌─────────────────────────────────────────────────────────┐
│                    VPS Application                       │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Scheduler │──│ Source Sync   │──│ Sequence Engine  │  │
│  │ (cron)    │  │ (Sheets API) │  │ (step logic)     │  │
│  └──────────┘  └──────────────┘  └──────────────────┘  │
│       │                                    │            │
│       │         ┌──────────────┐  ┌───────────────┐    │
│       │         │ Template     │──│ Send Engine    │    │
│       │         │ Renderer     │  │ (SMTP)        │    │
│       │         └──────────────┘  └───────────────┘    │
│       │                                                 │
│       │         ┌──────────────┐  ┌───────────────┐    │
│       └─────────│ Reply        │──│ Bounce        │    │
│                 │ Processor    │  │ Handler       │    │
│                 └──────────────┘  └───────────────┘    │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Unsubscribe  │  │ Local State  │  │ Logger       │  │
│  │ Web Server   │  │ (JSON files) │  │ (disk logs)  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                    │                │
         ▼                    ▼                ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ Google Sheets │  │ Microsoft    │  │ Microsoft    │
  │ (tracking)   │  │ SMTP         │  │ IMAP/EWS     │
  └──────────────┘  └──────────────┘  └──────────────┘
```

## Technology Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js 20 LTS | Stable LTS, good ecosystem for SMTP/IMAP/HTTP |
| Language | TypeScript | Type safety, better maintainability |
| SMTP | Nodemailer | Industry-standard Node.js SMTP library |
| IMAP | imapflow | Modern, promise-based IMAP client |
| Google Sheets | googleapis (official) | Official Google API client |
| Templates | Handlebars | Mature, logic-light, safe template engine |
| HTTP server | Express.js | Minimal, well-known, for unsubscribe endpoint |
| Scheduler | node-cron | Cron-syntax scheduling in-process |
| Config validation | Zod | Runtime type validation for env vars |
| Logging | Pino | Fast structured JSON logging |
| Process manager | PM2 | Keeps the app running on VPS, handles restarts |
| Reverse proxy | Caddy | Automatic TLS, simple config |

## Operational Model

- The system runs as a **single Node.js process** managed by PM2.
- A **cron scheduler** inside the process triggers jobs on intervals (e.g., every 5 minutes).
- An **Express.js HTTP server** runs alongside the scheduler in the same process to handle unsubscribe requests.
- All state is persisted to **Google Sheets** (primary) and **local JSON files** (crash recovery).
- Logs are written to **disk** with daily rotation.

## Volume and Limits

- Target: **under 50 emails/day**
- Microsoft 365 SMTP limit: 10,000 recipients/day (not a concern)
- Google Sheets API limit: 300 requests/minute (not a concern at this volume)
- Rate limiting: built into the send engine to avoid triggering spam filters (configurable delay between sends)

## Key Domains

| Domain | Role |
|---|---|
| `deatonengineering.us` | Sending domain — emails sent FROM this domain |
| `deatonengineering.com` | Human reply review — forwarded copies go here |

## Document Map

For implementation details, see:

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Technical architecture and module design
- [WORKFLOWS.md](./WORKFLOWS.md) — Step-by-step process flows
- [SECURITY.md](./SECURITY.md) — Threat model and compliance
- [DATA_MODEL.md](./DATA_MODEL.md) — Google Sheets schema
- [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) — Configuration reference
- [DEPLOYMENT.md](./DEPLOYMENT.md) — VPS setup and deployment
- [OPERATIONS.md](./OPERATIONS.md) — Runbook and troubleshooting
- [LOGGING_AND_MONITORING.md](./LOGGING_AND_MONITORING.md) — Log format and monitoring
- [FAILURE_MODES.md](./FAILURE_MODES.md) — Failure scenarios and recovery
- [ADR_GUIDELINES.md](./ADR_GUIDELINES.md) — Architecture decision records
