/**
 * Send-triggered staged batch: appends the next 4–6 / 7–9 / 10–12 Review Queue rows after milestones.
 */

import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import * as sheets from '../services/sheets.js';
import { createLLMProvider } from '../services/llm-provider.js';
import { generateEmailSequenceTail } from '../skills/email-generator.js';
import { regenerateSingleReviewEmail, buildQcRemediation } from '../skills/regenerate-review-email.js';
import type { Contact, CompanyIntelligence, Campaign } from '../services/sheets-types.js';
import type { AlignmentResult } from '../skills/deaton-alignment.js';
import { resolveCanonicalCompanyUrl } from '../utils/resolve-canonical-company-url.js';
import { duplicateCanonicalUrlsLowercased } from '../utils/canonical-sheet-audit.js';
import {
  evaluateSequenceGenerationGate,
  formatUpstreamGateErrorLog,
  formatGenerationLineageLine,
} from './sequence-generation-gate.js';
import { companyProfileFromStored, alignmentFromStored } from './company-profile-helpers.js';
import { mergeContactBriefing } from './contact-briefing.js';
import { runFullMergedQC } from './email-qc-runner.js';
import { maxSyncedStepFromCampaign } from './approval-watcher.js';
import { replaceEmDashesWithPlainHyphen } from '../content/replace-em-dashes.js';
import { normalizePlainBodyHyphens } from '../content/body-hyphen-normalize.js';
import {
  normalizeGeneratedSubject,
  normalizeGreetingBody,
} from './generated-email-normalize.js';
import type { GeneratedEmail, EmailSequence } from '../skills/email-generator.js';
import type { CompanyProfile } from '../skills/company-research.js';
import { buildLockedStepsForTailPrompt, pickLatestReviewRowForStep } from './tail-prompt-locked-steps.js';
import { nextBatchToGenerateFromSends, normalizeLastStepSent } from './staged-sequence-batches.js';

const MAX_AUTO_REGEN_ROUNDS = 3;

function briefingForPipeline(contact: Contact, intel: CompanyIntelligence | undefined): string {
  if (intel) return mergeContactBriefing(contact, intel);
  return mergeContactBriefing(contact, {
    contactEmail: contact.email,
    canonicalCompanyUrl: '',
    companyUrl: contact.companyUrl || '',
    davidProjectNotes: '',
    executiveBrief: '',
    pipelineStatus: '',
    generatedDate: '',
    errorLog: '',
    _rowIndex: 0,
  });
}

/**
 * Pipeline Phase B entry for `pipeline_status = staged_sequence_continue`.
 */
export async function processStagedSequenceContinuation(
  contact: Contact,
  intel: CompanyIntelligence | undefined,
): Promise<void> {
  const log = { module: 'pipeline', email: contact.email, company: contact.company };
  try {
    if (!intel) {
      logger.warn({ ...log }, 'Staged continuation requires a Company Intelligence row — skipping');
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'approved' });
      return;
    }

    const campaignRows = await sheets.getCampaigns();
    const campaignById = new Map<string, Campaign>();
    for (const c of campaignRows) {
      const id = c.campaignId?.trim();
      if (id && !campaignById.has(id)) campaignById.set(id, c);
    }

    const cid = contact.campaignId?.trim();
    const campaign = cid ? campaignById.get(cid) : undefined;
    if (!cid || !campaign) {
      logger.error(
        { ...log, event: 'staged-skip', reason: 'no_campaign' },
        'Staged sequence continuation requires an assigned campaign',
      );
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'approved' });
      return;
    }

    const reviewQueueBefore = await sheets.getReviewQueue();
    const emailNorm = contact.email.trim().toLowerCase();
    const maxSynced = maxSyncedStepFromCampaign(campaign);
    const lastSent = normalizeLastStepSent(contact.lastStepSent);

    const stepsToGenerate = nextBatchToGenerateFromSends(lastSent, contact.email, reviewQueueBefore);

    if (!stepsToGenerate || stepsToGenerate.length === 0) {
      logger.info(
        { ...log, event: 'staged-skip', reason: 'no_batch_due', lastSent },
        'Staged continuation: no batch to generate',
      );
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'approved' });
      return;
    }

    const canonKey =
      resolveCanonicalCompanyUrl(contact.companyUrl) ||
      resolveCanonicalCompanyUrl(intel.canonicalCompanyUrl || '');
    if (!canonKey) {
      throw new Error('Cannot resolve canonical company URL for staged continuation');
    }

    const profileRows = await sheets.getCompanyProfiles();
    const stored = profileRows.find(
      (p) => p.canonicalCompanyUrl.trim().toLowerCase() === canonKey.toLowerCase(),
    );
    if (!stored) {
      throw new Error(`Company profile not found for canonical URL: ${canonKey}`);
    }

    const dupLower = duplicateCanonicalUrlsLowercased(profileRows);
    const gateResult = evaluateSequenceGenerationGate(
      contact,
      stored,
      canonKey,
      dupLower,
      config.generationGate,
    );
    if (!gateResult.ok) {
      const line = formatUpstreamGateErrorLog(gateResult.reasonCode, gateResult.details);
      const prev = intel.errorLog?.trim() ? `${intel.errorLog.trim()}\n` : '';
      await sheets.updateCompanyIntelligence(contact.email, intel._rowIndex, {
        errorLog: `${prev}${line}`.slice(0, 5000),
      });
      await sheets.updateContact(contact.email, contact._rowIndex, {
        pipelineStatus: 'company_intelligence_blocked',
      });
      logger.info(
        { ...log, event: 'upstream_gate_block', reasonCode: gateResult.reasonCode },
        'Staged continuation blocked by upstream gate',
      );
      return;
    }

    const approvedTailSteps = new Set<number>();
    for (const s of stepsToGenerate) {
      const row = pickLatestReviewRowForStep(reviewQueueBefore, emailNorm, s);
      if (row && row.status === 'approved' && !row.campaignId?.trim()) {
        approvedTailSteps.add(s);
      }
    }

    const stepsFiltered = stepsToGenerate.filter((s) => !approvedTailSteps.has(s));
    if (stepsFiltered.length === 0) {
      logger.info({ ...log, event: 'staged-skip', reason: 'batch_fully_approved' }, 'Staged batch already approved');
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'approved' });
      return;
    }

    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'generating' });

    const supersedeFrom = Math.min(...stepsFiltered);
    await sheets.markReviewQueueSupersededForContactStepsFrom(contact.email, supersedeFrom);

    const reviewQueueFresh = await sheets.getReviewQueue();

    const lockedForPrompt = buildLockedStepsForTailPrompt(
      emailNorm,
      maxSynced,
      campaign,
      reviewQueueFresh,
      stepsFiltered,
      approvedTailSteps,
    );

    const briefing = briefingForPipeline(contact, intel);
    const profile: CompanyProfile = companyProfileFromStored(stored);
    const alignment: AlignmentResult = alignmentFromStored(stored);
    const llm = createLLMProvider(config);
    const allowlistedCaseStudyIds = stored.caseStudiesSelected
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    logger.info(
      {
        ...log,
        event: 'staged_continuation_generation_start',
        steps: stepsFiltered,
        profileVersion: stored.profileVersion.trim() || '1',
        promptVersion: config.lineage.promptVersion,
        qcRubricVersion: config.lineage.qcRubricVersion,
      },
      'Staged sequence continuation: generating batch',
    );

    const tailGenerated = await generateEmailSequenceTail(
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
      lockedForPrompt,
      stepsFiltered,
    );

    const fullEmails: GeneratedEmail[] = [];
    for (let s = 1; s <= 12; s++) {
      const gen = tailGenerated.find((t) => t.step === s);
      if (gen) {
        fullEmails.push(gen);
        continue;
      }
      const lock = lockedForPrompt.find((l) => l.step === s);
      if (!lock) {
        throw new Error(`Missing locked content for synthetic step ${s}`);
      }
      fullEmails.push(lock);
    }

    const sequence: EmailSequence = { emails: fullEmails };
    const regenAttemptByStep = new Map<number, number>();
    const genStepSet = new Set(stepsFiltered);

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
        .filter((r) => !r.pass && genStepSet.has(r.step))
        .sort((a, b) => a.step - b.step);
      if (failing.length === 0) break;

      logger.info(
        { ...log, round, failingSteps: failing.map((f) => f.step) },
        'Staged continuation: auto QC regeneration round',
      );

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
              'staged_continuation',
            ]),
            triggerReason: 'merged_qc_fail_staged_continuation',
            qcIssuesJson: JSON.stringify(failedStep.issues),
            suggestionUsed: (failedStep.suggestion ?? '').slice(0, 200),
            subjectBefore,
            bodyBefore,
            subjectAfter: rewritten.subject,
            bodyAfter: rewritten.body,
          });
        } catch (err: unknown) {
          const errmsg = err instanceof Error ? err.message : String(err);
          logger.warn({ ...log, step: failedStep.step, round, error: errmsg }, 'Staged continuation auto regen failed');
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

    const reviewEntries = stepsFiltered.map((stepNumber) => {
      const email = sequence.emails.find((e) => e.step === stepNumber)!;
      const emailReview = qcResult.email_reviews.find((r) => r.step === stepNumber);
      const qcNotes =
        emailReview && !emailReview.pass
          ? `AUTO_QC_EXHAUSTED (manual required): ${emailReview.issues.join('; ')}`
          : '';
      const lineageStamp = formatGenerationLineageLine({
        profileVersion: stored.profileVersion.trim() || '1',
        promptVersion: config.lineage.promptVersion,
        qcRubricVersion: config.lineage.qcRubricVersion,
        alignmentConfidence: stored.confidenceScore.trim() || '(empty)',
      });
      const reviewerNotes = [lineageStamp, qcNotes].filter(Boolean).join('\n');
      const subject = replaceEmDashesWithPlainHyphen(
        normalizeGeneratedSubject(email.subject, email.purpose, stepNumber, contact.company),
      );

      return {
        contactEmail: contact.email,
        companyName: stored.companyName,
        stepNumber,
        emailPurpose: email.purpose,
        subject,
        body: normalizePlainBodyHyphens(
          replaceEmDashesWithPlainHyphen(normalizeGreetingBody(email.body, contact.firstName)),
        ),
        status: 'pending_review',
        reviewerNotes,
        generatedDate: now,
        approvedDate: '',
        campaignId: '',
        daveNotes: '',
        manualReviewRequired: failedAfterAuto.has(stepNumber),
        qcAutoStatus: failedAfterAuto.has(stepNumber) ? ('auto_exhausted' as const) : ('ok' as const),
        nextAction: failedAfterAuto.has(stepNumber) ? 'await_user_notes' : '',
        regenMode: '' as const,
      };
    });

    await sheets.appendReviewQueueBatch(reviewEntries);

    const anyManual = reviewEntries.some((e) => e.manualReviewRequired || e.qcAutoStatus === 'auto_exhausted');
    const terminalPipeline = anyManual ? 'pending_review' : 'approved';

    await sheets.updateContact(contact.email, contact._rowIndex, {
      pipelineStatus: terminalPipeline,
    });

    const lineageStamp = formatGenerationLineageLine({
      profileVersion: stored.profileVersion.trim() || '1',
      promptVersion: config.lineage.promptVersion,
      qcRubricVersion: config.lineage.qcRubricVersion,
      alignmentConfidence: stored.confidenceScore.trim() || '(empty)',
    });
    const briefParts = [
      `Company: ${profile.company_name}`,
      `Staged batch steps: ${stepsFiltered.join(', ')}`,
      qcResult.overall_pass ? `QC: PASSED (${qcResult.overall_score})` : `QC: FLAGGED — ${qcResult.flags.join('; ')}`,
    ];
    await sheets.updateCompanyIntelligence(contact.email, intel._rowIndex, {
      executiveBrief: [lineageStamp, briefParts.join('\n\n')].join('\n\n'),
      pipelineStatus: 'complete',
      generatedDate: now,
    });

    logger.info({ ...log, event: 'staged-continuation-complete', qcPass: qcResult.overall_pass }, 'Staged batch done');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ ...log, error: msg }, 'Staged sequence continuation failed');
    await safeUpdateStagedContinuationError(contact, msg);
  }
}

async function safeUpdateStagedContinuationError(contact: Contact, error: string): Promise<void> {
  try {
    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'generation_failed' });
    const intelRows = await sheets.getCompanyIntelligence();
    const row = intelRows.find((r) => r.contactEmail === contact.email);
    if (row) {
      const existingErrors = row.errorLog ? `${row.errorLog}\n` : '';
      await sheets.updateCompanyIntelligence(contact.email, row._rowIndex, {
        errorLog: `${existingErrors}[${new Date().toISOString()}] ${error}`.slice(0, 5000),
        pipelineStatus: 'generation_failed',
      });
    }
  } catch {
    /* best-effort */
  }
}
