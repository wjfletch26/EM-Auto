/**
 * Rolling 3-email generation batches (steps 1–3, then 4–6 after send progress, etc.).
 *
 * Send thresholds match product spec: after steps 1–2 sent, generate 4–6; after 5 sent, 7–9; after 8 sent, 10–12.
 */

import type { ReviewQueueEntry } from '../services/sheets-types.js';

/** Four batches of three steps each (full 12-step arc). */
export const STAGED_BATCHES: readonly (readonly number[])[] = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
  [10, 11, 12],
] as const;

const RELEASE_THRESHOLDS_BY_BATCH_INDEX: readonly number[] = [0, 2, 5, 8];

/** Minimum `lastStepSent` before batch N (index 1..3) may be generated after sends. Batch 0 is initial only. */
export function lastSentThresholdForBatchIndex(batchIndex: number): number {
  if (batchIndex < 0 || batchIndex >= RELEASE_THRESHOLDS_BY_BATCH_INDEX.length) {
    return Number.POSITIVE_INFINITY;
  }
  return RELEASE_THRESHOLDS_BY_BATCH_INDEX[batchIndex];
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Batch index (0–3) containing this step, or -1 if out of range. */
export function batchIndexForStep(step: number): number {
  const idx = STAGED_BATCHES.findIndex((b) => b.includes(step));
  return idx;
}

/**
 * True when every step in the batch has at least one non-superseded draft row without `campaign_id`
 * (same notion of “unload queue draft” as duplicate-sequence guards).
 */
export function stagedBatchFullyPresentInReviewQueue(
  contactEmail: string,
  batch: readonly number[],
  reviewQueue: readonly ReviewQueueEntry[],
): boolean {
  const target = normalizedEmail(contactEmail);
  for (const step of batch) {
    const has = reviewQueue.some(
      (r) =>
        r.contactEmail === target &&
        r.stepNumber === step &&
        !r.campaignId?.trim() &&
        r.status !== 'superseded',
    );
    if (!has) return false;
  }
  return true;
}

/**
 * Next send-driven batch to generate: earliest incomplete batch whose send threshold is satisfied.
 * Returns null when nothing is due (e.g. thresholds not met, or all released batches are present).
 */
export function nextBatchToGenerateFromSends(
  lastStepJustSent: number,
  contactEmail: string,
  reviewQueue: readonly ReviewQueueEntry[],
): number[] | null {
  const sent =
    typeof lastStepJustSent === 'number' && Number.isFinite(lastStepJustSent)
      ? lastStepJustSent
      : parseInt(String(lastStepJustSent), 10) || 0;

  // Batches after the opening wave (index 1..3).
  for (let b = 1; b < STAGED_BATCHES.length; b++) {
    const batch = [...STAGED_BATCHES[b]];
    const needThreshold = lastSentThresholdForBatchIndex(b);
    if (sent < needThreshold) continue;

    if (stagedBatchFullyPresentInReviewQueue(contactEmail, batch, reviewQueue)) continue;

    return batch;
  }
  return null;
}

/** Opening wave (steps 1–3) already drafted — duplicate initial generation guard. */
export function hasInitialStagedBatchInReviewQueue(
  contactEmail: string,
  reviewQueue: readonly ReviewQueueEntry[],
): boolean {
  return stagedBatchFullyPresentInReviewQueue(contactEmail, STAGED_BATCHES[0], reviewQueue);
}

/**
 * Normalize `lastStepSent` from a Contact row (Sheets may coerce types).
 */
export function normalizeLastStepSent(raw: number | string | undefined | null): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Profile-refresh arming: true when an unsynced draft exists strictly after `maxSynced`, and that row is
 * in a “released” send batch (steps 4+ only — never treat opening wave as refresh tail).
 */
export function hasUnsyncedStagedProfileRefreshTail(
  contactEmail: string,
  maxSynced: number,
  lastStepSent: number,
  reviewQueue: readonly ReviewQueueEntry[],
): boolean {
  const target = normalizedEmail(contactEmail);
  const sent = normalizeLastStepSent(lastStepSent);

  return reviewQueue.some((r) => {
    if (r.contactEmail !== target) return false;
    if (r.campaignId?.trim()) return false;
    if (r.status === 'superseded') return false;
    if (r.stepNumber <= maxSynced) return false;
    if (r.stepNumber <= 3) return false;

    const b = batchIndexForStep(r.stepNumber);
    if (b <= 0) return false;
    const thr = lastSentThresholdForBatchIndex(b);
    return sent >= thr;
  });
}

/**
 * For future-tail regen when staged: single batch intersecting `[fromStep, 12]`, honoring approved skips.
 */
export function stepsToGenerateForStagedFutureTail(params: {
  fromStep: number;
}): number[] {
  const { fromStep } = params;
  if (fromStep < 1 || fromStep > 12) return [];

  const b = batchIndexForStep(fromStep);
  if (b < 0) return [];

  const batch = [...STAGED_BATCHES[b]];
  return batch.filter((s) => s >= fromStep);
}

/**
 * After regenerating a staged profile-refresh batch through `floorStep`, true when unsynced drafts
 * still exist for later steps (another refresh cycle may be needed before bumping `lastProfileVersionUsedForGeneration`).
 */
export function hasFurtherStagedRefreshDrafts(
  contactEmail: string,
  reviewQueue: readonly ReviewQueueEntry[],
  floorStep: number,
): boolean {
  const target = normalizedEmail(contactEmail);
  return reviewQueue.some(
    (e) =>
      e.contactEmail === target &&
      !e.campaignId?.trim() &&
      e.status !== 'superseded' &&
      e.stepNumber > floorStep &&
      e.stepNumber <= 12,
  );
}
