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
refactor(config): extract Zod schema to separate file
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

## Testing

- Write unit tests for engine modules (they are pure logic).
- Write integration tests for service modules (mock external APIs).
- Test after every meaningful change.
- Run tests before committing: `npm test`

## Documentation

- Update the relevant doc or spec when changing behavior.
- Add comments explaining non-obvious logic. Keep comments current.
- Do not add comments that simply restate the code.

## Branch Strategy

- `main` — production-ready code, deployed on the VPS.
- `dev` — development branch for in-progress work.
- Feature branches: `feat/description`, merged to `dev` when ready.
