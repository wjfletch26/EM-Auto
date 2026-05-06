/**
 * Approval Watcher — single-step incremental sync from Review Queue → Campaigns tab.
 *
 * Each `runApprovalWatcherCycle()` pass promotes at most **one** step per contact email:
 * step 1 appends a new Campaigns row with only the first triplet; steps 2–12 patch that row.
 * Send timing still comes from the sequence engine (`lastSendDate`, `delayDays`, monthly floor).
 */

import { google, type sheets_v4 } from 'googleapis';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import * as sheets from '../services/sheets.js';
import type { Campaign, Contact, ContactUpdate, ReviewQueueEntry } from '../services/sheets-types.js';

const REQUIRED_APPROVED_STEPS = 12;
/** AI campaign row: 12 steps × 3 columns between total_steps (C) and active (AN). */
const CAMPAIGN_STEP_TRIPLETS = REQUIRED_APPROVED_STEPS * 3;

let approvalWatcherRunning = false;
let cachedSheetsAppendClient: sheets_v4.Sheets | null = null;

async function getSheetsClientForAppend(): Promise<sheets_v4.Sheets> {
  if (cachedSheetsAppendClient) return cachedSheetsAppendClient;
  const auth = new google.auth.GoogleAuth({
    keyFile: config.google.serviceAccountPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  cachedSheetsAppendClient = google.sheets({ version: 'v4', auth });
  return cachedSheetsAppendClient;
}

function getSpreadsheetId(): string {
  return config.google.spreadsheetId;
}

/**
 * Parses the row number from an append `updatedRange` like `Campaigns!A42:AO42`.
 */
function parseRowFromAppendUpdatedRange(updatedRange: string | undefined | null): number | null {
  if (!updatedRange) return null;
  const m = updatedRange.match(/[!](?:[A-Za-z]+)(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function aiCampaignDelayDays(stepNumber: number): string {
  return stepNumber === 1 ? '0' : '30';
}

/**
 * Runs one approval pass: for each contact at most **one** append or one triplet patch.
 */
export async function runApprovalWatcherCycle(): Promise<void> {
  if (approvalWatcherRunning) {
    logger.debug({ module: 'approval-watcher' }, 'Approval watcher cycle skipped: previous run in progress');
    return;
  }

  approvalWatcherRunning = true;

  try {
    const [reviewQueue, contacts, campaignRows] = await Promise.all([
      sheets.getReviewQueue(),
      sheets.getContacts(),
      sheets.getCampaigns(),
    ]);

    const campaignById = new Map<string, Campaign>();
    for (const c of campaignRows) {
      const id = c.campaignId?.trim();
      if (id && !campaignById.has(id)) campaignById.set(id, c);
    }

    const byEmail = new Map<string, ReviewQueueEntry[]>();
    for (const entry of reviewQueue) {
      if (!entry.contactEmail) continue;
      if (entry.status === 'superseded') continue;
      const key = entry.contactEmail.trim().toLowerCase();
      const list = byEmail.get(key) || [];
      list.push(entry);
      byEmail.set(key, list);
    }

    for (const [emailKey, entries] of byEmail) {
      const contact = contacts.find((c) => c.email === emailKey);
      const cid = contact?.campaignId?.trim();
      const campaign = cid !== undefined && cid !== '' ? campaignById.get(cid) : undefined;

      const plan = planIncrementalCampaignSync(contact, entries, campaign);

      if (plan.kind === 'noop') {
        if (plan.reason !== 'nothing_to_do') {
          logger.debug({ module: 'approval-watcher', email: emailKey, reason: plan.reason }, 'Skipping incremental sync');
        }
        continue;
      }

      if (plan.kind === 'append_step1') {
        const slug = contact!.company.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
        const campaignId = `ai_${slug}_${Date.now()}`;
        const e = plan.entry;

        const stepCells: string[] = new Array(CAMPAIGN_STEP_TRIPLETS).fill('');
        stepCells[0] = `ai_review_queue:${e._rowIndex}`;
        stepCells[1] = e.subject.trim();
        stepCells[2] = aiCampaignDelayDays(1);

        const campaignRow = [campaignId, `AI: ${contact!.company}`, '12', ...stepCells, 'TRUE', 'ai_generated'];

        const sheetsClient = await getSheetsClientForAppend();
        const appendRes = await sheetsClient.spreadsheets.values.append({
          spreadsheetId: getSpreadsheetId(),
          range: 'Campaigns!A:AO',
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [campaignRow] },
        });

        const newRow =
          parseRowFromAppendUpdatedRange(appendRes.data.updates?.updatedRange) ??
          (await resolveCampaignRowIndexAfterAppend(campaignId, campaignById));

        if (!newRow) {
          logger.error(
            { module: 'approval-watcher', email: emailKey, campaignId },
            'Could not resolve new campaign row index after append',
          );
          continue;
        }

        campaignById.set(campaignId, {
          campaignId,
          campaignName: `AI: ${contact!.company}`,
          totalSteps: 12,
          steps: [
            {
              stepNumber: 1,
              templateFile: stepCells[0],
              subject: stepCells[1],
              delayDays: parseInt(stepCells[2], 10) || 0,
            },
          ],
          active: true,
          campaignType: 'ai_generated',
          _rowIndex: newRow,
        });

        await sheets.updateReviewQueueEntry(e._rowIndex, {
          campaignId,
          approvedDate: new Date().toISOString(),
        });
        await sheets.updateContact(contact!.email, contact!._rowIndex, buildApprovalContactUpdate());
        await sheets.updateContactProfile(contact!.email, contact!._rowIndex, { campaignId });

        logger.info(
          { module: 'approval-watcher', email: emailKey, campaignId, step: 1, rowIndex: newRow },
          'Incremental campaign: appended row with step 1 only',
        );
        continue;
      }

      if (plan.kind === 'patch_step') {
        const { campaign: cmp, step: stepNum, entry } = plan;

        await sheets.updateCampaignStepTriplets(cmp._rowIndex!, stepNum, [
          `ai_review_queue:${entry._rowIndex}`,
          entry.subject.trim(),
          aiCampaignDelayDays(stepNum),
        ]);

        await sheets.updateReviewQueueEntry(entry._rowIndex, {
          campaignId: cmp.campaignId.trim(),
          approvedDate: new Date().toISOString(),
        });

        if (contact && contact.pipelineStatus?.trim() !== 'approved') {
          await sheets.updateContact(contact.email, contact._rowIndex, buildApprovalContactUpdate());
        }

        logger.info(
          {
            module: 'approval-watcher',
            email: emailKey,
            campaignId: cmp.campaignId,
            step: stepNum,
            rowIndex: cmp._rowIndex,
          },
          'Incremental campaign: patched step triplet',
        );
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'approval-watcher', error: msg }, 'Approval watcher cycle failed');
  } finally {
    approvalWatcherRunning = false;
  }
}

async function resolveCampaignRowIndexAfterAppend(
  campaignId: string,
  cache: Map<string, Campaign>,
): Promise<number | null> {
  const fresh = await sheets.getCampaigns();
  for (const c of fresh) {
    cache.set(c.campaignId, c);
  }
  const found = fresh.find((c) => c.campaignId === campaignId);
  return found?._rowIndex ?? null;
}

// ─── Pure planning helpers (exported for tests) ───────────────────────────────

export type IncrementalCampaignSyncPlan =
  | { kind: 'noop'; reason: string }
  | { kind: 'append_step1'; contact: Contact; entry: ReviewQueueEntry }
  | { kind: 'patch_step'; contact: Contact; campaign: Campaign; step: number; entry: ReviewQueueEntry };

export interface ApprovedStepsCollectionResult {
  ok: boolean;
  reason?: string;
  stepMap: Map<number, ReviewQueueEntry>;
}

/**
 * Collects approved rows into a step map — duplicates / invalid steps fail; does not require all 12.
 */
export function collectApprovedStepsByStep(approved: ReviewQueueEntry[]): ApprovedStepsCollectionResult {
  const stepMap = new Map<number, ReviewQueueEntry>();
  const duplicateSteps = new Set<number>();

  for (const entry of approved) {
    const step = entry.stepNumber;
    if (!Number.isInteger(step) || step < 1 || step > REQUIRED_APPROVED_STEPS) {
      return { ok: false, reason: `Invalid step number ${String(step)}`, stepMap };
    }
    if (stepMap.has(step)) {
      duplicateSteps.add(step);
      continue;
    }
    stepMap.set(step, entry);
  }

  if (duplicateSteps.size > 0) {
    return {
      ok: false,
      reason: `Duplicate approved steps: ${Array.from(duplicateSteps).sort((a, b) => a - b).join(', ')}`,
      stepMap,
    };
  }

  return { ok: true, stepMap };
}

/**
 * True when steps 1..upToInclusive exist in the map with non-empty subject and body.
 */
export function validateContiguousApprovedPrefix(
  stepMap: Map<number, ReviewQueueEntry>,
  upToInclusive: number,
): { ok: boolean; reason?: string } {
  for (let step = 1; step <= upToInclusive; step++) {
    const entry = stepMap.get(step);
    if (!entry) {
      return { ok: false, reason: `Missing approved step ${step}` };
    }
    if (!entry.subject?.trim()) {
      return { ok: false, reason: `Blank subject for step ${step}` };
    }
    if (!entry.body?.trim()) {
      return { ok: false, reason: `Blank body for step ${step}` };
    }
  }
  return { ok: true };
}

/** Highest step number present on the campaign row (with a template triplet). */
export function maxSyncedStepFromCampaign(campaign: Campaign | undefined): number {
  if (!campaign?.steps?.length) return 0;
  return Math.max(...campaign.steps.map((s) => s.stepNumber));
}

/**
 * Decides the single next sync action for one contact (at most one step per call).
 */
export function planIncrementalCampaignSync(
  contact: Contact | undefined,
  entries: ReviewQueueEntry[],
  campaign: Campaign | undefined,
): IncrementalCampaignSyncPlan {
  if (!contact) {
    return { kind: 'noop', reason: 'contact_not_found' };
  }

  const approved = entries.filter((e) => e.status === 'approved');
  const collected = collectApprovedStepsByStep(approved);
  if (!collected.ok) {
    return { kind: 'noop', reason: collected.reason || 'invalid_approved_rows' };
  }

  const { stepMap } = collected;
  const maxSynced = maxSyncedStepFromCampaign(campaign);
  const nextStep = maxSynced + 1;

  if (nextStep > REQUIRED_APPROVED_STEPS) {
    return { kind: 'noop', reason: 'nothing_to_do' };
  }

  const prefix = validateContiguousApprovedPrefix(stepMap, nextStep);
  if (!prefix.ok) {
    return { kind: 'noop', reason: prefix.reason || 'prefix_not_ready' };
  }

  const entry = stepMap.get(nextStep)!;
  const cid = contact.campaignId?.trim() ?? '';

  if (cid && entry.campaignId?.trim() === cid) {
    return { kind: 'noop', reason: 'step_already_synced' };
  }

  if (!cid) {
    if (nextStep !== 1) {
      return { kind: 'noop', reason: 'awaiting_step1_before_campaign' };
    }
    if (entry.campaignId?.trim()) {
      return { kind: 'noop', reason: 'review_queue_step1_has_orphan_campaign_id' };
    }
    return { kind: 'append_step1', contact, entry };
  }

  if (!campaign || campaign.campaignId.trim() !== cid) {
    return { kind: 'noop', reason: 'campaign_not_found_for_contact' };
  }

  if (campaign._rowIndex === undefined) {
    return { kind: 'noop', reason: 'campaign_row_index_missing' };
  }

  return { kind: 'patch_step', contact, campaign, step: nextStep, entry };
}

export interface ApprovedValidationResult {
  ok: boolean;
  reason?: string;
  stepMap: Map<number, ReviewQueueEntry>;
}

/**
 * Contact fields that should change when approvals become send-ready.
 * We intentionally do not reset status/step progress here.
 */
export function buildApprovalContactUpdate(): Partial<ContactUpdate> {
  return { pipelineStatus: 'approved' };
}

/**
 * Legacy validation: all 12 steps approved with content (used by tests / external docs).
 */
export function validateApprovedSteps(approved: ReviewQueueEntry[]): ApprovedValidationResult {
  const collected = collectApprovedStepsByStep(approved);
  if (!collected.ok) {
    return { ok: false, reason: collected.reason, stepMap: collected.stepMap };
  }

  const prefix = validateContiguousApprovedPrefix(collected.stepMap, REQUIRED_APPROVED_STEPS);
  if (!prefix.ok) {
    return { ok: false, reason: prefix.reason, stepMap: collected.stepMap };
  }

  if (approved.length !== REQUIRED_APPROVED_STEPS) {
    return {
      ok: false,
      reason: 'Approved row count does not equal 12',
      stepMap: collected.stepMap,
    };
  }

  return { ok: true, stepMap: collected.stepMap };
}
