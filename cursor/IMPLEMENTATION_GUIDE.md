# Cursor Implementation Guide — Deaton Outreach Automation

## How to Use This Build Kit

This guide tells Cursor (or any implementation engineer) exactly how to build the Deaton Outreach Automation system from these documents. Follow it step by step.

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

| Module | Spec File |
|---|---|
| `src/services/smtp.ts` | [specs/SEND_ENGINE.md](../specs/SEND_ENGINE.md) (SMTP section) |
| `src/services/imap.ts` | [specs/REPLY_PROCESSOR.md](../specs/REPLY_PROCESSOR.md) (IMAP section) |
| `src/services/sheets.ts` | [specs/SOURCE_SYNC.md](../specs/SOURCE_SYNC.md) |
| `src/engine/send-engine.ts` | [specs/SEND_ENGINE.md](../specs/SEND_ENGINE.md) |
| `src/engine/sequence-engine.ts` | [specs/SEQUENCE_ENGINE.md](../specs/SEQUENCE_ENGINE.md) |
| `src/engine/reply-processor.ts` | [specs/REPLY_PROCESSOR.md](../specs/REPLY_PROCESSOR.md) |
| `src/engine/bounce-handler.ts` | [specs/BOUNCE_HANDLER.md](../specs/BOUNCE_HANDLER.md) |
| `src/engine/unsubscribe.ts` | [specs/UNSUBSCRIBE_SYSTEM.md](../specs/UNSUBSCRIBE_SYSTEM.md) |
| `src/classifiers/reply-rules.ts` | [specs/REPLY_PROCESSOR.md](../specs/REPLY_PROCESSOR.md) (rules section) |
| `src/web/routes/unsubscribe.ts` | [specs/UNSUBSCRIBE_SYSTEM.md](../specs/UNSUBSCRIBE_SYSTEM.md) (web section) |
| `src/utils/crypto.ts` | [specs/UNSUBSCRIBE_SYSTEM.md](../specs/UNSUBSCRIBE_SYSTEM.md) (crypto section) |

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
logger.info({
  module: 'send-engine',
  contactEmail: contact.email,
  step: 2,
  messageId: result.messageId,
}, 'Email sent successfully');
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
# Add a test contact to the Contacts tab in Google Sheets.
# Run the send engine once:
npx ts-node -e "
  import { executeSendCycle } from './src/engine/send-engine';
  executeSendCycle().then(r => console.log(r));
"
# Verify: email received, Send Log updated, Contact status updated.
```

**Unsubscribe smoke test:**
```bash
# Start the web server.
# Generate a test token:
npx ts-node -e "
  import { generateUnsubscribeUrl } from './src/engine/unsubscribe';
  console.log(generateUnsubscribeUrl('test@example.com'));
"
# Open the URL in a browser. Verify the confirmation page appears.
# Check Sheets: test@example.com should be marked as unsubscribed.
```

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
