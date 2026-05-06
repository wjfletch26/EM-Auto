/**
 * Monthly (or cron-driven) refresh of Company Profiles rows.
 *
 * Re-runs Perplexity research + Deaton alignment so shared company context stays current.
 * Uses the same intelligence mutex as the main pipeline — never overlaps Phase A/B.
 *
 * Profiles with `pipeline_status = no_fit` are skipped until an operator resets them manually.
 */

import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import * as sheets from '../services/sheets.js';
import { createPerplexityProvider, createLLMProvider } from '../services/llm-provider.js';
import { researchCompany } from '../skills/company-research.js';
import { evaluateAlignment } from '../skills/deaton-alignment.js';
import { normalizeCanonicalCompanyUrl, researchUrlFromCanonical } from '../utils/normalize-company-url.js';
import { withCanonicalCompanyLock } from '../utils/company-url-lock.js';
import { intelligenceJobTryEnter, intelligenceJobExit } from './intelligence-job-mutex.js';
import { storedProfileHasAlignment } from './company-profile-helpers.js';
import { companyNeedsRefreshSpend, type CompanyRefreshSpendSnapshot } from './company-actionable.js';
import { contactsAtCanonical, hasUnsyncedTailReviewRows, parseProfileVersionInt } from './sequence-funnel-state.js';
import { maxSyncedStepFromCampaign } from './approval-watcher.js';
import type { Campaign } from '../services/sheets-types.js';

function lastTouchEpochMs(row: { lastRefreshedAt: string; researchedDate: string }): number {
  const ts = row.lastRefreshedAt?.trim() || row.researchedDate?.trim();
  if (!ts) return NaN;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? NaN : n;
}

function appendLimitedError(prev: string, msg: string): string {
  const existing = prev ? `${prev}\n` : '';
  return `${existing}[${new Date().toISOString()}] ${msg}`.slice(0, 5000);
}

/**
 * After a successful profile refresh, set `regenerate_future_sequence` when tail RQ work exists
 * and profile version advanced past `lastProfileVersionUsedForGeneration` per contact.
 */
async function armRegenerateFutureSequenceAfterRefresh(
  canonical: string,
  newProfileVersion: string,
): Promise<void> {
  const [contacts, reviewQueue, campaignRows] = await Promise.all([
    sheets.getContacts(),
    sheets.getReviewQueue(),
    sheets.getCampaigns(),
  ]);

  const campaignById = new Map<string, Campaign>();
  for (const c of campaignRows) {
    const id = c.campaignId?.trim();
    if (id && !campaignById.has(id)) campaignById.set(id, c);
  }

  const pv = parseProfileVersionInt(newProfileVersion);
  const at = contactsAtCanonical(contacts, canonical);

  for (const contact of at) {
    const cid = contact.campaignId?.trim();
    const campaign = cid ? campaignById.get(cid) : undefined;
    const maxSynced = maxSyncedStepFromCampaign(campaign);

    if (maxSynced >= 12) continue;

    if (contact.lastStepSent >= 12 && maxSynced < 12) {
      logger.warn(
        {
          module: 'company-refresh',
          event: 'regen-skip',
          contact: contact.email,
          reason: 'inconsistent_last_step_vs_campaign',
        },
        'Skip arming future-tail regen — sheet inconsistency',
      );
      continue;
    }

    if (!hasUnsyncedTailReviewRows(contact.email, maxSynced, reviewQueue)) {
      logger.info(
        {
          module: 'company-refresh',
          event: 'regen-skip',
          contact: contact.email,
          reason: 'no_unsynced_tail_review_rows',
        },
        'No unsynced Review Queue tail for this contact',
      );
      continue;
    }

    const lastUsed = parseProfileVersionInt(contact.lastProfileVersionUsedForGeneration);
    if (pv <= lastUsed) {
      logger.info(
        {
          module: 'company-refresh',
          event: 'regen-skip',
          contact: contact.email,
          reason: 'already_generated_for_profile_version',
          profileVersion: pv,
          previousVersion: lastUsed,
        },
        'Profile version did not advance past last generation version for contact',
      );
      continue;
    }

    if (contact.pipelineStatus?.trim().toLowerCase() === 'regenerate_future_sequence') {
      logger.info(
        {
          module: 'company-refresh',
          event: 'regen-skip',
          contact: contact.email,
          reason: 'already_regenerate_future_sequence',
        },
        'Contact already queued for future-tail regen',
      );
      continue;
    }

    logger.info(
      {
        module: 'company-refresh',
        event: 'regen-trigger',
        contact: contact.email,
        fromStep: maxSynced + 1,
        profileVersion: pv,
        previousVersion: lastUsed,
      },
      'Arming regenerate_future_sequence after profile refresh',
    );

    await sheets.updateContact(contact.email, contact._rowIndex, {
      pipelineStatus: 'regenerate_future_sequence',
    });
  }
}

/**
 * Processes every Company Profiles row older than `companyStaleAfterDays` that still has usable alignment.
 */
export async function runCompanyProfileRefreshCycle(): Promise<void> {
  if (!config.pipeline.enabled || !config.pipeline.companyRefreshEnabled) return;

  if (!intelligenceJobTryEnter()) {
    logger.debug({ module: 'company-refresh' }, 'Skipped — intelligence job busy');
    return;
  }

  try {
    const staleMs = config.pipeline.companyStaleAfterDays * 86_400_000;
    const cutoff = Date.now() - staleMs;
    const rows = await sheets.getCompanyProfiles();

    const [contacts, reviewQueue, campaignRows] = await Promise.all([
      sheets.getContacts(),
      sheets.getReviewQueue(),
      sheets.getCampaigns(),
    ]);
    const campaignById = new Map<string, Campaign>();
    for (const c of campaignRows) {
      const id = c.campaignId?.trim();
      if (id && !campaignById.has(id)) campaignById.set(id, c);
    }
    const nowDate = new Date();
    const spendSnapshot: CompanyRefreshSpendSnapshot = {
      contacts,
      reviewQueue,
      campaignById,
      now: nowDate,
    };

    let refreshAttempts = 0;

    for (const row of rows) {
      if (!storedProfileHasAlignment(row)) continue;

      const t = lastTouchEpochMs(row);
      if (!Number.isNaN(t) && t >= cutoff) continue;

      const canonical = normalizeCanonicalCompanyUrl(row.canonicalCompanyUrl);
      if (!canonical) continue;

      if (!companyNeedsRefreshSpend(canonical, spendSnapshot)) {
        logger.info(
          {
            module: 'company-refresh',
            event: 'refresh-skip',
            canonical,
            reason: 'no_refresh_spend_worthwhile',
          },
          'Skipped stale profile refresh — companyNeedsRefreshSpend is false',
        );
        continue;
      }

      await withCanonicalCompanyLock(canonical, async () => {
        const freshList = await sheets.getCompanyProfiles();
        const current = freshList.find(
          (p) => p.canonicalCompanyUrl.trim().toLowerCase() === canonical.toLowerCase(),
        );
        if (!current || !storedProfileHasAlignment(current)) return;

        const t2 = lastTouchEpochMs(current);
        if (!Number.isNaN(t2) && t2 >= cutoff) return;

        const log = { module: 'company-refresh', canonical };
        logger.info(log, 'Refreshing stale company profile');

        try {
          const perplexity = createPerplexityProvider(config);
          const url = researchUrlFromCanonical(canonical) || current.companyUrl.trim();
          const profile = await researchCompany(perplexity, url);
          const now = new Date().toISOString();
          const llm = createLLMProvider(config);
          const alignment = await evaluateAlignment(llm, profile);
          const nextVersion = String((parseInt(current.profileVersion, 10) || 1) + 1);
          const companyStatus = alignment.no_fit_flag ? 'no_fit' : 'alignment_complete';

          await sheets.updateCompanyProfileRow(canonical, current._rowIndex, {
            companyName: profile.company_name,
            industry: profile.industry,
            productSummary: profile.product_summary,
            companySize: profile.company_size || 'unknown',
            signals: JSON.stringify(profile.signals),
            signalSummary: profile.signal_summary,
            deatonCapabilitiesMatched: alignment.relevant_capabilities.map((c) => c.capability_name).join(', '),
            caseStudiesSelected: alignment.selected_case_studies.map((c) => c.case_study_id).join(', '),
            alignmentRationale: alignment.connection_bridge,
            confidenceScore: alignment.confidence,
            pipelineStatus: companyStatus,
            researchedDate: current.researchedDate || now,
            lastRefreshedAt: now,
            profileVersion: nextVersion,
            errorLog: '',
          });

          logger.info({ ...log, status: companyStatus, profileVersion: nextVersion }, 'Company profile refreshed');
          refreshAttempts += 1;

          if (!alignment.no_fit_flag) {
            await armRegenerateFutureSequenceAfterRefresh(canonical, nextVersion);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ ...log, error: msg }, 'Company profile refresh failed — keeping prior alignment columns');
          await sheets.updateCompanyProfileRow(canonical, current._rowIndex, {
            pipelineStatus: 'refresh_failed',
            errorLog: appendLimitedError(current.errorLog, msg),
          });
        }
      });
    }

    if (refreshAttempts > 0) {
      logger.info({ module: 'company-refresh', refreshAttempts }, 'Company profile refresh pass finished');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'company-refresh', error: msg }, 'Company refresh outer error');
  } finally {
    intelligenceJobExit();
  }
}
