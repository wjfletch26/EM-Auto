/**
 * Adds the `dave_notes` header to Review Queue column L (row 1).
 * Idempotent: safe to run more than once.
 *
 * Run: npx tsx scripts/migrate-review-queue-dave-notes.ts
 */

import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!;
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './credentials/service-account.json';

async function main(): Promise<void> {
  if (!SPREADSHEET_ID) {
    console.error('Missing GOOGLE_SPREADSHEET_ID in .env');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: "'Review Queue'!L1",
    valueInputOption: 'RAW',
    requestBody: { values: [['dave_notes']] },
  });

  console.log('Review Queue!L1 set to: dave_notes');
  console.log(`Open: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=0`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
