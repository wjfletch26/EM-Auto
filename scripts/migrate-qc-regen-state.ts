/**
 * Adds machine-state headers for Review Queue and creates QC Regen Audit tab.
 * Safe to run multiple times.
 *
 * Run: npx tsx scripts/migrate-qc-regen-state.ts
 */

import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!;
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './credentials/service-account.json';
const AUDIT_TAB = 'QC Regen Audit';

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

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tabs = meta.data.sheets ?? [];
  const hasAudit = tabs.some((s) => s.properties?.title === AUDIT_TAB);

  if (!hasAudit) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: AUDIT_TAB } } }],
      },
    });
    console.log(`Created tab: ${AUDIT_TAB}`);
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: "'Review Queue'!M1", values: [['manual_review_required']] },
        { range: "'Review Queue'!N1", values: [['qc_auto_status']] },
        { range: "'Review Queue'!O1", values: [['next_action']] },
        { range: "'Review Queue'!P1", values: [['regen_mode']] },
        {
          range: `'${AUDIT_TAB}'!A1:M1`,
          values: [[
            'timestamp', 'contact_email', 'step_number', 'attempt_number', 'regen_mode',
            'input_sources_used', 'trigger_reason', 'qc_issues_json', 'suggestion_used',
            'subject_before', 'body_before', 'subject_after', 'body_after',
          ]],
        },
      ],
    },
  });

  console.log('Review Queue state headers and QC Regen Audit headers are set.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
