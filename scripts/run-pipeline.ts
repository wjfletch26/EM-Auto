/**
 * Manual pipeline runner — processes contacts through the intelligence pipeline.
 *
 * Use this script to run the pipeline on-demand instead of waiting for cron.
 * Supports processing a single contact by email or all new contacts.
 *
 * Usage:
 *   npx tsx scripts/run-pipeline.ts                    # Process all new contacts
 *   npx tsx scripts/run-pipeline.ts john@example.com   # Process a specific contact
 */

import dotenv from 'dotenv';
dotenv.config();

import { config } from '../src/config/index.js';
import { runPipelineCycle } from '../src/engine/pipeline-orchestrator.js';
import { runApprovalWatcherCycle } from '../src/engine/approval-watcher.js';
import * as sheets from '../src/services/sheets.js';

async function main(): Promise<void> {
  const targetEmail = process.argv[2];

  console.log('=== Deaton Intelligence Pipeline — Manual Run ===\n');

  if (!config.pipeline.enabled) {
    console.log('WARNING: PIPELINE_ENABLED is false in .env');
    console.log('The pipeline will not process contacts. Set PIPELINE_ENABLED=true to enable.\n');
    return;
  }

  // Show current pipeline status
  const contacts = await sheets.getContacts();
  const withUrl = contacts.filter((c) => c.companyUrl);

  console.log(`Total contacts: ${contacts.length}`);
  console.log(`Contacts with company_url: ${withUrl.length}\n`);

  // Count by pipeline status
  const statusCounts: Record<string, number> = {};
  for (const c of contacts) {
    const status = c.pipelineStatus || '(empty)';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  console.log('Pipeline status breakdown:');
  for (const [status, count] of Object.entries(statusCounts).sort()) {
    console.log(`  ${status}: ${count}`);
  }
  console.log('');

  if (targetEmail) {
    // Process a specific contact
    const contact = contacts.find((c) => c.email === targetEmail);
    if (!contact) {
      console.error(`Contact not found: ${targetEmail}`);
      process.exit(1);
    }
    if (!contact.companyUrl) {
      console.error(`Contact has no company_url: ${targetEmail}`);
      process.exit(1);
    }

    console.log(`Processing: ${contact.email} (${contact.company})`);
    console.log(`  URL: ${contact.companyUrl}`);
    console.log(`  Current status: ${contact.pipelineStatus || 'none'}\n`);

    // Reset failed or empty statuses so the pipeline picks them up
    if (!contact.pipelineStatus || contact.pipelineStatus === '' || contact.pipelineStatus === 'research_failed') {
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'new' });
      console.log('  → Set pipeline_status to "new"');
    } else if (contact.pipelineStatus === 'generation_failed') {
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'alignment_complete' });
      console.log('  → Set pipeline_status to "alignment_complete" (retry generation)');
    }
  }

  // Run the pipeline cycle
  console.log('\nRunning pipeline cycle...');
  await runPipelineCycle();

  // Run approval watcher
  console.log('Running approval watcher...');
  await runApprovalWatcherCycle();

  // Show updated status
  const updated = await sheets.getContacts();
  console.log('\nUpdated pipeline status:');
  const newStatusCounts: Record<string, number> = {};
  for (const c of updated) {
    const status = c.pipelineStatus || '(empty)';
    newStatusCounts[status] = (newStatusCounts[status] || 0) + 1;
  }
  for (const [status, count] of Object.entries(newStatusCounts).sort()) {
    console.log(`  ${status}: ${count}`);
  }

  console.log('\n=== Pipeline run complete ===');
}

main().catch((err) => {
  console.error('\nPipeline run failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
