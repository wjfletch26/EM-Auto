/**
 * Builds `locked_steps_json` for tail-style prompts from campaign sync state + Review Queue.
 */

import type { ReviewQueueEntry, Campaign } from '../services/sheets-types.js';
import type { GeneratedEmail } from '../skills/email-generator.js';
import { emailPurposeForStep } from '../skills/knowledge-loader.js';

export function pickLatestReviewRowForStep(
  rows: readonly ReviewQueueEntry[],
  emailNorm: string,
  step: number,
): ReviewQueueEntry | undefined {
  const candidates = rows.filter(
    (r) => r.contactEmail === emailNorm && r.stepNumber === step && r.status !== 'superseded',
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) => (a._rowIndex >= b._rowIndex ? a : b));
}

/**
 * Build locked steps for the tail prompt: every step **not** in `stepsToGenerate`.
 */
export function buildLockedStepsForTailPrompt(
  emailNorm: string,
  maxSynced: number,
  campaign: Campaign,
  reviewQueue: readonly ReviewQueueEntry[],
  stepsToGenerate: readonly number[],
  approvedTailSteps: ReadonlySet<number>,
): GeneratedEmail[] {
  const genSet = new Set(stepsToGenerate);
  const locked: GeneratedEmail[] = [];
  for (let s = 1; s <= 12; s++) {
    if (genSet.has(s)) continue;

    const row = pickLatestReviewRowForStep(reviewQueue, emailNorm, s);
    const purpose = (row?.emailPurpose || '').trim() || emailPurposeForStep(s);
    let subject = (row?.subject || '').trim();
    let body = (row?.body || '').trim();

    if (s <= maxSynced) {
      const cstep = campaign.steps.find((x) => x.stepNumber === s);
      if (cstep?.subject?.trim()) subject = cstep.subject.trim();
      if (cstep?.templateFile?.startsWith('ai_review_queue:')) {
        const m = cstep.templateFile.match(/ai_review_queue:(\d+)/i);
        if (m) {
          const rowIdx = parseInt(m[1], 10);
          const rqRow = reviewQueue.find((r) => r._rowIndex === rowIdx);
          if (rqRow?.body?.trim()) body = rqRow.body.trim();
        }
      }
    }

    if (approvedTailSteps.has(s) && row?.status === 'approved') {
      subject = row.subject?.trim() || subject;
      body = row.body?.trim() || body;
    }

    locked.push({ step: s, purpose, subject, body });
  }
  return locked.sort((a, b) => a.step - b.step);
}
