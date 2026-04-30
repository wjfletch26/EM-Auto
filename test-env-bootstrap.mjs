/**
 * Preloaded for `npm test` (`tsx --import ./test-env-bootstrap.mjs`).
 * Must be plain `.mjs` so Node's test runner worker threads can load it (`.ts` preload fails in workers).
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
