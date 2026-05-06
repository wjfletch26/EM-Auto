/**
 * `companyNeedsRefreshSpend` — **refresh spend gate only** (Perplexity + alignment on stale profiles).
 *
 * Do **not** import this module from [`pipeline-orchestrator.ts`](./pipeline-orchestrator.ts).
 * Staleness is decided **before** calling this predicate; if this returns false, skip API spend for that profile.
 */

import type { Campaign, Contact, ReviewQueueEntry } from '../services/sheets-types.js';
import { evaluateContact } from './sequence-engine.js';
import {
  contactCanonicalKey,
  sequenceComplete,
} from './sequence-funnel-state.js';

export interface CompanyRefreshSpendSnapshot {
  contacts: readonly Contact[];
  reviewQueue: readonly ReviewQueueEntry[];
  campaignById: ReadonlyMap<string, Campaign>;
  now: Date;
}

const GEN_PIPELINES = new Set(['alignment_complete', 'ready_for_generation', 'regenerate_future_sequence']);

function contactNeedsGenerationPipeline(c: Contact): boolean {
  return GEN_PIPELINES.has(c.pipelineStatus?.trim().toLowerCase() ?? '');
}

/** Any approved step still waiting to sync onto Campaigns (even if earlier steps block the watcher planner). */
function hasApprovedUnsyncedReviewRow(targetEmail: string, reviewQueue: readonly ReviewQueueEntry[]): boolean {
  const key = targetEmail.trim().toLowerCase();
  return reviewQueue.some(
    (e) =>
      e.contactEmail === key &&
      e.status === 'approved' &&
      !e.campaignId?.trim(),
  );
}

/**
 * Returns true if spending on a **stale** company profile refresh is justified this cycle.
 * Call only after the row is already known stale by age; do not OR in staleness here.
 */
export function companyNeedsRefreshSpend(
  canonical: string,
  { contacts, reviewQueue, campaignById, now }: CompanyRefreshSpendSnapshot,
): boolean {
  const canon = canonical.trim().toLowerCase();
  if (!canon) return false;

  const atCompany = contacts.filter((c) => contactCanonicalKey(c) === canon);

  for (const c of atCompany) {
    if (c.pipelineStatus?.trim().toLowerCase() === 'new') return true;
    if (contactNeedsGenerationPipeline(c)) return true;
    if (hasApprovedUnsyncedReviewRow(c.email, reviewQueue)) return true;

    const cid = c.campaignId?.trim();
    const campaign = cid ? campaignById.get(cid) : undefined;
    const ev = evaluateContact(c, campaign, now);
    if (ev.eligible) return true;
  }

  const everyComplete =
    atCompany.length > 0 &&
    atCompany.every((c) => {
      const cid = c.campaignId?.trim();
      const campaign = cid ? campaignById.get(cid) : undefined;
      return sequenceComplete(c, campaign);
    });

  if (everyComplete) return false;

  // Mixed / in-progress funnel: not everyone is sequence-complete.
  return atCompany.length > 0;
}
