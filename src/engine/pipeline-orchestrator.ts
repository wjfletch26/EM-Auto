/**
 * Pipeline Orchestrator — runs contacts through the intelligence pipeline.
 *
 * The cron scheduler calls runPipelineCycle() which:
 * 1. Finds contacts with pipeline_status = 'new' → runs research + alignment
 * 2. Finds contacts with pipeline_status = 'ready_for_generation' → runs email gen + QC
 *
 * Each contact moves through the state machine defined in the build plan.
 * Errors at any stage are caught, logged, and written to the Company Intel tab.
 */

import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import * as sheets from '../services/sheets.js';
import { createPerplexityProvider, createLLMProvider, type LLMProvider } from '../services/llm-provider.js';
import { researchCompany, type CompanyProfile } from '../skills/company-research.js';
import { evaluateAlignment } from '../skills/deaton-alignment.js';
import { generateEmailSequence } from '../skills/email-generator.js';
import { regenerateSingleReviewEmail, buildQcRemediation } from '../skills/regenerate-review-email.js';
import { runFullMergedQC } from './email-qc-runner.js';
import type { Contact, CompanyIntelligence, ReviewQueueEntry } from '../services/sheets-types.js';
import type { AlignmentResult } from '../skills/deaton-alignment.js';

// ─── Mutex ───────────────────────────────────────────────────────────────────

let pipelineRunning = false;

// ─── Max retries for failed stages ───────────────────────────────────────────

const MAX_RETRIES = 3;
const MAX_AUTO_REGEN_ROUNDS = 2;
const REQUIRED_SEQUENCE_STEPS = 12;

// ─── Main Pipeline Cycle ─────────────────────────────────────────────────────

/**
 * Runs a single pipeline cycle. Called by the cron scheduler.
 * Processes contacts in two phases:
 *   Phase A: new → research + alignment
 *   Phase B: ready_for_generation → email gen + quality review
 */
export async function runPipelineCycle(): Promise<void> {
  if (!config.pipeline.enabled) return;

  if (pipelineRunning) {
    logger.debug({ module: 'pipeline' }, 'Pipeline cycle skipped: previous run in progress');
    return;
  }

  pipelineRunning = true;

  try {
    const [contacts, intelRows] = await Promise.all([
      sheets.getContacts(),
      sheets.getCompanyIntelligence(),
    ]);

    // Build lookup for existing intel rows
    const intelByEmail = new Map<string, CompanyIntelligence>();
    for (const row of intelRows) {
      intelByEmail.set(row.contactEmail, row);
    }

    // Phase A: Process new contacts (research + alignment)
    const newContacts = contacts.filter((c) => c.pipelineStatus === 'new' && c.companyUrl);
    if (newContacts.length > 0) {
      logger.info({ module: 'pipeline', count: newContacts.length }, 'Processing new contacts');
    }
    for (const contact of newContacts) {
      await processResearchAndAlignment(contact, intelByEmail);
    }

    // Phase B: Process contacts ready for email generation
    // Re-read intel rows since Phase A may have updated them
    const freshIntel = await sheets.getCompanyIntelligence();
    const freshIntelByEmail = new Map<string, CompanyIntelligence>();
    for (const row of freshIntel) {
      freshIntelByEmail.set(row.contactEmail, row);
    }

    // Phase A sets 'alignment_complete'; that's the trigger for Phase B.
    const readyContacts = contacts.filter(
      (c) => c.pipelineStatus === 'alignment_complete' || c.pipelineStatus === 'ready_for_generation',
    );
    if (readyContacts.length > 0) {
      logger.info({ module: 'pipeline', count: readyContacts.length }, 'Generating emails for ready contacts');
    }
    for (const contact of readyContacts) {
      const intel = freshIntelByEmail.get(contact.email);
      if (intel) {
        await processEmailGeneration(contact, intel);
      }
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'pipeline', error: msg }, 'Pipeline cycle error');
  } finally {
    pipelineRunning = false;
  }
}

// ─── Phase A: Research + Alignment ───────────────────────────────────────────

async function processResearchAndAlignment(
  contact: Contact,
  intelByEmail: Map<string, CompanyIntelligence>,
): Promise<void> {
  const log = { module: 'pipeline', email: contact.email, company: contact.company };

  try {
    // Update status to researching
    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'researching' });

    // Step 1: Research via Perplexity
    logger.info(log, 'Starting research');
    const perplexity = createPerplexityProvider(config);
    const profile = await researchCompany(perplexity, contact.companyUrl);

    // Write research results to Company Intelligence tab
    const existing = intelByEmail.get(contact.email);
    const now = new Date().toISOString();

    if (existing) {
      await sheets.updateCompanyIntelligence(contact.email, existing._rowIndex, {
        companyName: profile.company_name,
        industry: profile.industry,
        productSummary: profile.product_summary,
        companySize: profile.company_size || 'unknown',
        signals: JSON.stringify(profile.signals),
        signalSummary: profile.signal_summary,
        pipelineStatus: 'researched',
        researchedDate: now,
      });
    } else {
      await sheets.appendCompanyIntelligence({
        contactEmail: contact.email,
        companyUrl: contact.companyUrl,
        companyName: profile.company_name,
        industry: profile.industry,
        productSummary: profile.product_summary,
        companySize: profile.company_size || 'unknown',
        signals: JSON.stringify(profile.signals),
        signalSummary: profile.signal_summary,
        deatonCapabilitiesMatched: '',
        caseStudiesSelected: '',
        alignmentRationale: '',
        confidenceScore: '',
        davidProjectNotes: '',
        executiveBrief: '',
        pipelineStatus: 'researched',
        researchedDate: now,
        generatedDate: '',
        errorLog: '',
      });
    }

    // Step 2: Alignment via LLM
    logger.info(log, 'Starting alignment');
    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'aligning' });

    const llm = createLLMProvider(config);
    const alignment = await evaluateAlignment(llm, profile);

    // Re-read the intel row to get the correct row index
    const freshIntel = await sheets.getCompanyIntelligence();
    const intelRow = freshIntel.find((r) => r.contactEmail === contact.email);
    if (!intelRow) throw new Error('Intel row not found after research write');

    // Check for no-fit
    const newStatus = alignment.no_fit_flag ? 'no_fit' : 'alignment_complete';

    await sheets.updateCompanyIntelligence(contact.email, intelRow._rowIndex, {
      deatonCapabilitiesMatched: alignment.relevant_capabilities
        .map((c) => c.capability_name).join(', '),
      caseStudiesSelected: alignment.selected_case_studies
        .map((c) => c.case_study_id).join(', '),
      alignmentRationale: alignment.connection_bridge,
      confidenceScore: alignment.confidence,
      pipelineStatus: newStatus,
    });

    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: newStatus });

    logger.info({ ...log, status: newStatus, confidence: alignment.confidence }, 'Research + alignment complete');

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ ...log, error: msg }, 'Research/alignment failed');

    // Write error and set failed status
    await safeUpdateStatus(contact, 'research_failed', msg);
  }
}

// ─── Phase B: Email Generation + Quality Review ──────────────────────────────

async function processEmailGeneration(
  contact: Contact,
  intel: CompanyIntelligence,
): Promise<void> {
  const log = { module: 'pipeline', email: contact.email, company: contact.company };

  try {
    // Idempotency guard: do not generate twice if an unsent sequence already exists.
    const reviewQueue = await sheets.getReviewQueue();
    if (hasExistingUnloadedSequence(contact.email, reviewQueue)) {
      logger.warn(
        { ...log },
        'Unsent 12-step review queue sequence already exists; skipping regeneration',
      );
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'pending_review' });
      return;
    }

    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'generating' });

    // Reconstruct the company profile from intel data
    const profile: CompanyProfile = {
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

    // Reconstruct alignment from intel data
    const alignment: AlignmentResult = {
      relevant_capabilities: intel.deatonCapabilitiesMatched.split(', ')
        .filter(Boolean)
        .map((name) => ({ capability_key: name.toLowerCase().replace(/ /g, '_'), capability_name: name, relevance_explanation: '' })),
      selected_case_studies: intel.caseStudiesSelected.split(', ')
        .filter(Boolean)
        .map((id) => ({ case_study_id: id, relevance_rationale: '' })),
      connection_bridge: intel.alignmentRationale,
      confidence: intel.confidenceScore as 'high' | 'medium' | 'low',
      confidence_reasoning: '',
      no_fit_flag: false,
      no_fit_reason: null,
    };

    // Generate 12-email sequence
    logger.info(log, 'Generating email sequence');
    const llm = createLLMProvider(config);
    const emailSequence = await generateEmailSequence(
      llm,
      profile,
      alignment,
      {
        firstName: contact.firstName,
        lastName: contact.lastName,
        title: contact.title,
        company: contact.company,
      },
      intel.davidProjectNotes,
    );

    const allowlistedCaseStudyIds = intel.caseStudiesSelected
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let sequence = emailSequence;
    const regenAttemptByStep = new Map<number, number>();

    let qcResult = await runFullMergedQC({
      provider: llm,
      companyProfile: profile,
      sequence,
      alignment,
      contactTitle: contact.title,
      allowlistedCaseStudyIds,
      davidProjectNotes: intel.davidProjectNotes,
    });

    for (let round = 1; round <= MAX_AUTO_REGEN_ROUNDS; round++) {
      const failing = qcResult.email_reviews
        .filter((r) => !r.pass)
        .sort((a, b) => a.step - b.step);
      if (failing.length === 0) break;

      logger.info({ ...log, round, failingSteps: failing.map((f) => f.step) }, 'Auto QC regeneration round');

      for (const failedStep of failing) {
        const current = sequence.emails.find((e) => e.step === failedStep.step);
        if (!current) continue;
        const attemptNumber = (regenAttemptByStep.get(failedStep.step) ?? 0) + 1;
        regenAttemptByStep.set(failedStep.step, attemptNumber);

        const otherEmails = sequence.emails
          .filter((e) => e.step !== failedStep.step)
          .map((e) => ({ step: e.step, subject: e.subject, body: e.body }));
        const qcRemediation = buildQcRemediation(failedStep.issues, failedStep.suggestion);
        const subjectBefore = current.subject;
        const bodyBefore = current.body;

        try {
          const rewritten = await regenerateSingleReviewEmail(llm, {
            regenMode: 'auto_qc',
            companyProfile: profile,
            alignment,
            contact: {
              firstName: contact.firstName,
              lastName: contact.lastName,
              title: contact.title,
              company: contact.company,
            },
            personaTitle: contact.title,
            stepNumber: failedStep.step,
            stepPurpose: current.purpose,
            originalEmail: { subject: current.subject, body: current.body },
            otherEmails,
            davidProjectNotes: intel.davidProjectNotes,
            qcRemediation,
          });

          current.subject = rewritten.subject;
          current.body = rewritten.body;

          await sheets.appendQcRegenAudit({
            timestamp: new Date().toISOString(),
            contactEmail: contact.email,
            stepNumber: failedStep.step,
            attemptNumber,
            regenMode: 'auto_qc',
            inputSourcesUsed: JSON.stringify(['qc_remediation', 'david_project_notes', 'sequence_context']),
            triggerReason: 'merged_qc_fail',
            qcIssuesJson: JSON.stringify(failedStep.issues),
            suggestionUsed: (failedStep.suggestion ?? '').slice(0, 200),
            subjectBefore,
            bodyBefore,
            subjectAfter: rewritten.subject,
            bodyAfter: rewritten.body,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ ...log, step: failedStep.step, round, error: msg }, 'Auto regeneration failed for step');
        }
      }

      qcResult = await runFullMergedQC({
        provider: llm,
        companyProfile: profile,
        sequence,
        alignment,
        contactTitle: contact.title,
        allowlistedCaseStudyIds,
        davidProjectNotes: intel.davidProjectNotes,
      });
    }

    // Write emails to Review Queue
    const now = new Date().toISOString();
    const failedAfterAuto = new Set(
      qcResult.email_reviews.filter((r) => !r.pass).map((r) => r.step),
    );
    const reviewEntries = sequence.emails.map((email) => {
      // Annotate with QC flags if present
      const emailReview = qcResult.email_reviews.find((r) => r.step === email.step);
      const notes = emailReview && !emailReview.pass
        ? `AUTO_QC_EXHAUSTED (manual required): ${emailReview.issues.join('; ')}`
        : '';
      const subject = normalizeGeneratedSubject(email.subject, email.purpose, email.step, contact.company);

      return {
        contactEmail: contact.email,
        companyName: intel.companyName,
        stepNumber: email.step,
        emailPurpose: email.purpose,
        subject,
        body: normalizeGreetingBody(email.body, contact.firstName),
        status: 'pending_review',
        reviewerNotes: notes,
        generatedDate: now,
        approvedDate: '',
        campaignId: '',
        daveNotes: '',
        manualReviewRequired: failedAfterAuto.has(email.step),
        qcAutoStatus: failedAfterAuto.has(email.step)
          ? ('auto_exhausted' as const)
          : ('ok' as const),
        nextAction: failedAfterAuto.has(email.step) ? 'await_user_notes' : '',
        regenMode: '' as const,
      };
    });

    await sheets.appendReviewQueueBatch(reviewEntries);

    // Generate executive brief
    const briefParts = [
      `Company: ${profile.company_name}`,
      `Industry: ${profile.industry}`,
      `Product: ${profile.product_summary}`,
      `Signals: ${profile.signal_summary}`,
      `Deaton Fit: ${alignment.connection_bridge}`,
      `Confidence: ${alignment.confidence}`,
      `Capabilities Matched: ${intel.deatonCapabilitiesMatched}`,
      `Case Studies: ${intel.caseStudiesSelected}`,
      failedAfterAuto.size > 0 ? `Manual Review Required Steps: ${[...failedAfterAuto].sort((a, b) => a - b).join(', ')}` : '',
      qcResult.overall_pass
        ? `QC: PASSED (${qcResult.overall_score})`
        : `QC: FLAGGED — ${qcResult.flags.join('; ')}`,
    ];
    const executiveBrief = briefParts.join('\n\n');

    // Update intel and contact status
    await sheets.updateCompanyIntelligence(contact.email, intel._rowIndex, {
      executiveBrief,
      pipelineStatus: 'complete',
      generatedDate: now,
    });

    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'pending_review' });

    logger.info({ ...log, qcPass: qcResult.overall_pass }, 'Email generation + QC complete');

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ ...log, error: msg }, 'Email generation failed');
    await safeUpdateStatus(contact, 'generation_failed', msg);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safely update contact status and write error to intel tab. */
async function safeUpdateStatus(contact: Contact, status: string, error: string): Promise<void> {
  try {
    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: status });

    // Try to write error to intel tab
    const intel = await sheets.getCompanyIntelligence();
    const row = intel.find((r) => r.contactEmail === contact.email);
    if (row) {
      const existingErrors = row.errorLog ? `${row.errorLog}\n` : '';
      await sheets.updateCompanyIntelligence(contact.email, row._rowIndex, {
        errorLog: `${existingErrors}[${new Date().toISOString()}] ${error}`.slice(0, 5000),
        pipelineStatus: status,
      });
    }
  } catch {
    logger.error({ module: 'pipeline', email: contact.email }, 'Failed to write error status');
  }
}

/** Parse JSON safely with a fallback. */
function safeParseJSON<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

/**
 * Returns true when contact already has an unassigned, unsuperseded 12-step review batch.
 * This prevents duplicate generation when retries or overlapping runs occur.
 */
export function hasExistingUnloadedSequence(
  contactEmail: string,
  reviewQueue: ReviewQueueEntry[],
): boolean {
  const target = contactEmail.trim().toLowerCase();
  const rows = reviewQueue.filter(
    (r) => r.contactEmail === target && !r.campaignId?.trim() && r.status !== 'superseded',
  );
  if (rows.length < REQUIRED_SEQUENCE_STEPS) return false;

  const uniqueSteps = new Set(rows.map((r) => r.stepNumber).filter((s) => s >= 1 && s <= REQUIRED_SEQUENCE_STEPS));
  return uniqueSteps.size === REQUIRED_SEQUENCE_STEPS;
}

/**
 * Normalizes generated subject and provides a safe fallback when models return empty subjects.
 */
export function normalizeGeneratedSubject(
  subject: string,
  purpose: string,
  step: number,
  company: string,
): string {
  const trimmed = (subject || '').trim();
  if (trimmed && !/^\(no subject\)$/i.test(trimmed)) return trimmed;

  const purposeTrimmed = (purpose || '').trim();
  if (purposeTrimmed) {
    return `${purposeTrimmed} - ${company}`.slice(0, 90);
  }
  return `Quick question about ${company} (step ${step})`.slice(0, 90);
}

/**
 * Ensures greeting names are on their own line in queued drafts:
 * "Simon, scaling..." -> "Simon,\n\nscaling..."
 */
export function normalizeGreetingBody(body: string, firstName: string): string {
  const trimmedBody = (body || '').trimStart();
  const name = (firstName || '').trim();

  if (name) {
    const exactPattern = new RegExp(`^(${escapeRegex(name)}),\\s*([\\s\\S]+)$`, 'i');
    const exactMatch = trimmedBody.match(exactPattern);
    if (exactMatch) {
      return `${exactMatch[1]},\n\n${exactMatch[2].trim()}`;
    }
  }

  const genericMatch = trimmedBody.match(
    /^([A-Za-z][A-Za-z.'-]{1,30}(?:\s+[A-Za-z][A-Za-z.'-]{1,30}){0,2}),\s*([\s\S]+)$/,
  );
  if (genericMatch) {
    return `${genericMatch[1]},\n\n${genericMatch[2].trim()}`;
  }

  return body;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
