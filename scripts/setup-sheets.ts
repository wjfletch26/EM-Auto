/**
 * One-time setup script: creates the 4 required tabs in the Google Spreadsheet
 * with the correct header rows per docs/DATA_MODEL.md.
 *
 * Run: npx tsx scripts/setup-sheets.ts
 */

import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!;
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './credentials/service-account.json';

// Build step headers for Campaigns tab (12 steps × 3 columns each)
function buildCampaignStepHeaders(): string[] {
  const headers: string[] = [];
  for (let i = 1; i <= 12; i++) {
    headers.push(`step_${i}_template`, `step_${i}_subject`, `step_${i}_delay_days`);
  }
  return headers;
}

// Tab definitions: name → header row
const TABS: Record<string, string[]> = {
  Contacts: [
    'email', 'first_name', 'last_name', 'company', 'title',
    'campaign_id', 'status', 'last_step_sent', 'last_send_date',
    'reply_status', 'reply_date', 'reply_snippet',
    'unsubscribed', 'unsubscribe_date', 'unsubscribe_source',
    'bounced', 'bounce_type', 'bounce_date', 'soft_bounce_count',
    'custom_1', 'custom_2', 'notes',
    'company_url', 'pipeline_status',
    'last_profile_version_used_for_generation',
  ],
  Campaigns: [
    'campaign_id', 'campaign_name', 'total_steps',
    ...buildCampaignStepHeaders(),
    'active', 'campaign_type',
  ],
  'Send Log': [
    'timestamp', 'contact_email', 'campaign_id', 'step',
    'status', 'message_id', 'error_message', 'template_used',
  ],
  'Reply Log': [
    'timestamp', 'contact_email', 'classification',
    'subject_snippet', 'body_snippet', 'source',
  ],
  'Company Profiles': [
    'canonical_company_url',
    'company_url',
    'company_name',
    'industry',
    'product_summary',
    'company_size',
    'signals',
    'signal_summary',
    'deaton_capabilities_matched',
    'case_studies_selected',
    'alignment_rationale',
    'confidence_score',
    'pipeline_status',
    'researched_date',
    'last_refreshed_at',
    'profile_version',
    'error_log',
  ],
  'Company Intelligence': [
    'contact_email',
    'canonical_company_url',
    'company_url',
    'david_project_notes',
    'executive_brief',
    'pipeline_status',
    'generated_date',
    'error_log',
  ],
  'Review Queue': [
    'contact_email', 'company_name', 'step_number', 'email_purpose',
    'subject', 'body', 'status', 'reviewer_notes',
    'generated_date', 'approved_date', 'campaign_id', 'dave_notes',
    'manual_review_required', 'qc_auto_status', 'next_action', 'regen_mode',
  ],
  'QC Regen Audit': [
    'timestamp', 'contact_email', 'step_number', 'attempt_number', 'regen_mode',
    'input_sources_used', 'trigger_reason', 'qc_issues_json', 'suggestion_used',
    'subject_before', 'body_before', 'subject_after', 'body_after',
  ],
};

/** Converts a 1-based column number to a letter (1=A, 26=Z, 27=AA, etc). */
function columnLetter(colNum: number): string {
  let letter = '';
  let num = colNum;
  while (num > 0) {
    const mod = (num - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    num = Math.floor((num - 1) / 26);
  }
  return letter;
}

async function main() {
  // Authenticate with service account
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Connecting to spreadsheet...');

  // Get existing sheet info
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingSheets = spreadsheet.data.sheets || [];
  const existingNames = existingSheets.map((s) => s.properties?.title || '');

  console.log(`Found existing tabs: ${existingNames.join(', ')}`);

  // Create missing tabs
  const requests: object[] = [];
  for (const tabName of Object.keys(TABS)) {
    if (!existingNames.includes(tabName)) {
      requests.push({ addSheet: { properties: { title: tabName } } });
      console.log(`  Will create tab: "${tabName}"`);
    } else {
      console.log(`  Tab already exists: "${tabName}"`);
    }
  }

  // Delete the default "Sheet1" if our tabs will be created
  const sheet1 = existingSheets.find((s) => s.properties?.title === 'Sheet1');
  if (sheet1 && Object.keys(TABS).some((name) => !existingNames.includes(name))) {
    // Only delete Sheet1 after adding at least one new sheet (can't have 0 sheets)
    requests.push({ deleteSheet: { sheetId: sheet1.properties?.sheetId } });
    console.log('  Will delete default "Sheet1"');
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
    console.log('Tabs created.');
  }

  // Write headers to each tab
  const headerData = Object.entries(TABS).map(([tabName, headers]) => ({
    range: `'${tabName}'!A1:${columnLetter(headers.length)}1`,
    values: [headers],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: headerData },
  });

  console.log('Headers written to all tabs.');
  console.log('\nSetup complete! Your spreadsheet is ready.');
  console.log(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
