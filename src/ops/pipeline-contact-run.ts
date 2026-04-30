/**
 * Manual pipeline kick for one contact — mirrors `scripts/run-pipeline.ts` email branch,
 * then runs the same cycles the cron uses.
 */

import { config } from '../config/index.js';
import { runApprovalWatcherCycle } from '../engine/approval-watcher.js';
import { runPipelineCycle } from '../engine/pipeline-orchestrator.js';
import * as sheets from '../services/sheets.js';

export type PipelineResetMode = 'auto' | 'new' | 'alignment_complete';

export type RunPipelineForContactResult = {
  email: string;
  /** Human-readable description of a pipeline_status tweak applied before the run, if any. */
  pipelinePrepare: string | null;
};

/**
 * Optionally adjusts `pipeline_status`, then runs one pipeline cycle + approval watcher.
 *
 * @param resetMode `auto` matches the CLI script; `new` forces full research from `company_url`;
 *        `alignment_complete` reruns email generation using existing Company Intelligence.
 */
export async function runPipelineForContact(
  emailRaw: string,
  resetMode: PipelineResetMode = 'auto',
): Promise<RunPipelineForContactResult> {
  const email = emailRaw.trim().toLowerCase();
  if (!email) throw new Error('email is required');

  if (!config.pipeline.enabled) {
    throw new Error('PIPELINE_ENABLED is false — enable it in .env to run the intelligence pipeline.');
  }

  const contacts = await sheets.getContacts();
  const contact = contacts.find((c) => c.email === email);
  if (!contact) throw new Error(`Contact not found: ${email}`);
  if (!contact.companyUrl?.trim()) throw new Error('Contact has no company_url');

  let pipelinePrepare: string | null = null;

  if (resetMode === 'new') {
    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'new' });
    pipelinePrepare = 'Set pipeline_status to new (full pipeline from company URL).';
  } else if (resetMode === 'alignment_complete') {
    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'alignment_complete' });
    pipelinePrepare = 'Set pipeline_status to alignment_complete (email generation + QC only).';
  } else {
    const ps = contact.pipelineStatus || '';
    if (!ps || ps === 'research_failed') {
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'new' });
      pipelinePrepare = 'Adjusted pipeline_status to new (was empty or research_failed).';
    } else if (ps === 'generation_failed') {
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'alignment_complete' });
      pipelinePrepare = 'Adjusted pipeline_status to alignment_complete (retry after generation_failed).';
    }
  }

  await runPipelineCycle();
  await runApprovalWatcherCycle();

  return { email, pipelinePrepare };
}
