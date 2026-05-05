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
    let queued = 0;

    for (const row of rows) {
      if (!storedProfileHasAlignment(row)) continue;

      const t = lastTouchEpochMs(row);
      if (!Number.isNaN(t) && t >= cutoff) continue;

      const canonical = normalizeCanonicalCompanyUrl(row.canonicalCompanyUrl);
      if (!canonical) continue;

      queued += 1;

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

    if (queued > 0) {
      logger.info({ module: 'company-refresh', queued }, 'Company profile refresh pass finished');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'company-refresh', error: msg }, 'Company refresh outer error');
  } finally {
    intelligenceJobExit();
  }
}
