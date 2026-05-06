/**
 * Adds Contacts column Y header: last_profile_version_used_for_generation.
 *
 * Safe to run multiple times (idempotent header write).
 * Existing rows need no backfill — `getContacts` treats missing column Y as ''.
 *
 * Uses GOOGLE_SERVICE_ACCOUNT_PATH from .env. Spreadsheet:
 * - Default: GOOGLE_SPREADSHEET_ID (usually your test sheet when APP_ENV=local).
 * - Production without editing .env: pass --spreadsheet-id with PRODUCTION_GOOGLE_SPREADSHEET_ID.
 *
 * Run (test sheet from .env):
 *   npx tsx scripts/migrate-contacts-profile-version-column.ts
 *
 * Run (production sheet — use the ID from PRODUCTION_GOOGLE_SPREADSHEET_ID in .env):
 *   npx tsx scripts/migrate-contacts-profile-version-column.ts --spreadsheet-id <production-id>
 */

import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './credentials/service-account.json';

const HEADER = 'last_profile_version_used_for_generation';

/** Resolve target spreadsheet: --spreadsheet-id wins, else GOOGLE_SPREADSHEET_ID. */
function spreadsheetIdFromArgv(): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--spreadsheet-id' && argv[i + 1]) {
      return argv[i + 1].trim();
    }
  }
  return process.env.GOOGLE_SPREADSHEET_ID?.trim();
}

async function main() {
  const spreadsheetId = spreadsheetIdFromArgv();
  if (!spreadsheetId) {
    console.error(
      'Set GOOGLE_SPREADSHEET_ID in .env or pass --spreadsheet-id <id> (e.g. production ID).',
    );
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const row1Res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Contacts!X1:Y1',
  });
  const pair = row1Res.data.values?.[0];
  const xHeader = pair?.[0]?.trim();
  const yHeader = pair?.[1]?.trim();

  if (xHeader && xHeader !== 'pipeline_status') {
    console.warn(
      'Expected Contacts column X to be pipeline_status; found:',
      JSON.stringify(xHeader),
    );
  }

  if (yHeader === HEADER) {
    console.log('Contacts column Y header already correct — nothing to do.');
    console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
    return;
  }

  if (yHeader) {
    console.warn(
      'Replacing existing Contacts!Y1 value:',
      JSON.stringify(yHeader),
      '→',
      HEADER,
    );
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Contacts!Y1',
    valueInputOption: 'RAW',
    requestBody: { values: [[HEADER]] },
  });

  console.log('Contacts!Y1 set to:', HEADER);
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
