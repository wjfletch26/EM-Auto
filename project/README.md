# Deaton Outreach Automation

Automated email outreach system for Deaton Engineering. Sends personalized multi-step email sequences, tracks campaign status in Google Sheets, handles unsubscribes, and processes bounces.

## Quick Start

### Prerequisites

- Node.js 20 LTS
- A Microsoft 365 email account with SMTP AUTH enabled (`dave@deatonengineering.us`)
- A Google Cloud project with Sheets API enabled and a service account key
- A Google Spreadsheet shared with the service account (as Editor)
- A VPS with a public IP and a domain pointed to it (for the unsubscribe endpoint)

### Setup

```bash
# Clone the repository
git clone <repo-url>
cd deaton-outreach

# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env
# Edit .env with your credentials (see docs/ENVIRONMENT_VARIABLES.md)

# Build
npm run build

# Create data directories
mkdir -p data/state data/logs

# Run
npm start
```

### Google Sheets Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project and enable the Google Sheets API
3. Create a service account and download the JSON key
4. Create a spreadsheet with tabs: `Contacts`, `Campaigns`, `Send Log`, `Reply Log`
5. Share the spreadsheet with the service account email as Editor
6. See [docs/DATA_MODEL.md](docs/DATA_MODEL.md) for the exact column schema

### Development

```bash
# Run in development mode (with auto-reload)
npm run dev

# Run TypeScript compiler in watch mode
npm run build:watch

# Run linter
npm run lint
```

## Documentation

| Document | Description |
|---|---|
| [docs/SYSTEM_OVERVIEW.md](docs/SYSTEM_OVERVIEW.md) | What the system does |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technical architecture |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md) | Step-by-step process flows |
| [docs/SECURITY.md](docs/SECURITY.md) | Security model and compliance |
| [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md) | Configuration reference |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Google Sheets schema |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | VPS deployment guide |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Runbook and troubleshooting |
| [docs/LOGGING_AND_MONITORING.md](docs/LOGGING_AND_MONITORING.md) | Logging setup |
| [docs/FAILURE_MODES.md](docs/FAILURE_MODES.md) | Failure scenarios |

## Component Specs

| Spec | Description |
|---|---|
| [specs/SEND_ENGINE.md](specs/SEND_ENGINE.md) | Email sending orchestration |
| [specs/SEQUENCE_ENGINE.md](specs/SEQUENCE_ENGINE.md) | Multi-step sequence logic |
| [specs/REPLY_PROCESSOR.md](specs/REPLY_PROCESSOR.md) | Reply classification |
| [specs/BOUNCE_HANDLER.md](specs/BOUNCE_HANDLER.md) | Bounce detection |
| [specs/UNSUBSCRIBE_SYSTEM.md](specs/UNSUBSCRIBE_SYSTEM.md) | Unsubscribe endpoint |
| [specs/SOURCE_SYNC.md](specs/SOURCE_SYNC.md) | Google Sheets integration |

## Project Structure

```
src/
├── config/          # Environment config + Zod validation
├── services/        # External I/O (SMTP, Sheets)
├── engine/          # Business logic (send, sequence, bounce, unsub)
├── web/             # Express.js unsubscribe endpoint
├── state/           # Local JSON state management
├── logging/         # Pino logger setup
├── scheduler/       # node-cron job definitions
├── utils/           # Shared utilities (crypto, rate limiter)
└── main.ts          # Entry point

Note: Reply processing is manual (Tier 3). IMAP/EWS basic auth was blocked
by Microsoft — see cursor/PHASE0_RESULTS.md. Replies are handled by the
human operator updating Google Sheets (see docs/OPERATIONS.md).
```

## License

Private — Deaton Engineering internal use only.
