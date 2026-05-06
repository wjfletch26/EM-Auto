/**
 * Maps stored Company Profiles sheet rows to skill-layer types used by email generation.
 */

import type { CompanyProfile } from '../skills/company-research.js';
import type { AlignmentResult } from '../skills/deaton-alignment.js';
import type { StoredCompanyProfile } from '../services/sheets-types.js';

export function companyProfileFromStored(row: StoredCompanyProfile): CompanyProfile {
  let signals: unknown[] = [];
  try {
    signals = JSON.parse(row.signals || '[]') as unknown[];
    if (!Array.isArray(signals)) signals = [];
  } catch {
    signals = [];
  }

  return {
    company_name: row.companyName,
    website: row.companyUrl || row.canonicalCompanyUrl,
    industry: row.industry,
    product_summary: row.productSummary,
    company_size: row.companySize,
    signals: signals as CompanyProfile['signals'],
    signal_summary: row.signalSummary,
    technologies_mentioned: [],
    key_challenges_inferred: [],
  };
}

export function alignmentFromStored(row: StoredCompanyProfile): AlignmentResult {
  return {
    relevant_capabilities: row.deatonCapabilitiesMatched
      .split(', ')
      .filter(Boolean)
      .map((name) => ({
        capability_key: name.toLowerCase().replace(/ /g, '_'),
        capability_name: name,
        relevance_explanation: '',
      })),
    selected_case_studies: row.caseStudiesSelected
      .split(', ')
      .filter(Boolean)
      .map((id) => ({ case_study_id: id, relevance_rationale: '' })),
    connection_bridge: row.alignmentRationale,
    confidence: row.confidenceScore as 'high' | 'medium' | 'low',
    confidence_reasoning: '',
    no_fit_flag: false,
    no_fit_reason: null,
  };
}

/** Shared profile is usable for new contacts / refresh when alignment succeeded (or stale after failed refresh). */
export function storedProfileHasAlignment(row: StoredCompanyProfile): boolean {
  const s = row.pipelineStatus.trim().toLowerCase();
  if (s === 'alignment_complete') return true;
  if (s === 'refresh_failed' && row.caseStudiesSelected.trim() !== '') return true;
  return false;
}
