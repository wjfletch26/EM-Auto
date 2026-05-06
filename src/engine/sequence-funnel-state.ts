/**
 * Pure helpers for sequence / funnel state (synced steps, tail regen, profile versions).
 *
 * Kept separate from `company-actionable.ts` so [`pipeline-orchestrator.ts`](./pipeline-orchestrator.ts)
 * can import these **without** touching `companyNeedsRefreshSpend` (refresh gate only).
 */

import type { Campaign, Contact, ReviewQueueEntry } from '../services/sheets-types.js';
import { resolveCanonicalCompanyUrl } from '../utils/resolve-canonical-company-url.js';
import { maxSyncedStepFromCampaign } from './approval-watcher.js';

/** Integer profile version; empty or non-numeric → 0. */
export function parseProfileVersionInt(raw: string | undefined | null): number {
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Contact has finished the AI sequence operationally: campaign fully synced, last send is step 12.
 * All three conditions required — inconsistent sheets (e.g. lastStepSent 12 but maxSynced 11) → false.
 */
export function sequenceComplete(contact: Contact, campaign: Campaign | undefined): boolean {
  const cid = contact.campaignId?.trim();
  if (!cid) return false;
  if (!campaign || campaign.campaignId.trim() !== cid) return false;
  if (maxSyncedStepFromCampaign(campaign) !== 12) return false;
  const sent = contact.lastStepSent;
  const n = typeof sent === 'number' ? sent : parseInt(String(sent), 10);
  return n === 12;
}

/** Normalized canonical key for a contact row (lowercase trimmed URL). */
export function contactCanonicalKey(contact: Contact): string {
  return resolveCanonicalCompanyUrl(contact.companyUrl || '').trim().toLowerCase();
}

/** Contacts whose canonical company URL matches `canonical` (already normalized, lowercase). */
export function contactsAtCanonical(contacts: readonly Contact[], canonical: string): Contact[] {
  const key = canonical.trim().toLowerCase();
  if (!key) return [];
  return contacts.filter((c) => contactCanonicalKey(c) === key);
}

/**
 * True when there is at least one Review Queue draft row **after** `maxSynced`, still in the queue
 * (no `campaign_id`), not superseded — i.e. tail work exists for profile-refresh-driven regen.
 */
export function hasUnsyncedTailReviewRows(
  contactEmail: string,
  maxSynced: number,
  reviewQueue: readonly ReviewQueueEntry[],
): boolean {
  const target = contactEmail.trim().toLowerCase();
  return reviewQueue.some(
    (e) =>
      e.contactEmail === target &&
      e.stepNumber > maxSynced &&
      !e.campaignId?.trim() &&
      e.status !== 'superseded',
  );
}
