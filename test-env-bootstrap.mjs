/**
 * Preloaded for `npm test` (`tsx --import ./test-env-bootstrap.mjs`).
 * Must be plain `.mjs` so Node's test runner worker threads can load it (`.ts` preload fails in workers).
 *
 * GitHub Actions (and any host without `.env`): importing `src/config/index.ts` runs full Zod validation.
 * Parent and child test processes inherit `process.env` from this preload + whatever Node copies at spawn.
 * Set safe placeholders here only when a var is missing so CI matches laptops that use `.env`.
 */

const TEST_PROD_CANONICAL = '__test_prod_sheet_canonical__';
const TEST_LOCAL_SHEET = '__test_local_sheet__';

if (!process.env.PRODUCTION_GOOGLE_SPREADSHEET_ID) {
  process.env.PRODUCTION_GOOGLE_SPREADSHEET_ID = TEST_PROD_CANONICAL;
}

if (!process.env.GOOGLE_SPREADSHEET_ID) {
  process.env.GOOGLE_SPREADSHEET_ID = TEST_LOCAL_SHEET;
}

process.env.APP_ENV ??= 'local';
process.env.DRY_RUN ??= 'true';

if (
  process.env.APP_ENV !== 'production' &&
  process.env.GOOGLE_SPREADSHEET_ID === process.env.PRODUCTION_GOOGLE_SPREADSHEET_ID
) {
  process.env.GOOGLE_SPREADSHEET_ID = TEST_LOCAL_SHEET;
}

// --- Required by configSchema whenever code under test imports `config/index.js` (no `.env` on CI) ---

process.env.SMTP_HOST ??= 'smtp.example.com';
process.env.SMTP_PORT ??= '587';
process.env.SMTP_USER ??= 'sender@example.com';
process.env.SMTP_PASS ??= 'test-smtp-pass-not-used-in-unit-tests';

// Path string only; validation does not read the file. Repo may omit this file on CI.
process.env.GOOGLE_SERVICE_ACCOUNT_PATH ??= './credentials/service-account.json';

// UNSUB_SECRET must be >= 32 chars (schema).
process.env.UNSUB_SECRET ??= '0'.repeat(32);
process.env.UNSUB_BASE_URL ??= 'https://unsub.example.com';

process.env.PHYSICAL_ADDRESS ??= '123 Test St, Test City, TX 00000, USA';
