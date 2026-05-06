/**
 * CLI: print canonical integrity audit (duplicate profile keys + intel drift).
 *
 * Uses GOOGLE_SPREADSHEET_ID (or --spreadsheet-id) and GOOGLE_SERVICE_ACCOUNT_PATH from .env.
 *
 * Run: npx tsx scripts/audit-canonical-profiles.ts
 */

import dotenv from 'dotenv';

dotenv.config();

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--spreadsheet-id' && argv[i + 1]) {
    process.env.GOOGLE_SPREADSHEET_ID = argv[i + 1].trim();
    break;
  }
}

const { buildDashboardSummary } = await import('../src/web/dashboard-summary.js');
const sheets = await import('../src/services/sheets.js');

async function main() {
  const [contacts, intel, queue, profiles] = await Promise.all([
    sheets.getContacts(),
    sheets.getCompanyIntelligence(),
    sheets.getReviewQueue(),
    sheets.getCompanyProfiles(),
  ]);
  const summary = buildDashboardSummary(contacts, intel, queue, profiles);
  console.log(JSON.stringify(summary.canonicalAudit, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
