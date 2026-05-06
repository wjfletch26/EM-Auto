# Contributing — Deaton Outreach Automation

## Development Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Fill in values (use test credentials for development)

# Build TypeScript
npm run build

# Run in development mode
npm run dev
```

## Code Style

- TypeScript strict mode enabled.
- Use `async/await` — no raw Promises or callbacks.
- Every function that performs I/O must be `async`.
- Engine modules must NOT import service modules directly; services are passed via function parameters or dependency injection.
- Keep files under 200 lines. If a file grows beyond that, split it.
- Use descriptive variable and function names. No abbreviations except widely known ones (e.g., `url`, `id`, `config`).

## Naming Conventions

| Item | Convention | Example |
|---|---|---|
| Files | kebab-case | `send-engine.ts` |
| Functions | camelCase | `executeSendCycle()` |
| Interfaces/Types | PascalCase | `SendRunResult` |
| Constants | UPPER_SNAKE_CASE | `MAX_RETRIES` |
| Environment variables | UPPER_SNAKE_CASE | `SMTP_HOST` |

## Commit Messages

Use conventional commit format:

```
type(scope): description

Examples:
feat(send-engine): add rate limiting between sends
fix(sheets): handle empty rows in contacts tab
docs(operations): add troubleshooting section for SMTP errors
refactor(config): extract Zod schema to separate module
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

## Testing

- Write unit tests for engine modules (they are pure logic).
- Write integration tests for service modules (mock external APIs).
- Test after every meaningful change.
- Run tests before merging to `main`: `npm run build`, `npm test`, and (when touching the web surface) `npm run test:unsub-web`.

## Before merging to `main` (operator checklist)

1. **`APP_ENV=local`** with a **test spreadsheet** (not the production sheet ID as the active sheet).
2. **`DRY_RUN=true`** or valid **`TEST_RECIPIENT`** per `docs/ENVIRONMENT_VARIABLES.md`.
3. **`npm run build`** and **`npm test`** pass locally.
4. Exercise the flows you changed (Admin UI, scripts from `docs/TESTING.md`) against the **test sheet**.

## Documentation

- Update the relevant doc or spec when changing behavior.
- Add comments explaining non-obvious logic. Keep comments current.
- Do not add comments that simply restate the code.

## Branching and deploy (trunk-based)

- **`main`** — production-ready code; the **production VPS deploys only from `main`**. There is no Git branch named `production`.
- **Short-lived feature branches:** `feat/short-description` for changes; merge to `main` after the checklist above passes.
- **GitHub Actions:** pushes to `main` run **CI** (`npm run build`, `npm test`). A **`deploy`** job uses environment **`production`** with **required reviewers** (manual approval) before **SSH** to the VPS runs `scripts/vps-deploy.sh` (preflight, **deploy lock**, pull, install, build, `deploy-manifest.json`, `pm2 reload`, health curl).
- **Emergency / offline CI:** manual steps remain documented in `docs/RUN_AND_DEPLOY.md` (SSH, pull, build, `pm2 reload`).
- **No long-lived `dev` branch** unless it maps to a **real environment** (dedicated host + sheet + env). **Staging** is strongly recommended when you add a second VPS (`docs/RUN_AND_DEPLOY.md`).
