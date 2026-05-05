/**
 * Pipeline Orchestrator — runs contacts through the intelligence pipeline.
 *
 * The cron scheduler calls runPipelineCycle() which:
 * 1. Finds contacts with pipeline_status = 'new' → company-scoped research + alignment (once per canonical URL),
 *    then per-contact Intel rows linked to Company Profiles.
 * 2. Finds contacts with pipeline_status = 'alignment_complete' / 'ready_for_generation' → email gen + QC
 *
 * Company intelligence is shared via the **Company Profiles** sheet (one row per canonical company URL).
 * **Company Intelligence** holds per-contact briefing (David notes, executive brief, errors).
 */

import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import * as sheets from '../services/sheets.js';
import { createPerplexityProvider, createLLMProvider } from '../services/llm-provider.js';
import { researchCompany, type CompanyProfile } from '../skills/company-research.js';
import { evaluateAlignment } from '../skills/deaton-alignment.js';
import { generateEmailSequence } from '../skills/email-generator.js';
import { regenerateSingleReviewEmail, buildQcRemediation } from '../skills/regenerate-review-email.js';
import { runFullMergedQC } from './email-qc-runner.js';
import type { Contact, CompanyIntelligence, ReviewQueueEntry, StoredCompanyProfile } from '../services/sheets-types.js';
import type { AlignmentResult } from '../skills/deaton-alignment.js';
import { normalizeCanonicalCompanyUrl, researchUrlFromCanonical } from '../utils/normalize-company-url.js';
import { withCanonicalCompanyLock } from '../utils/company-url-lock.js';
import { companyProfileFromStored, alignmentFromStored, storedProfileHasAlignment } from './company-profile-helpers.js';
import { mergeContactBriefing } from './contact-briefing.js';
import { intelligenceJobTryEnter, intelligenceJobExit } from './intelligence-job-mutex.js';
import { replaceEmDashesWithPlainHyphen } from '../content/replace-em-dashes.js';
import { normalizePlainBodyHyphens } from '../content/body-hyphen-normalize.js';


// ─── Max auto-QC regen ───────────────────────────────────────────────────────

const MAX_AUTO_REGEN_ROUNDS = 3;
const REQUIRED_SEQUENCE_STEPS = 12;

// ─── Main Pipeline Cycle ─────────────────────────────────────────────────────

/**
 * Runs a single pipeline cycle. Called by the cron scheduler.
 * Processes contacts in two phases:
 *   Phase A: new → company profile (research + alignment) + per-contact intel row
 *   Phase B: alignment_complete → email gen + quality review
 */
export async function runPipelineCycle(): Promise<void> {
  if (!config.pipeline.enabled) return;

  if (!intelligenceJobTryEnter()) {
    logger.debug({ module: 'pipeline' }, 'Pipeline cycle skipped: intelligence job already running');
    return;
  }

  try {
    const [contacts, intelRows] = await Promise.all([
      sheets.getContacts(),
      sheets.getCompanyIntelligence(),
    ]);

    const intelByEmail = new Map<string, CompanyIntelligence>();
    for (const row of intelRows) {
      intelByEmail.set(row.contactEmail, row);
    }

    const newContacts = contacts.filter((c) => c.pipelineStatus === 'new' && c.companyUrl);
    if (newContacts.length > 0) {
      logger.info({ module: 'pipeline', count: newContacts.length }, 'Processing new contacts');
    }
    for (const contact of newContacts) {
      await processResearchAndAlignment(contact, intelByEmail);
    }

    const freshIntel = await sheets.getCompanyIntelligence();
    const freshIntelByEmail = new Map<string, CompanyIntelligence>();
    for (const row of freshIntel) {
      freshIntelByEmail.set(row.contactEmail, row);
    }

    // Re-read contacts so Phase B sees pipeline_status updates from Phase A in the same cycle.
    const contactsAfterA = await sheets.getContacts();
    const readyContacts = contactsAfterA.filter(
      (c) => c.pipelineStatus === 'alignment_complete' || c.pipelineStatus === 'ready_for_generation',
    );
    if (readyContacts.length > 0) {
      logger.info({ module: 'pipeline', count: readyContacts.length }, 'Generating emails for ready contacts');
    }
    for (const contact of readyContacts) {
      const intel = freshIntelByEmail.get(contact.email);
      if (intel) {
        await processEmailGeneration(contact, intel);
      } else {
        logger.warn(
          { module: 'pipeline', email: contact.email },
          'Contact ready for generation but no Company Intelligence row — skipping',
        );
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'pipeline', error: msg }, 'Pipeline cycle error');
  } finally {
    intelligenceJobExit();
  }
}

// ─── Phase A: Research + Alignment (company-scoped) ──────────────────────────

async function ensureContactIntelRow(
  contact: Contact,
  canonical: string,
  displayUrl: string,
  intelByEmail: Map<string, CompanyIntelligence>,
  intelPipelineStatus: string,
): Promise<void> {
  const existing = intelByEmail.get(contact.email);
  if (existing) {
    await sheets.updateCompanyIntelligence(contact.email, existing._rowIndex, {
      canonicalCompanyUrl: canonical,
      companyUrl: displayUrl,
      pipelineStatus: intelPipelineStatus,
      errorLog: '',
    });
    existing.canonicalCompanyUrl = canonical;
    existing.companyUrl = displayUrl;
    existing.pipelineStatus = intelPipelineStatus;
    existing.errorLog = '';
    return;
  }

  await sheets.appendCompanyIntelligence({
    contactEmail: contact.email,
    canonicalCompanyUrl: canonical,
    companyUrl: displayUrl,
    davidProjectNotes: '',
    executiveBrief: '',
    pipelineStatus: intelPipelineStatus,
    generatedDate: '',
    errorLog: '',
  });
  const fresh = await sheets.getCompanyIntelligence();
  const row = fresh.find((r) => r.contactEmail === contact.email);
  if (row) intelByEmail.set(contact.email, row);
}

function appendErrorLog(prev: string, msg: string): string {
  const existing = prev ? `${prev}\n` : '';
  return `${existing}[${new Date().toISOString()}] ${msg}`.slice(0, 5000);
}

async function markCompanyProfileResearchFailed(canonical: string, message: string): Promise<void> {
  const profiles = await sheets.getCompanyProfiles();
  const pr = profiles.find((p) => p.canonicalCompanyUrl.trim().toLowerCase() === canonical.toLowerCase());
  if (!pr) return;
  await sheets.updateCompanyProfileRow(canonical, pr._rowIndex, {
    pipelineStatus: 'research_failed',
    errorLog: appendErrorLog(pr.errorLog, message),
  });
}

async function processResearchAndAlignment(
  contact: Contact,
  intelByEmail: Map<string, CompanyIntelligence>,
): Promise<void> {
  const canonical = normalizeCanonicalCompanyUrl(contact.companyUrl);
  const log = { module: 'pipeline', email: contact.email, company: contact.company, canonical };

  if (!canonical) {
    await safeUpdateStatus(contact, 'research_failed', 'Missing or invalid company_url');
    return;
  }

  try {
    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'researching' });

    await withCanonicalCompanyLock(canonical, async () => {
      const profiles = await sheets.getCompanyProfiles();
      let profileRow = profiles.find(
        (p) => p.canonicalCompanyUrl.trim().toLowerCase() === canonical.toLowerCase(),
      );

      const displayUrl = contact.companyUrl.trim();

      if (profileRow && storedProfileHasAlignment(profileRow)) {
        await ensureContactIntelRow(contact, canonical, displayUrl, intelByEmail, 'alignment_complete');
        await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'alignment_complete' });
        logger.info({ ...log }, 'Reused existing company profile');
        return;
      }

      if (profileRow && profileRow.pipelineStatus.trim().toLowerCase() === 'no_fit') {
        await ensureContactIntelRow(contact, canonical, displayUrl, intelByEmail, 'no_fit');
        await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'no_fit' });
        logger.info({ ...log }, 'Company already marked no_fit');
        return;
      }

      // Resume alignment only if research finished but alignment did not (prior crash).
      if (profileRow && profileRow.pipelineStatus.trim().toLowerCase() === 'researched') {
        await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'aligning' });
        const llm = createLLMProvider(config);
        const profile = companyProfileFromStored(profileRow);
        const alignment = await evaluateAlignment(llm, profile);
        const companyStatus = alignment.no_fit_flag ? 'no_fit' : 'alignment_complete';
        await sheets.updateCompanyProfileRow(canonical, profileRow._rowIndex, {
          deatonCapabilitiesMatched: alignment.relevant_capabilities.map((c) => c.capability_name).join(', '),
          caseStudiesSelected: alignment.selected_case_studies.map((c) => c.case_study_id).join(', '),
          alignmentRationale: alignment.connection_bridge,
          confidenceScore: alignment.confidence,
          pipelineStatus: companyStatus,
          errorLog: '',
        });
        await ensureContactIntelRow(contact, canonical, displayUrl, intelByEmail, companyStatus);
        await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: companyStatus });
        logger.info({ ...log, status: companyStatus }, 'Resumed alignment from stored research');
        return;
      }

      const perplexity = createPerplexityProvider(config);
      const researchUrl = researchUrlFromCanonical(canonical) || displayUrl;
      logger.info({ ...log }, 'Starting company research (shared profile)');
      const profile = await researchCompany(perplexity, researchUrl);
      const now = new Date().toISOString();

      if (profileRow) {
        await sheets.updateCompanyProfileRow(canonical, profileRow._rowIndex, {
          companyUrl: displayUrl,
          companyName: profile.company_name,
          industry: profile.industry,
          productSummary: profile.product_summary,
          companySize: profile.company_size || 'unknown',
          signals: JSON.stringify(profile.signals),
          signalSummary: profile.signal_summary,
          pipelineStatus: 'researched',
          researchedDate: now,
          lastRefreshedAt: now,
          errorLog: '',
        });
      } else {
        await sheets.appendCompanyProfile({
          canonicalCompanyUrl: canonical,
          companyUrl: displayUrl,
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
          pipelineStatus: 'researched',
          researchedDate: now,
          lastRefreshedAt: now,
          profileVersion: '1',
          errorLog: '',
        });
      }

      const freshProfiles = await sheets.getCompanyProfiles();
      profileRow = freshProfiles.find(
        (p) => p.canonicalCompanyUrl.trim().toLowerCase() === canonical.toLowerCase(),
      );
      if (!profileRow) throw new Error('Company profile row missing after research write');

      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'aligning' });
      const llm = createLLMProvider(config);
      const alignment = await evaluateAlignment(llm, profile);
      const companyStatus = alignment.no_fit_flag ? 'no_fit' : 'alignment_complete';

      await sheets.updateCompanyProfileRow(canonical, profileRow._rowIndex, {
        deatonCapabilitiesMatched: alignment.relevant_capabilities.map((c) => c.capability_name).join(', '),
        caseStudiesSelected: alignment.selected_case_studies.map((c) => c.case_study_id).join(', '),
        alignmentRationale: alignment.connection_bridge,
        confidenceScore: alignment.confidence,
        pipelineStatus: companyStatus,
        errorLog: '',
      });

      await ensureContactIntelRow(contact, canonical, displayUrl, intelByEmail, companyStatus);
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: companyStatus });

      logger.info({ ...log, status: companyStatus, confidence: alignment.confidence }, 'Research + alignment complete');
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ ...log, error: msg }, 'Research/alignment failed');
    try {
      await markCompanyProfileResearchFailed(canonical, msg);
    } catch {
      /* best-effort */
    }
    await safeUpdateStatus(contact, 'research_failed', msg);
  }
}

// ─── Phase B: Email Generation + Quality Review ──────────────────────────────

async function processEmailGeneration(contact: Contact, intel: CompanyIntelligence): Promise<void> {
  const log = { module: 'pipeline', email: contact.email, company: contact.company };

  try {
    const reviewQueue = await sheets.getReviewQueue();
    if (hasExistingUnloadedSequence(contact.email, reviewQueue)) {
      logger.warn(
        { ...log },
        'Unsent 12-step review queue sequence already exists; skipping regeneration',
      );
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'pending_review' });
      return;
    }

    const canonKey =
      intel.canonicalCompanyUrl.trim() || normalizeCanonicalCompanyUrl(contact.companyUrl);
    if (!canonKey) {
      throw new Error('Cannot resolve canonical company URL for generation');
    }

    const profileRows = await sheets.getCompanyProfiles();
    const stored = profileRows.find((p) => p.canonicalCompanyUrl.trim().toLowerCase() === canonKey.toLowerCase());
    if (!stored) {
      throw new Error(`Company profile not found for canonical URL: ${canonKey}`);
    }

    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'generating' });

    const profile: CompanyProfile = companyProfileFromStored(stored);
    const alignment: AlignmentResult = alignmentFromStored(stored);
    const briefing = mergeContactBriefing(contact, intel);

    const allowlistedCaseStudyIds = stored.caseStudiesSelected
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

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
      briefing,
    );

    let sequence = emailSequence;
    const regenAttemptByStep = new Map<number, number>();

    let qcResult = await runFullMergedQC({
      provider: llm,
      companyProfile: profile,
      sequence,
      alignment,
      contactTitle: contact.title,
      allowlistedCaseStudyIds,
      davidProjectNotes: briefing,
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
            davidProjectNotes: briefing,
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
            inputSourcesUsed: JSON.stringify([
              'qc_remediation',
              'merged_contact_briefing',
              'sequence_context',
            ]),
            triggerReason: 'merged_qc_fail',
            qcIssuesJson: JSON.stringify(failedStep.issues),
            suggestionUsed: (failedStep.suggestion ?? '').slice(0, 200),
            subjectBefore,
            bodyBefore,
            subjectAfter: rewritten.subject,
            bodyAfter: rewritten.body,
          });
        } catch (err: unknown) {
          const errmsg = err instanceof Error ? err.message : String(err);
          logger.warn({ ...log, step: failedStep.step, round, error: errmsg }, 'Auto regeneration failed for step');
        }
      }

      qcResult = await runFullMergedQC({
        provider: llm,
        companyProfile: profile,
        sequence,
        alignment,
        contactTitle: contact.title,
        allowlistedCaseStudyIds,
        davidProjectNotes: briefing,
      });
    }

    const now = new Date().toISOString();
    const failedAfterAuto = new Set(qcResult.email_reviews.filter((r) => !r.pass).map((r) => r.step));
    const reviewEntries = sequence.emails.map((email) => {
      const emailReview = qcResult.email_reviews.find((r) => r.step === email.step);
      const notes =
        emailReview && !emailReview.pass
          ? `AUTO_QC_EXHAUSTED (manual required): ${emailReview.issues.join('; ')}`
          : '';
      const subject = replaceEmDashesWithPlainHyphen(
        normalizeGeneratedSubject(email.subject, email.purpose, email.step, contact.company),
      );

      return {
        contactEmail: contact.email,
        companyName: stored.companyName,
        stepNumber: email.step,
        emailPurpose: email.purpose,
        subject,
        body: normalizePlainBodyHyphens(
          replaceEmDashesWithPlainHyphen(normalizeGreetingBody(email.body, contact.firstName)),
        ),
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

    const briefParts = [
      `Company: ${profile.company_name}`,
      `Industry: ${profile.industry}`,
      `Product: ${profile.product_summary}`,
      `Signals: ${profile.signal_summary}`,
      `Deaton Fit: ${alignment.connection_bridge}`,
      `Confidence: ${alignment.confidence}`,
      `Capabilities Matched: ${stored.deatonCapabilitiesMatched}`,
      `Case Studies: ${stored.caseStudiesSelected}`,
      failedAfterAuto.size > 0
        ? `Manual Review Required Steps: ${[...failedAfterAuto].sort((a, b) => a - b).join(', ')}`
        : '',
      qcResult.overall_pass
        ? `QC: PASSED (${qcResult.overall_score})`
        : `QC: FLAGGED — ${qcResult.flags.join('; ')}`,
    ];
    const executiveBrief = briefParts.join('\n\n');

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
