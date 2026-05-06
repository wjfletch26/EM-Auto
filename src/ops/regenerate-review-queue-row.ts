/**
 * Regenerates one Review Queue row (same behavior as the CLI script).
 * Shared by `scripts/regenerate-review-queue-email.ts` and the dashboard API.
 */

import { config } from '../config/index.js';
import { createLLMProvider } from '../services/llm-provider.js';
import * as sheets from '../services/sheets.js';
import type { CompanyIntelligence, Contact } from '../services/sheets-types.js';
import type { EmailSequence } from '../skills/email-generator.js';
import {
  buildQcRemediation,
  regenerateSingleReviewEmail,
  reviewRegeneratedEmailCohesion,
} from '../skills/regenerate-review-email.js';
import { runFullMergedQC } from '../engine/email-qc-runner.js';
import { companyProfileFromStored, alignmentFromStored } from '../engine/company-profile-helpers.js';
import { mergeContactBriefing } from '../engine/contact-briefing.js';
import { resolveCanonicalCompanyUrl } from '../utils/resolve-canonical-company-url.js';

export type RegenerateReviewRowResult = {
  cohesionPass: boolean;
  hardPass: boolean;
  manualReviewRequired: boolean;
  /** Short hint for the UI — full text is written to reviewer_notes in the sheet. */
  diagnosticsPreview: string;
};

export function deriveUserDirectedRegenMode(
  userNotes: string,
  davidNotes: string,
): 'user_notes' | 'david_notes' | 'mixed_manual' {
  if (userNotes && davidNotes) return 'mixed_manual';
  return userNotes ? 'user_notes' : 'david_notes';
}

export function buildUserDirectedInputSources(
  userNotes: string,
  davidNotes: string,
): string {
  return JSON.stringify([
    ...(userNotes ? ['user_notes'] : []),
    ...(davidNotes ? ['david_project_notes'] : []),
    'merged_contact_briefing',
    'qc_remediation_history',
    'sequence_context',
  ]);
}

/**
 * Mirrors Phase B briefing: Contacts notes/custom + Company Intelligence David notes +
 * Review Queue per-step Dave instructions.
 */
function buildRegenerationBrief(intel: CompanyIntelligence, contact: Contact, stepDaveNotes: string): string {
  let base = mergeContactBriefing(contact, intel);
  const step = stepDaveNotes.trim();
  if (step) {
    base = base
      ? `${base}\n\nReview Queue step instructions (Dave):\n${step}`
      : `Review Queue step instructions (Dave):\n${step}`;
  }
  return base;
}

/**
 * Regenerates subject/body for a Review Queue row using David notes from the sheet
 * or an optional override (dashboard “test input” without pre-filling the sheet).
 */
export async function regenerateReviewQueueRow(
  rowIndex: number,
  options?: { daveNotesOverride?: string; userNotesOverride?: string },
): Promise<RegenerateReviewRowResult> {
  if (!Number.isInteger(rowIndex) || rowIndex < 2) {
    throw new Error('rowIndex must be a sheet row number >= 2');
  }

  const queue = await sheets.getReviewQueue();
  const entry = queue.find((e) => e._rowIndex === rowIndex);
  if (!entry) throw new Error(`No Review Queue row with index ${rowIndex}`);
  if (!entry.manualReviewRequired || entry.nextAction !== 'await_user_notes') {
    throw new Error('Row is not awaiting user notes; user-directed regeneration is blocked until auto QC exhausts.');
  }

  const daveNotes = (options?.daveNotesOverride ?? entry.daveNotes).trim();
  const userNotes = (options?.userNotesOverride ?? '').trim();
  if (!daveNotes && !userNotes) {
    throw new Error('Both dave_notes and user notes are empty — provide at least one user-directed input.');
  }

  const siblings = queue
    .filter((e) => e.contactEmail === entry.contactEmail)
    .sort((a, b) => a.stepNumber - b.stepNumber);

  const intelRows = await sheets.getCompanyIntelligence();
  const intel = intelRows.find((r) => r.contactEmail === entry.contactEmail);
  if (!intel) throw new Error('Company Intelligence row not found for this contact');

  const contacts = await sheets.getContacts();
  const contact = contacts.find((c) => c.email.toLowerCase() === entry.contactEmail);
  if (!contact) throw new Error('Contacts row not found for this email');

  const canonKey =
    resolveCanonicalCompanyUrl(contact.companyUrl) ||
    resolveCanonicalCompanyUrl(intel.canonicalCompanyUrl || '');
  if (!canonKey) throw new Error('Cannot resolve canonical company URL for regeneration');

  const profiles = await sheets.getCompanyProfiles();
  const stored = profiles.find((p) => p.canonicalCompanyUrl.trim().toLowerCase() === canonKey.toLowerCase());
  if (!stored) throw new Error(`Company profile not found for ${canonKey}`);

  const profile = companyProfileFromStored(stored);
  const alignment = alignmentFromStored(stored);

  const briefing = buildRegenerationBrief(intel, contact, daveNotes);
  const llm = createLLMProvider(config);

  const otherEmails = siblings
    .filter((e) => e.stepNumber !== entry.stepNumber)
    .map((e) => ({ step: e.stepNumber, subject: e.subject, body: e.body }));

  const failedReview = {
    issues: ['User-triggered rewrite requested after auto QC exhaustion.'],
    suggestion: 'Incorporate the provided manual notes while preserving the step purpose and CTA.',
  };
  const { subject, body } = await regenerateSingleReviewEmail(llm, {
    regenMode: 'user_directed',
    companyProfile: profile,
    alignment,
    contact: {
      firstName: contact.firstName,
      lastName: contact.lastName,
      title: contact.title,
      company: contact.company,
    },
    personaTitle: contact.title,
    stepNumber: entry.stepNumber,
    stepPurpose: entry.emailPurpose,
    originalEmail: { subject: entry.subject, body: entry.body },
    davidProjectNotes: briefing,
    qcRemediation: buildQcRemediation(failedReview.issues, failedReview.suggestion),
    userNotes,
    otherEmails,
  });

  const updatedEmails = siblings.map((e) =>
    e.stepNumber === entry.stepNumber
      ? { step: e.stepNumber, purpose: e.emailPurpose, subject, body }
      : { step: e.stepNumber, purpose: e.emailPurpose, subject: e.subject, body: e.body },
  );
  const emailSequence: EmailSequence = { emails: updatedEmails };

  const cohesion = await reviewRegeneratedEmailCohesion(llm, emailSequence, entry.stepNumber);

  const qcMerged = await runFullMergedQC({
    provider: llm,
    companyProfile: profile,
    sequence: emailSequence,
    alignment,
    contactTitle: contact.title,
    allowlistedCaseStudyIds: stored.caseStudiesSelected.split(',').map((s) => s.trim()).filter(Boolean),
    davidProjectNotes: briefing,
  });
  const stepReview = qcMerged.email_reviews.find((r) => r.step === entry.stepNumber);
  const hardPass = Boolean(stepReview?.pass);
  const manualReviewRequired = !hardPass || !cohesion.pass;

  const cohesionLine = `[Cohesion ${cohesion.pass ? 'PASS' : 'FLAG'}] ${cohesion.summary}${
    cohesion.issues.length ? ` — ${cohesion.issues.join('; ')}` : ''
  }`;

  const qcLine = !hardPass
    ? `[Merged QC FLAG] ${(stepReview?.issues ?? []).join(' | ')}`
    : '[Merged QC PASS] Step passed merged QC after user-directed rewrite.';
  const regenMode = deriveUserDirectedRegenMode(userNotes, daveNotes);

  const mergedNotes = [entry.reviewerNotes, cohesionLine, qcLine].filter(Boolean).join('\n').slice(0, 4800);
  const attemptNumber = (entry.reviewerNotes.match(/\[REGEN_ATTEMPT #/g) ?? []).length + 1;
  const attemptTag = `[REGEN_ATTEMPT #${attemptNumber}]`;

  await sheets.updateReviewQueueEntry(rowIndex, {
    subject,
    body,
    daveNotes: '',
    reviewerNotes: `${attemptTag}\n${mergedNotes}`.slice(0, 4800),
    manualReviewRequired,
    qcAutoStatus: manualReviewRequired ? 'auto_exhausted' : 'flagged',
    nextAction: manualReviewRequired ? 'await_user_notes' : '',
    regenMode,
  });

  await sheets.appendQcRegenAudit({
    timestamp: new Date().toISOString(),
    contactEmail: entry.contactEmail,
    stepNumber: entry.stepNumber,
    attemptNumber,
    regenMode,
    inputSourcesUsed: buildUserDirectedInputSources(userNotes, daveNotes),
    triggerReason: 'user_api_regen',
    qcIssuesJson: JSON.stringify(stepReview?.issues ?? []),
    suggestionUsed: failedReview.suggestion,
    subjectBefore: entry.subject,
    bodyBefore: entry.body,
    subjectAfter: subject,
    bodyAfter: body,
  });

  const diagnosticsPreview = [cohesionLine, qcLine].filter(Boolean).join(' · ').slice(0, 500);

  return {
    cohesionPass: cohesion.pass,
    hardPass,
    manualReviewRequired,
    diagnosticsPreview,
  };
}
