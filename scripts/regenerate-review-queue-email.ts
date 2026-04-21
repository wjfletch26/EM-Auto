/**
 * Regenerates one Review Queue email using the `dave_notes` cell for that row,
 * runs cohesion review on the full 12-step set, runs hard QC, then writes
 * subject/body, clears `dave_notes`, and appends diagnostics to reviewer_notes.
 *
 * Usage:
 *   npx tsx scripts/regenerate-review-queue-email.ts <row_index>
 *
 * Row index is the Google Sheet row number (same value used in ai_review_queue:<row>).
 */

import dotenv from 'dotenv';
dotenv.config();

import { config } from '../src/config/index.js';
import { runHardEmailQC } from '../src/engine/email-hard-qc.js';
import { createLLMProvider } from '../src/services/llm-provider.js';
import * as sheets from '../src/services/sheets.js';
import type { CompanyIntelligence } from '../src/services/sheets-types.js';
import type { CompanyProfile } from '../src/skills/company-research.js';
import type { EmailSequence } from '../src/skills/email-generator.js';
import {
  regenerateSingleReviewEmail,
  reviewRegeneratedEmailCohesion,
} from '../src/skills/regenerate-review-email.js';

function safeParseJSON<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

function buildProfile(intel: CompanyIntelligence): CompanyProfile {
  return {
    company_name: intel.companyName,
    website: intel.companyUrl,
    industry: intel.industry,
    product_summary: intel.productSummary,
    company_size: intel.companySize,
    signals: safeParseJSON(intel.signals, []),
    signal_summary: intel.signalSummary,
    technologies_mentioned: [],
    key_challenges_inferred: [],
  };
}

function buildAlignment(intel: CompanyIntelligence) {
  return {
    relevant_capabilities: intel.deatonCapabilitiesMatched
      .split(', ')
      .filter(Boolean)
      .map((name) => ({
        capability_key: name.toLowerCase().replace(/ /g, '_'),
        capability_name: name,
        relevance_explanation: '',
      })),
    selected_case_studies: intel.caseStudiesSelected
      .split(', ')
      .filter(Boolean)
      .map((id) => ({ case_study_id: id, relevance_rationale: '' })),
    connection_bridge: intel.alignmentRationale,
    confidence: intel.confidenceScore as 'high' | 'medium' | 'low',
    confidence_reasoning: '',
    no_fit_flag: false,
    no_fit_reason: null,
  };
}

async function main(): Promise<void> {
  const rowArg = process.argv[2];
  if (!rowArg) {
    console.error('Usage: npx tsx scripts/regenerate-review-queue-email.ts <review_queue_row_index>');
    process.exit(1);
  }
  const rowIndex = parseInt(rowArg, 10);
  if (Number.isNaN(rowIndex) || rowIndex < 2) {
    console.error('row_index must be a sheet row number (header is row 1).');
    process.exit(1);
  }

  const queue = await sheets.getReviewQueue();
  const entry = queue.find((e) => e._rowIndex === rowIndex);
  if (!entry) {
    console.error(`No Review Queue row with index ${rowIndex}.`);
    process.exit(1);
  }

  const daveNotes = entry.daveNotes.trim();
  if (!daveNotes) {
    console.error('dave_notes is empty — nothing to regenerate.');
    process.exit(1);
  }

  const siblings = queue
    .filter((e) => e.contactEmail === entry.contactEmail)
    .sort((a, b) => a.stepNumber - b.stepNumber);

  const intelRows = await sheets.getCompanyIntelligence();
  const intel = intelRows.find((r) => r.contactEmail === entry.contactEmail);
  if (!intel) {
    console.error('Company Intelligence row not found for this contact.');
    process.exit(1);
  }

  const contacts = await sheets.getContacts();
  const contact = contacts.find((c) => c.email.toLowerCase() === entry.contactEmail);
  if (!contact) {
    console.error('Contacts row not found for this email.');
    process.exit(1);
  }

  const profile = buildProfile(intel);
  const alignment = buildAlignment(intel);
  const llm = createLLMProvider(config);

  const otherEmails = siblings
    .filter((e) => e.stepNumber !== entry.stepNumber)
    .map((e) => ({ step: e.stepNumber, subject: e.subject, body: e.body }));

  console.log(`Regenerating step ${entry.stepNumber} for ${entry.contactEmail}...`);
  const { subject, body } = await regenerateSingleReviewEmail(llm, {
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
    daveNotes,
    otherEmails,
  });

  const updatedEmails = siblings.map((e) =>
    e.stepNumber === entry.stepNumber
      ? { step: e.stepNumber, purpose: e.emailPurpose, subject, body }
      : { step: e.stepNumber, purpose: e.emailPurpose, subject: e.subject, body: e.body },
  );
  const emailSequence: EmailSequence = { emails: updatedEmails };

  console.log('Running cohesion review...');
  const cohesion = await reviewRegeneratedEmailCohesion(llm, emailSequence, entry.stepNumber);

  const allowlistedCaseStudyIds = intel.caseStudiesSelected
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const hard = runHardEmailQC({
    emails: updatedEmails.map((e) => ({ step: e.step, subject: e.subject, body: e.body })),
    allowlistedCaseStudyIds,
    davidProjectNotes: daveNotes,
  });

  const cohesionLine = `[Cohesion ${cohesion.pass ? 'PASS' : 'FLAG'}] ${cohesion.summary}${
    cohesion.issues.length ? ` — ${cohesion.issues.join('; ')}` : ''
  }`;

  const hardParts: string[] = [];
  if (!hard.pass) {
    hardParts.push(...hard.globalFlags);
    for (const [step, issues] of hard.issuesByStep) {
      for (const msg of issues) hardParts.push(`step ${step}: ${msg}`);
    }
  }
  const hardLine = hardParts.length ? `[Hard QC FLAG] ${hardParts.join(' | ')}` : '';

  const mergedNotes = [entry.reviewerNotes, cohesionLine, hardLine].filter(Boolean).join('\n').slice(0, 4800);

  await sheets.updateReviewQueueEntry(rowIndex, {
    subject,
    body,
    daveNotes: '',
    reviewerNotes: mergedNotes,
  });

  console.log('\nDone. Row updated; dave_notes cleared.');
  if (!cohesion.pass || !hard.pass) {
    console.log('Check reviewer_notes for cohesion / hard QC output.');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
