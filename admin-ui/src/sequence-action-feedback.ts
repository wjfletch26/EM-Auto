/**
 * Human-readable summaries for POST /api/admin/actions/* responses.
 * The backend returns structured JSON so operators see why a cycle appeared to "do nothing."
 */

type Json = Record<string, unknown>;

interface SendCyclePayload {
  runId: string;
  eligible: number;
  sent: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

interface PipelineCyclePayload {
  pipelineEnabled?: boolean;
  skippedBecauseIntelligenceJobBusy?: boolean;
  contactsProcessedPhaseA?: number;
  contactsProcessedPhaseB?: number;
  error?: string;
}

interface ApprovalWatcherPayload {
  skippedBecauseAlreadyRunning?: boolean;
  incrementalSyncActionsApplied?: number;
}

interface CompanyProfileRefreshPayload {
  skipReason?: 'pipeline_disabled' | 'company_refresh_disabled' | 'intelligence_job_busy';
  profilesRefreshed?: number;
}

function formatSendCyclePayload(r: SendCyclePayload): string {
  const hint =
    r.eligible === 0 && r.sent === 0
      ? ' No contacts matched send timing / queue rules this tick (check campaign steps, approvals, unsubscribe, etc.).'
      : '';
  return (
    `Send cycle (${r.runId}): eligible ${r.eligible}, sent ${r.sent}, failed ${r.failed}, ` +
    `batch-capped/skipped remainder ${r.skipped}, duration ${r.durationMs}ms.${hint}`
  );
}

function formatPipelineCyclePayload(p: PipelineCyclePayload): string {
  if (p.pipelineEnabled === false) {
    return 'Pipeline did not run: PIPELINE_ENABLED is false on the server.';
  }
  if (p.skippedBecauseIntelligenceJobBusy) {
    return (
      'Pipeline cycle skipped — another intelligence job holds the mutex. Wait a minute and retry, ' +
      'or check logs if it never clears.'
    );
  }

  const a = p.contactsProcessedPhaseA ?? 0;
  const b = p.contactsProcessedPhaseB ?? 0;
  let body =
    `Pipeline cycle examined ${a} contact(s) in Phase A (\`pipeline_status=new\`), ` +
    `${b} in Phase B (generation / future-tail).\n` +
    'If Phase A counts are nonzero but sheets look unchanged, the company profile may already exist — ' +
    'research is often reused with no apparent update.';

  if (p.error) {
    body += `\nWarning — cycle error (partial counts possible): ${p.error}`;
  }
  return body;
}

function formatApprovalWatcherPayload(v: ApprovalWatcherPayload): string {
  if (v.skippedBecauseAlreadyRunning) {
    return 'Approval watcher skipped — previous run still in progress.';
  }

  const n = v.incrementalSyncActionsApplied ?? 0;

  return n === 0
    ? 'Approval watcher ran: no Campaign incremental sync performed (no contiguous approved row ready next, missing contact campaign link, etc.). Check Review Queue — Approve statuses.'
    : `Approval watcher applied ${n} incremental campaign sync action(s) (step append or Campaign triplet patch).`;
}

function formatCompanyProfileRefreshPayload(c: CompanyProfileRefreshPayload): string {
  switch (c.skipReason) {
    case 'pipeline_disabled':
      return 'Company profile refresh skipped — PIPELINE_ENABLED is false.';
    case 'company_refresh_disabled':
      return 'Company profile refresh skipped — PIPELINE_COMPANY_REFRESH_ENABLED is false.';
    case 'intelligence_job_busy':
      return 'Company profile refresh skipped — intelligence mutex busy (another job running). Retry shortly.';
    default:
      break;
  }

  const n = c.profilesRefreshed ?? 0;
  if (n === 0) {
    return (
      'Company profile refresh pass finished: refreshed 0 profile(s).\n' +
      'Either no stale rows met criteria, or spends were skipped (see COMPANY_STALE_AFTER_DAYS / companyNeedsRefreshSpend in logs).'
    );
  }
  return `Company profile refresh: refreshed ${n} stale profile row(s).`;
}

/**
 * Formats POST action JSON from /api/admin for the green toast line.
 *
 * Backend uses separate keys (`result`, `pipelineCycle`, ...) so callers pass the decoded body.
 */
export function formatSequenceActionSuccess(path: string, data: Json): string {
  const parts: string[] = [];

  if (typeof data.supersededReviewRows === 'number') {
    parts.push(`Superseded ${data.supersededReviewRows} existing review-queue row(s) for regenerate.`);
  }

  const result = data.result as SendCyclePayload | undefined;

  /** Global send cycle only — avoid formatting contact PATCH bodies that might include unrelated `result`. */
  if (path.endsWith('/actions/send-cycle') && result && typeof result.runId === 'string') {
    parts.push(formatSendCyclePayload(result));
  }

  const pipelineCycle = data.pipelineCycle as PipelineCyclePayload | undefined;
  if (pipelineCycle !== undefined && typeof pipelineCycle === 'object') {
    parts.push(formatPipelineCyclePayload(pipelineCycle));
  }

  const approvalWatcher = data.approvalWatcher as ApprovalWatcherPayload | undefined;
  if (approvalWatcher !== undefined && typeof approvalWatcher === 'object') {
    parts.push(formatApprovalWatcherPayload(approvalWatcher));
  }

  const companyProfileRefresh = data.companyProfileRefresh as CompanyProfileRefreshPayload | undefined;
  if (companyProfileRefresh !== undefined && typeof companyProfileRefresh === 'object') {
    parts.push(formatCompanyProfileRefreshPayload(companyProfileRefresh));
  }

  if (parts.length > 0) {
    return parts.join('\n\n');
  }

  return 'OK — nothing specific to display (unexpected response shape). Check server logs if unsure.';
}
