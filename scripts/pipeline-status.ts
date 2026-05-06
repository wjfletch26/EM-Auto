/**
 * Pipeline status monitor — shows the current state of all contacts in the pipeline.
 *
 * Usage: npx tsx scripts/pipeline-status.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import * as sheets from '../src/services/sheets.js';

async function main(): Promise<void> {
  console.log('=== Deaton Intelligence Pipeline — Status ===\n');

  const [contacts, intel, queue, profiles] = await Promise.all([
    sheets.getContacts(),
    sheets.getCompanyIntelligence(),
    sheets.getReviewQueue(),
    sheets.getCompanyProfiles(),
  ]);

  // ── Contacts Overview ──
  const withUrl = contacts.filter((c) => c.companyUrl);
  console.log(`Contacts: ${contacts.length} total, ${withUrl.length} with company_url\n`);

  const statusCounts: Record<string, number> = {};
  for (const c of contacts) {
    const status = c.pipelineStatus || '(not in pipeline)';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  console.log('Pipeline Status Breakdown:');
  for (const [status, count] of Object.entries(statusCounts).sort()) {
    console.log(`  ${status}: ${count}`);
  }

  // ── Company Profiles (shared intelligence) ──
  console.log(`\nCompany Profiles Tab: ${profiles.length} rows`);
  const profileStatusCounts: Record<string, number> = {};
  for (const row of profiles) {
    const status = row.pipelineStatus || '(empty)';
    profileStatusCounts[status] = (profileStatusCounts[status] || 0) + 1;
  }
  for (const [status, count] of Object.entries(profileStatusCounts).sort()) {
    console.log(`  ${status}: ${count}`);
  }

  const profileErrors = profiles.filter((r) => r.errorLog?.trim());
  if (profileErrors.length > 0) {
    console.log(`\n  ⚠ ${profileErrors.length} company profile row(s) with errors:`);
    for (const row of profileErrors) {
      console.log(`    ${row.canonicalCompanyUrl}: ${row.errorLog.slice(0, 100)}`);
    }
  }

  // ── Company Intelligence Overview (per contact) ──
  console.log(`\nCompany Intelligence Tab: ${intel.length} rows`);
  const intelStatusCounts: Record<string, number> = {};
  for (const row of intel) {
    const status = row.pipelineStatus || '(empty)';
    intelStatusCounts[status] = (intelStatusCounts[status] || 0) + 1;
  }
  for (const [status, count] of Object.entries(intelStatusCounts).sort()) {
    console.log(`  ${status}: ${count}`);
  }

  // Show errors
  const withErrors = intel.filter((r) => r.errorLog);
  if (withErrors.length > 0) {
    console.log(`\n  ⚠ ${withErrors.length} row(s) with errors:`);
    for (const row of withErrors) {
      console.log(`    ${row.contactEmail}: ${row.errorLog.slice(0, 100)}`);
    }
  }

  // ── Review Queue Overview ──
  console.log(`\nReview Queue Tab: ${queue.length} rows`);
  const queueStatusCounts: Record<string, number> = {};
  for (const entry of queue) {
    const status = entry.status || '(empty)';
    queueStatusCounts[status] = (queueStatusCounts[status] || 0) + 1;
  }
  for (const [status, count] of Object.entries(queueStatusCounts).sort()) {
    console.log(`  ${status}: ${count}`);
  }

  // Count by contact
  const queueByContact = new Map<string, number>();
  for (const entry of queue) {
    queueByContact.set(entry.contactEmail, (queueByContact.get(entry.contactEmail) || 0) + 1);
  }
  if (queueByContact.size > 0) {
    console.log('\n  Emails per contact:');
    for (const [email, count] of queueByContact) {
      const allApproved = queue
        .filter((e) => e.contactEmail === email)
        .every((e) => e.status === 'approved');
      const marker = allApproved ? '✓' : '…';
      console.log(`    ${marker} ${email}: ${count} emails`);
    }
  }

  console.log('\n=== End of status report ===');
}

main().catch((err) => {
  console.error('Status check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
