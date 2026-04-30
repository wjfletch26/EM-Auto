/**
 * CLI — re-run the pipeline for one contact (same behavior as dashboard POST /pipeline/run-contact).
 *
 * Default reset is `new` (full path from company_url). Pass a second arg to match the API reset modes.
 *
 * Usage:
 *   npx tsx scripts/rerun-full-sequence.ts john@example.com
 *   npx tsx scripts/rerun-full-sequence.ts john@example.com alignment_complete
 */

import dotenv from 'dotenv';
dotenv.config();

import { config } from '../src/config/index.js';
import {
  runPipelineForContact,
  type PipelineResetMode,
} from '../src/ops/pipeline-contact-run.js';

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error(
      'Usage: npx tsx scripts/rerun-full-sequence.ts <contact_email> [auto|new|alignment_complete]',
    );
    process.exit(1);
  }

  const resetArg = process.argv[3];
  let reset: PipelineResetMode = 'new';
  if (resetArg) {
    if (resetArg !== 'auto' && resetArg !== 'new' && resetArg !== 'alignment_complete') {
      console.error('Optional reset must be: auto | new | alignment_complete');
      process.exit(1);
    }
    reset = resetArg;
  }

  if (!config.pipeline.enabled) {
    console.error('PIPELINE_ENABLED is false — enable it in .env to run generation.');
    process.exit(1);
  }

  console.log(`Rerunning pipeline for ${email} (reset=${reset})...\n`);

  // Single entry point: adjusts pipeline_status if needed, then runPipelineCycle + runApprovalWatcherCycle.
  const result = await runPipelineForContact(email, reset);

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));

  if (result.pipelinePrepare) {
    console.log(`\n${result.pipelinePrepare}`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
