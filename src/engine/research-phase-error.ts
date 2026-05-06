/**
 * Structured explanations when Phase A (research + alignment) or profile refresh fails.
 *
 * Operators see `[RESEARCH_PHASE] code=…` in Company Intelligence `error_log` (per contact)
 * and Company Profiles `error_log` (shared row on failure). The dashboard parses `code=` for rollups.
 */

/** Stable primary reason — logs, Intel, profiles, dashboard. */
export type ResearchPhaseReasonCode =
  | 'INVALID_CANONICAL_URL'
  | 'RESEARCH_RESPONSE_INVALID_JSON'
  | 'RESEARCH_RESPONSE_SCHEMA_INVALID'
  | 'RESEARCH_API_ERROR'
  | 'ALIGNMENT_EVALUATION_FAILED'
  | 'PROFILE_ROW_MISSING_AFTER_WRITE'
  | 'SHEETS_WRITE_FAILED'
  | 'RESEARCH_PHASE_UNKNOWN';

/** Which step was running when the failure bubbled up (drives coarse classification). */
export type ResearchFailurePhase = 'research' | 'alignment' | 'sheet';

/**
 * Single-line prefix; keep consistent with `formatUpstreamGateErrorLog` shape for tooling.
 */
export function formatResearchPhaseErrorLog(reasonCode: ResearchPhaseReasonCode, details: string): string {
  const safe = details.trim().replace(/\n/g, ' ').slice(0, 500);
  return `[RESEARCH_PHASE] code=${reasonCode} ${safe}`.slice(0, 2000);
}

/** Best-effort parse when logs contain multiple lines — returns the last code found. */
export function parseLastResearchPhaseReasonCode(errorLog: string): ResearchPhaseReasonCode | undefined {
  const re = /\[RESEARCH_PHASE\]\s*code=(\w+)/g;
  let last: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(errorLog)) !== null) last = m[1];
  return last as ResearchPhaseReasonCode | undefined;
}

function narrowingFromMessage(detailsLower: string): ResearchPhaseReasonCode | undefined {
  if (detailsLower.includes('invalid json') || detailsLower.includes('failed to parse')) {
    return 'RESEARCH_RESPONSE_INVALID_JSON';
  }
  if (detailsLower.includes('schema validation')) {
    return 'RESEARCH_RESPONSE_SCHEMA_INVALID';
  }
  if (
    detailsLower.includes('401') ||
    detailsLower.includes('403') ||
    detailsLower.includes('429') ||
    detailsLower.includes('500') ||
    detailsLower.includes('502') ||
    detailsLower.includes('503') ||
    detailsLower.includes('fetch') ||
    detailsLower.includes('network') ||
    detailsLower.includes('econnreset') ||
    detailsLower.includes('etimedout') ||
    detailsLower.includes('socket')
  ) {
    return 'RESEARCH_API_ERROR';
  }
  if (detailsLower.includes('missing after research')) {
    return 'PROFILE_ROW_MISSING_AFTER_WRITE';
  }
  if (detailsLower.includes('google') || detailsLower.includes('spreadsheet') || detailsLower.includes('sheets api')) {
    return 'SHEETS_WRITE_FAILED';
  }
  return undefined;
}

/**
 * Maps an arbitrary thrown value to a primary reason code plus preserved detail text.
 */
export function classifyResearchFailure(
  err: unknown,
  phase: ResearchFailurePhase,
): { code: ResearchPhaseReasonCode; details: string } {
  const details = err instanceof Error ? err.message : String(err);
  const d = details.toLowerCase();

  if (phase === 'research') {
    const narrowed = narrowingFromMessage(d);
    if (narrowed && narrowed !== 'PROFILE_ROW_MISSING_AFTER_WRITE') {
      return { code: narrowed, details };
    }
    return { code: 'RESEARCH_PHASE_UNKNOWN', details };
  }

  if (phase === 'alignment') {
    const narrowed = narrowingFromMessage(d);
    if (
      narrowed === 'RESEARCH_RESPONSE_INVALID_JSON' ||
      narrowed === 'RESEARCH_RESPONSE_SCHEMA_INVALID' ||
      narrowed === 'RESEARCH_API_ERROR'
    ) {
      return { code: narrowed, details };
    }
    return { code: 'ALIGNMENT_EVALUATION_FAILED', details };
  }

  // sheet
  const narrowed = narrowingFromMessage(d);
  if (narrowed === 'PROFILE_ROW_MISSING_AFTER_WRITE') return { code: narrowed, details };
  return { code: 'SHEETS_WRITE_FAILED', details };
}
