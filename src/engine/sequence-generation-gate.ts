/**
 * Upstream gate before expensive 12-email (or tail) generation + merged QC.
 *
 * When blocked: no generateEmailSequence, no Review Queue append, no runFullMergedQC (callers must return early).
 *
 * Track B optional (LLM “company readiness” preflight) is not implemented — rule-based checks only.
 */

import type { Contact, StoredCompanyProfile } from '../services/sheets-types.js';
import { resolveCanonicalCompanyUrl } from '../utils/resolve-canonical-company-url.js';

/** Stable primary reason for logs, Intel `error_log`, and dashboard rollups. */
export type SequenceGateReasonCode =
  | 'LOW_ALIGNMENT_CONFIDENCE'
  | 'MISSING_CASE_STUDY_SELECTION'
  | 'MISSING_PRODUCT_SUMMARY'
  | 'MISSING_SIGNAL_SUMMARY'
  | 'INVALID_CANONICAL_URL'
  | 'DUPLICATE_COMPANY_PROFILE_KEY'
  | 'NO_FIT'
  /** Company Profiles row exists but is not `alignment_complete` (and not `no_fit`). */
  | 'COMPANY_PROFILE_NOT_READY';

export type SequenceGenerationGateConfig = {
  minAlignmentConfidence: 'low' | 'medium' | 'high';
  blockOnEmptyCaseStudies: boolean;
  requireProductSummary: boolean;
  requireSignalSummary: boolean;
  requireParsableSignalsJson: boolean;
};

export type SequenceGateFail = {
  ok: false;
  reasonCode: SequenceGateReasonCode;
  details: string;
};

export type SequenceGateOk = { ok: true };

function confidenceRank(score: string): number {
  const s = score.trim().toLowerCase();
  if (s === 'high') return 2;
  if (s === 'medium') return 1;
  return 0;
}

function minRank(min: SequenceGenerationGateConfig['minAlignmentConfidence']): number {
  return confidenceRank(min);
}

function signalsJsonParseOk(signalsRaw: string): boolean {
  try {
    const v = JSON.parse(signalsRaw || '[]') as unknown;
    return Array.isArray(v);
  } catch {
    return false;
  }
}

/**
 * Single-line prefix operators can grep; dashboard parses `code=`.
 */
export function formatUpstreamGateErrorLog(reasonCode: SequenceGateReasonCode, details: string): string {
  const safeDetails = details.trim().replace(/\n/g, ' ').slice(0, 500);
  return `[UPSTREAM_GATE] code=${reasonCode} ${safeDetails}`.slice(0, 2000);
}

export function parseUpstreamGateReasonCode(errorLog: string): SequenceGateReasonCode | undefined {
  const m = errorLog.match(/\[UPSTREAM_GATE\]\s*code=(\w+)/);
  if (!m) return undefined;
  return m[1] as SequenceGateReasonCode;
}

/** Remove upstream gate lines (operator clear-block) while preserving other errors. */
export function stripUpstreamGateLinesFromErrorLog(errorLog: string): string {
  return errorLog
    .split('\n')
    .filter((line) => !line.includes('[UPSTREAM_GATE]'))
    .join('\n')
    .trimEnd();
}

/**
 * Pure gate evaluation (no I/O). Callers load `stored` and duplicate set from Sheets.
 */
export function evaluateSequenceGenerationGate(
  contact: Contact,
  stored: StoredCompanyProfile,
  canonKey: string,
  duplicateCanonicalLower: Set<string>,
  gate: SequenceGenerationGateConfig,
): SequenceGateOk | SequenceGateFail {
  const resolvedFromContact = resolveCanonicalCompanyUrl(contact.companyUrl || '');
  if (!resolvedFromContact.trim()) {
    return {
      ok: false,
      reasonCode: 'INVALID_CANONICAL_URL',
      details: 'contact.company_url resolves empty after normalize and aliases',
    };
  }

  if (duplicateCanonicalLower.has(canonKey.trim().toLowerCase())) {
    return {
      ok: false,
      reasonCode: 'DUPLICATE_COMPANY_PROFILE_KEY',
      details: 'More than one Company Profiles row shares this canonical_company_url — merge before generation',
    };
  }

  const ps = stored.pipelineStatus.trim().toLowerCase();
  if (ps === 'no_fit') {
    return { ok: false, reasonCode: 'NO_FIT', details: 'Company profile is marked no_fit' };
  }

  if (ps !== 'alignment_complete') {
    return {
      ok: false,
      reasonCode: 'COMPANY_PROFILE_NOT_READY',
      details: `Company profile pipeline_status is "${stored.pipelineStatus}", expected alignment_complete`,
    };
  }

  const rank = confidenceRank(stored.confidenceScore);
  if (rank < minRank(gate.minAlignmentConfidence)) {
    return {
      ok: false,
      reasonCode: 'LOW_ALIGNMENT_CONFIDENCE',
      details: `confidence_score="${stored.confidenceScore}" is below minimum "${gate.minAlignmentConfidence}"`,
    };
  }

  if (gate.blockOnEmptyCaseStudies) {
    if (!stored.caseStudiesSelected.trim()) {
      return {
        ok: false,
        reasonCode: 'MISSING_CASE_STUDY_SELECTION',
        details: 'case_studies_selected is empty',
      };
    }
    if (!stored.deatonCapabilitiesMatched.trim()) {
      return {
        ok: false,
        reasonCode: 'MISSING_CASE_STUDY_SELECTION',
        details: 'deaton_capabilities_matched is empty',
      };
    }
  }

  if (gate.requireProductSummary && !stored.productSummary.trim()) {
    return { ok: false, reasonCode: 'MISSING_PRODUCT_SUMMARY', details: 'product_summary is empty' };
  }

  if (gate.requireSignalSummary && !stored.signalSummary.trim()) {
    return { ok: false, reasonCode: 'MISSING_SIGNAL_SUMMARY', details: 'signal_summary is empty' };
  }

  if (gate.requireParsableSignalsJson && !signalsJsonParseOk(stored.signals)) {
    return {
      ok: false,
      reasonCode: 'MISSING_SIGNAL_SUMMARY',
      details: 'signals column is not valid JSON array',
    };
  }

  return { ok: true };
}

/** First line to prepend to executive brief on successful generation (lineage / audit). */
export function formatGenerationLineageLine(input: {
  profileVersion: string;
  promptVersion: string;
  qcRubricVersion: string;
  alignmentConfidence: string;
}): string {
  return `[Lineage profile_v=${input.profileVersion} prompt_v=${input.promptVersion} qc_rubric_v=${input.qcRubricVersion} alignment_confidence=${input.alignmentConfidence}]`;
}
