/**
 * Builds a JSON-friendly snapshot of pipeline spreadsheet state for the operator dashboard.
 *
 * This mirrors the CLI report in `scripts/pipeline-status.ts`, but returns structured data
 * so the web UI can render cards and tables without duplicating counting rules in JavaScript.
 */

import type {
  CompanyIntelligence,
  Contact,
  ReviewQueueEntry,
  StoredCompanyProfile,
} from '../services/sheets-types.js';
import {
  findDuplicateCompanyProfileKeys,
  findIntelCanonicalDrift,
  type DuplicateProfileKeyReport,
  type IntelDriftRow,
} from '../utils/canonical-sheet-audit.js';
import {
  buildUpstreamHealthSnapshot,
  type CompanyHealthRow,
  type UpstreamBlockedSample,
} from './dashboard-upstream-health.js';
import { buildResearchPhaseDashboard, type ResearchPhaseDashboard } from './dashboard-research-phase.js';

/** One bucket of string keys → counts (pipeline statuses, review statuses, etc.). */
export type StatusBreakdown = Record<string, number>;

/** Truncated error row for the UI — avoids sending huge error strings to the browser. */
export type IntelErrorPreview = {
  contactEmail: string;
  /** Short slice of `errorLog` so the table stays readable. */
  preview: string;
};

/** Company Profiles tab: `error_log` preview keyed by canonical URL (column A). */
export type ProfileErrorPreview = {
  canonicalUrl: string;
  preview: string;
};

/** Shape returned by GET /api/dashboard/summary — stable fields for the static dashboard client. */
export type DashboardSummary = {
  /** ISO timestamp when this snapshot was assembled on the server. */
  generatedAt: string;
  contacts: {
    total: number;
    withCompanyUrl: number;
    pipelineStatus: StatusBreakdown;
  };
  companyIntelligence: {
    total: number;
    pipelineStatus: StatusBreakdown;
    errorCount: number;
    /** Up to `maxErrors` non-empty errorLog rows, newest-first by sheet order is not guaranteed. */
    errors: IntelErrorPreview[];
  };
  /** One row per canonical company URL — shared intelligence. */
  companyProfiles: {
    total: number;
    pipelineStatus: StatusBreakdown;
    errorCount: number;
    /** Up to `maxErrors` non-empty profile `error_log` rows. */
    errors: ProfileErrorPreview[];
  };
  reviewQueue: {
    total: number;
    status: StatusBreakdown;
  };
  /** Company Profiles duplicate keys + Intel column B drift vs resolve(contact company_url). */
  canonicalAudit: {
    duplicateProfileKeys: DuplicateProfileKeyReport[];
    intelDrift: IntelDriftRow[];
    intelDriftTruncated: boolean;
  };
  /**
   * Contacts stopped by the upstream sequence gate (`company_intelligence_blocked` on Contacts;
   * reasons in Company Intelligence `error_log`).
   */
  upstreamGate: {
    blockedContactCount: number;
    blockedByReason: StatusBreakdown;
    samples: UpstreamBlockedSample[];
  };
  /**
   * Per resolved canonical: shared profile snapshot + how many contacts are upstream-blocked there.
   * Derived only — never written back to Company Profiles.
   */
  companyHealth: {
    rows: CompanyHealthRow[];
    truncated: boolean;
  };
  /** Phase A / refresh: `research_failed` contacts and `research_failed` / `refresh_failed` profiles with parsed reasons. */
  researchPhase: ResearchPhaseDashboard;
};

const ERROR_PREVIEW_LEN = 160;
const MAX_ERROR_ROWS = 12;
const MAX_INTEL_DRIFT_ROWS = 24;

/**
 * Increments a count in an object — used for every status histogram in this module.
 */
function bump(map: StatusBreakdown, key: string): void {
  const label = key.trim() === '' ? '(empty)' : key;
  map[label] = (map[label] || 0) + 1;
}

/**
 * Aggregates contacts, intelligence rows, company profiles, and review-queue rows into one dashboard payload.
 *
 * @param contacts - All rows from the Contacts tab.
 * @param intel - All rows from the Company Intelligence tab (per-contact).
 * @param queue - All rows from the Review Queue tab.
 * @param profiles - All rows from the Company Profiles tab (shared per company URL).
 */
export function buildDashboardSummary(
  contacts: Contact[],
  intel: CompanyIntelligence[],
  queue: ReviewQueueEntry[],
  profiles: StoredCompanyProfile[] = [],
): DashboardSummary {
  const contactPipeline: StatusBreakdown = {};
  let withUrl = 0;
  for (const c of contacts) {
    bump(contactPipeline, c.pipelineStatus || '(not in pipeline)');
    if (c.companyUrl?.trim()) withUrl += 1;
  }

  const intelPipeline: StatusBreakdown = {};
  for (const row of intel) {
    bump(intelPipeline, row.pipelineStatus || '(empty)');
  }

  const profilePipeline: StatusBreakdown = {};
  for (const row of profiles) {
    bump(profilePipeline, row.pipelineStatus || '(empty)');
  }

  const withErrors = intel.filter((r) => Boolean(r.errorLog?.trim()));
  const errors: IntelErrorPreview[] = withErrors.slice(0, MAX_ERROR_ROWS).map((r) => ({
    contactEmail: r.contactEmail,
    preview: r.errorLog.length > ERROR_PREVIEW_LEN ? `${r.errorLog.slice(0, ERROR_PREVIEW_LEN)}…` : r.errorLog,
  }));

  const profilesWithErrors = profiles.filter((r) => Boolean(r.errorLog?.trim()));
  const profileErrors: ProfileErrorPreview[] = profilesWithErrors.slice(0, MAX_ERROR_ROWS).map((r) => ({
    canonicalUrl: r.canonicalCompanyUrl,
    preview:
      r.errorLog.length > ERROR_PREVIEW_LEN ? `${r.errorLog.slice(0, ERROR_PREVIEW_LEN)}…` : r.errorLog,
  }));

  const reviewStatus: StatusBreakdown = {};
  for (const entry of queue) {
    bump(reviewStatus, entry.status || '(empty)');
  }

  const duplicateProfileKeys = findDuplicateCompanyProfileKeys(profiles);
  const intelDriftAll = findIntelCanonicalDrift(contacts, intel);
  const intelDriftTruncated = intelDriftAll.length > MAX_INTEL_DRIFT_ROWS;

  const upstream = buildUpstreamHealthSnapshot(contacts, intel, profiles);
  const researchPhase = buildResearchPhaseDashboard(contacts, intel, profiles);

  return {
    generatedAt: new Date().toISOString(),
    contacts: {
      total: contacts.length,
      withCompanyUrl: withUrl,
      pipelineStatus: contactPipeline,
    },
    companyIntelligence: {
      total: intel.length,
      pipelineStatus: intelPipeline,
      errorCount: withErrors.length,
      errors,
    },
    companyProfiles: {
      total: profiles.length,
      pipelineStatus: profilePipeline,
      errorCount: profilesWithErrors.length,
      errors: profileErrors,
    },
    reviewQueue: {
      total: queue.length,
      status: reviewStatus,
    },
    canonicalAudit: {
      duplicateProfileKeys,
      intelDrift: intelDriftAll.slice(0, MAX_INTEL_DRIFT_ROWS),
      intelDriftTruncated,
    },
    upstreamGate: {
      blockedContactCount: upstream.blockedContactCount,
      blockedByReason: upstream.blockedByReason,
      samples: upstream.samples,
    },
    companyHealth: {
      rows: upstream.companyRows,
      truncated: upstream.companyRowsTruncated,
    },
    researchPhase,
  };
}
