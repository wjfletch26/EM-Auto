/**
 * Dashboard rollups for Phase A / refresh research failures (`research_failed`, `refresh_failed`).
 */

import {
  parseLastResearchPhaseReasonCode,
  type ResearchPhaseReasonCode,
} from '../engine/research-phase-error.js';
import type { CompanyIntelligence, Contact, StoredCompanyProfile } from '../services/sheets-types.js';
import { resolveCanonicalCompanyUrl } from '../utils/resolve-canonical-company-url.js';

export type LabelCounts = Record<string, number>;

export type ResearchFailureContactSample = {
  contactEmail: string;
  canonicalUrl: string;
  reasonCode: string;
  preview: string;
};

export type ResearchFailureProfileSample = {
  canonicalUrl: string;
  pipelineStatus: string;
  reasonCode: string;
  preview: string;
};

export type ResearchPhaseDashboard = {
  contactsResearchFailed: number;
  contactFailuresByReason: LabelCounts;
  contactSamples: ResearchFailureContactSample[];
  profilesResearchOrRefreshFailed: number;
  profileFailuresByReason: LabelCounts;
  profileSamples: ResearchFailureProfileSample[];
};

const MAX_SAMPLES = 14;
const PREVIEW_LEN = 160;

function bump(map: LabelCounts, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

function reasonFromIntelLog(errorLog: string | undefined): string {
  const raw = errorLog ?? '';
  const parsed = parseLastResearchPhaseReasonCode(raw);
  return parsed ?? 'UNPARSED';
}

/**
 * Contacts in `research_failed` (Phase A did not reach alignment_complete) plus company rows stuck in
 * `research_failed` or `refresh_failed`, with reasons parsed from `error_log`.
 */
export function buildResearchPhaseDashboard(
  contacts: Contact[],
  intel: CompanyIntelligence[],
  profiles: StoredCompanyProfile[],
): ResearchPhaseDashboard {
  const intelByEmail = new Map(intel.map((row) => [row.contactEmail, row] as const));

  const contactFailuresByReason: LabelCounts = {};
  const contactSamples: ResearchFailureContactSample[] = [];
  let contactsResearchFailed = 0;

  for (const c of contacts) {
    if ((c.pipelineStatus || '').trim().toLowerCase() !== 'research_failed') continue;
    contactsResearchFailed += 1;
    const intelRow = intelByEmail.get(c.email);
    const previewRaw = intelRow?.errorLog ?? '';
    const reason = reasonFromIntelLog(intelRow?.errorLog);
    bump(contactFailuresByReason, reason);
    if (contactSamples.length < MAX_SAMPLES) {
      const preview =
        previewRaw.length > PREVIEW_LEN ? `${previewRaw.slice(0, PREVIEW_LEN)}…` : previewRaw;
      contactSamples.push({
        contactEmail: c.email,
        canonicalUrl: resolveCanonicalCompanyUrl(c.companyUrl || '').trim() || '(empty canonical)',
        reasonCode: reason,
        preview: preview || '—',
      });
    }
  }

  const profileFailuresByReason: LabelCounts = {};
  const profileSamples: ResearchFailureProfileSample[] = [];
  let profilesResearchOrRefreshFailed = 0;

  for (const p of profiles) {
    const ps = (p.pipelineStatus || '').trim().toLowerCase();
    if (ps !== 'research_failed' && ps !== 'refresh_failed') continue;
    profilesResearchOrRefreshFailed += 1;
    const previewRaw = p.errorLog ?? '';
    const parsed = parseLastResearchPhaseReasonCode(previewRaw);
    const reason: ResearchPhaseReasonCode | 'UNPARSED' = parsed ?? 'UNPARSED';
    bump(profileFailuresByReason, reason);
    if (profileSamples.length < MAX_SAMPLES) {
      const preview =
        previewRaw.length > PREVIEW_LEN ? `${previewRaw.slice(0, PREVIEW_LEN)}…` : previewRaw;
      profileSamples.push({
        canonicalUrl: p.canonicalCompanyUrl,
        pipelineStatus: p.pipelineStatus,
        reasonCode: reason,
        preview: preview || '—',
      });
    }
  }

  return {
    contactsResearchFailed,
    contactFailuresByReason,
    contactSamples,
    profilesResearchOrRefreshFailed,
    profileFailuresByReason,
    profileSamples,
  };
}
