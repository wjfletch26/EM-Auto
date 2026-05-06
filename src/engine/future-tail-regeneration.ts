/**
 * Future-tail Review Queue regeneration after company profile version bumps.
 * Does not import `company-actionable` / `companyNeedsRefreshSpend` — that stays refresh-only.
 *
 * Operator `approved` rows are never superseded; merged QC runs on a full synthetic 12.
 */

import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import * as sheets from '../services/sheets.js';
import { createLLMProvider } from '../services/llm-provider.js';
import { generateEmailSequenceTail } from '../skills/email-generator.js';
import { regenerateSingleReviewEmail, buildQcRemediation } from '../skills/regenerate-review-email.js';
import type { Contact, CompanyIntelligence, ReviewQueueEntry, Campaign } from '../services/sheets-types.js';
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
import { hasUnsyncedTailReviewRows, parseProfileVersionInt } from './sequence-funnel-state.js';
import { replaceEmDashesWithPlainHyphen } from '../content/replace-em-dashes.js';
import { normalizePlainBodyHyphens } from '../content/body-hyphen-normalize.js';
import {
  normalizeGeneratedSubject,
  normalizeGreetingBody,
} from './generated-email-normalize.js';
import type { GeneratedEmail, EmailSequence } from '../skills/email-generator.js';
import { emailPurposeForStep } from '../skills/knowledge-loader.js';

const MAX_AUTO_REGEN_ROUNDS = 3;

function pickLatestReviewRowForStep(
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
 * Build locked steps for the tail prompt: every step **not** in `stepsToGenerate`.
 */
function buildLockedStepsForTailPrompt(
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
    const purpose =
      (row?.emailPurpose || '').trim() || emailPurposeForStep(s);
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

export async function processFutureTailRegeneration(
  contact: Contact,
  intel: CompanyIntelligence | undefined,
): Promise<void> {
  const log = { module: 'pipeline', email: contact.email, company: contact.company };
  try {
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
        { ...log, event: 'regen-skip', reason: 'no_campaign_for_future_regen' },
        'Future tail regen requires an assigned campaign',
      );
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'alignment_complete' });
      return;
    }

    const reviewQueueBefore = await sheets.getReviewQueue();
    const emailNorm = contact.email.trim().toLowerCase();
    const maxSynced = maxSyncedStepFromCampaign(campaign);
    const fromStep = maxSynced + 1;

    const canonKey =
      resolveCanonicalCompanyUrl(contact.companyUrl) ||
      resolveCanonicalCompanyUrl(intel?.canonicalCompanyUrl || '');
    if (!canonKey) {
      throw new Error('Cannot resolve canonical company URL for future regen');
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
      const intelRow =
        intel ?? (await sheets.getCompanyIntelligence()).find((r) => r.contactEmail === emailNorm);
      if (intelRow) {
        const prev = intelRow.errorLog?.trim() ? `${intelRow.errorLog.trim()}\n` : '';
        await sheets.updateCompanyIntelligence(contact.email, intelRow._rowIndex, {
          errorLog: `${prev}${line}`.slice(0, 5000),
        });
      }
      await sheets.updateContact(contact.email, contact._rowIndex, {
        pipelineStatus: 'company_intelligence_blocked',
      });
      logger.info(
        { ...log, event: 'upstream_gate_block', reasonCode: gateResult.reasonCode },
        'Future tail blocked by upstream gate',
      );
      return;
    }

    const profileVersion = parseProfileVersionInt(stored.profileVersion);
    const lastUsed = parseProfileVersionInt(contact.lastProfileVersionUsedForGeneration);

    if (profileVersion <= lastUsed) {
      logger.info(
        {
          module: 'pipeline',
          event: 'regen-skip',
          contact: contact.email,
          reason: 'already_generated_for_profile_version',
          profileVersion,
          previousVersion: lastUsed,
        },
        'Future tail regen skipped (version gate)',
      );
      const needsReview = reviewQueueBefore.some(
        (e) =>
          e.contactEmail === emailNorm &&
          !e.campaignId?.trim() &&
          e.status !== 'superseded' &&
          (e.manualReviewRequired ||
            e.qcAutoStatus === 'auto_exhausted' ||
            (e.reviewerNotes || '').includes('AUTO_QC_EXHAUSTED')),
      );
      await sheets.updateContact(contact.email, contact._rowIndex, {
        pipelineStatus: needsReview ? 'pending_review' : 'approved',
      });
      return;
    }

    if (contact.lastStepSent >= 12 && maxSynced < 12) {
      logger.warn(
        {
          module: 'pipeline',
          event: 'regen-skip',
          reason: 'inconsistent_last_step_vs_campaign',
          contact: contact.email,
        },
        'last_step_sent does not match campaign max synced — needs operator attention',
      );
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'pending_review' });
      return;
    }

    if (!hasUnsyncedTailReviewRows(contact.email, maxSynced, reviewQueueBefore)) {
      logger.info(
        {
          module: 'pipeline',
          event: 'regen-skip',
          contact: contact.email,
          reason: 'no_unsynced_tail_review_rows',
        },
        'No unsynced Review Queue tail — nothing to regenerate',
      );
      await sheets.updateContact(contact.email, contact._rowIndex, {
        pipelineStatus: 'approved',
        lastProfileVersionUsedForGeneration: String(profileVersion),
      });
      return;
    }

    if (fromStep > 12) {
      await sheets.updateContact(contact.email, contact._rowIndex, {
        pipelineStatus: 'approved',
        lastProfileVersionUsedForGeneration: String(profileVersion),
      });
      return;
    }

    logger.info(
      {
        module: 'pipeline',
        event: 'regen-trigger',
        contact: contact.email,
        fromStep,
        profileVersion,
        previousVersion: lastUsed,
      },
      'Future tail regeneration starting',
    );

    await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'generating' });

    const approvedTailSteps = new Set<number>();
    for (let s = fromStep; s <= 12; s++) {
      const row = pickLatestReviewRowForStep(reviewQueueBefore, emailNorm, s);
      if (row && row.status === 'approved' && !row.campaignId?.trim()) {
        approvedTailSteps.add(s);
      }
    }

    const stepsToGenerate: number[] = [];
    for (let s = fromStep; s <= 12; s++) {
      if (!approvedTailSteps.has(s)) stepsToGenerate.push(s);
    }

    await sheets.markReviewQueueSupersededForContactStepsFrom(contact.email, fromStep);

    const reviewQueueFresh = await sheets.getReviewQueue();

    const lockedForPrompt = buildLockedStepsForTailPrompt(
      emailNorm,
      maxSynced,
      campaign,
      reviewQueueFresh,
      stepsToGenerate,
      approvedTailSteps,
    );

    const briefing = briefingForPipeline(contact, intel);
    const profile = companyProfileFromStored(stored);
    const alignment: AlignmentResult = alignmentFromStored(stored);
    const llm = createLLMProvider(config);
    const allowlistedCaseStudyIds = stored.caseStudiesSelected
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    logger.info(
      {
        ...log,
        event: 'future_tail_generation_start',
        profileVersion: stored.profileVersion.trim() || '1',
        promptVersion: config.lineage.promptVersion,
        qcRubricVersion: config.lineage.qcRubricVersion,
      },
      'Starting future-tail sequence generation',
    );

    let tailGenerated: GeneratedEmail[] = [];
    if (stepsToGenerate.length > 0) {
      tailGenerated = await generateEmailSequenceTail(
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
        stepsToGenerate,
      );
    }

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

    let qcResult = await runFullMergedQC({
      provider: llm,
      companyProfile: profile,
      sequence,
      alignment,
      contactTitle: contact.title,
      allowlistedCaseStudyIds,
      davidProjectNotes: briefing,
    });

    const genStepSet = new Set(stepsToGenerate);

    for (let round = 1; round <= MAX_AUTO_REGEN_ROUNDS; round++) {
      const failing = qcResult.email_reviews
        .filter((r) => !r.pass && genStepSet.has(r.step))
        .sort((a, b) => a.step - b.step);
      if (failing.length === 0) break;

      logger.info(
        { ...log, round, failingSteps: failing.map((f) => f.step) },
        'Future tail: auto QC regeneration round',
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
              'future_tail_regen',
            ]),
            triggerReason: 'merged_qc_fail_future_tail',
            qcIssuesJson: JSON.stringify(failedStep.issues),
            suggestionUsed: (failedStep.suggestion ?? '').slice(0, 200),
            subjectBefore,
            bodyBefore,
            subjectAfter: rewritten.subject,
            bodyAfter: rewritten.body,
          });
        } catch (err: unknown) {
          const errmsg = err instanceof Error ? err.message : String(err);
          logger.warn({ ...log, step: failedStep.step, round, error: errmsg }, 'Future tail auto regen failed');
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

    const reviewEntries = stepsToGenerate.map((stepNumber) => {
      const email = sequence.emails.find((e) => e.step === stepNumber)!;
      const emailReview = qcResult.email_reviews.find((r) => r.step === stepNumber);
      const qcNotes =
        emailReview && !emailReview.pass
          ? `AUTO_QC_EXHAUSTED (manual required): ${emailReview.issues.join('; ')}`
          : '';
      const lineageStamp = formatGenerationLineageLine({
        profileVersion: String(profileVersion),
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

    if (reviewEntries.length > 0) {
      await sheets.appendReviewQueueBatch(reviewEntries);
    }

    const anyManual = reviewEntries.some((e) => e.manualReviewRequired || e.qcAutoStatus === 'auto_exhausted');
    const terminalPipeline = anyManual ? 'pending_review' : 'approved';

    await sheets.updateContact(contact.email, contact._rowIndex, {
      pipelineStatus: terminalPipeline,
      lastProfileVersionUsedForGeneration: String(profileVersion),
    });

    if (intel) {
      const lineageStamp = formatGenerationLineageLine({
        profileVersion: String(profileVersion),
        promptVersion: config.lineage.promptVersion,
        qcRubricVersion: config.lineage.qcRubricVersion,
        alignmentConfidence: stored.confidenceScore.trim() || '(empty)',
      });
      const briefParts = [
        `Company: ${profile.company_name}`,
        `Future tail regeneration (profile v${profileVersion}) steps: ${stepsToGenerate.join(', ') || '(none — all tail approved)'}`,
        qcResult.overall_pass ? `QC: PASSED (${qcResult.overall_score})` : `QC: FLAGGED — ${qcResult.flags.join('; ')}`,
      ];
      await sheets.updateCompanyIntelligence(contact.email, intel._rowIndex, {
        executiveBrief: [lineageStamp, briefParts.join('\n\n')].join('\n\n'),
        pipelineStatus: 'complete',
        generatedDate: now,
      });
    }

    logger.info({ ...log, event: 'regen-complete', qcPass: qcResult.overall_pass }, 'Future tail regeneration done');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ ...log, error: msg }, 'Future tail regeneration failed');
    try {
      await sheets.updateContact(contact.email, contact._rowIndex, { pipelineStatus: 'generation_failed' });
      const intelRows = await sheets.getCompanyIntelligence();
      const row = intelRows.find((r) => r.contactEmail === contact.email);
      if (row) {
        const existingErrors = row.errorLog ? `${row.errorLog}\n` : '';
        await sheets.updateCompanyIntelligence(contact.email, row._rowIndex, {
          errorLog: `${existingErrors}[${new Date().toISOString()}] ${msg}`.slice(0, 5000),
          pipelineStatus: 'generation_failed',
        });
      }
    } catch {
      /* best-effort */
    }
  }
}
