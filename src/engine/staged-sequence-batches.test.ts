/**
 * Tests for staged sequence batch helpers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasFurtherStagedRefreshDrafts,
  hasInitialStagedBatchInReviewQueue,
  hasUnsyncedStagedProfileRefreshTail,
  lastSentThresholdForBatchIndex,
  nextBatchToGenerateFromSends,
  stepsToGenerateForStagedFutureTail,
} from './staged-sequence-batches.js';
import type { ReviewQueueEntry } from '../services/sheets-types.js';

function rqRow(step: number, overrides: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry {
  return {
    contactEmail: 'a@example.com',
    companyName: 'Acme',
    stepNumber: step,
    emailPurpose: '',
    subject: `S${step}`,
    body: `B${step}`,
    status: 'pending_review',
    reviewerNotes: '',
    generatedDate: '',
    approvedDate: '',
    campaignId: '',
    daveNotes: '',
    manualReviewRequired: false,
    qcAutoStatus: 'ok',
    nextAction: '',
    regenMode: '',
    _rowIndex: step,
    ...overrides,
  };
}

describe('lastSentThresholdForBatchIndex', () => {
  it('maps batch 1..3 to 2,5,8', () => {
    assert.equal(lastSentThresholdForBatchIndex(1), 2);
    assert.equal(lastSentThresholdForBatchIndex(2), 5);
    assert.equal(lastSentThresholdForBatchIndex(3), 8);
  });
});

describe('nextBatchToGenerateFromSends', () => {
  const email = 'a@example.com';

  it('returns null when no threshold met', () => {
    const q = [rqRow(1), rqRow(2), rqRow(3)];
    assert.equal(nextBatchToGenerateFromSends(1, email, q), null);
  });

  it('returns 4–6 when last sent is 2 and batch missing', () => {
    const q = [rqRow(1), rqRow(2), rqRow(3)];
    assert.deepEqual(nextBatchToGenerateFromSends(2, email, q), [4, 5, 6]);
  });

  it('is idempotent when 4–6 already present', () => {
    const q = [rqRow(1), rqRow(2), rqRow(3), rqRow(4), rqRow(5), rqRow(6)];
    assert.equal(nextBatchToGenerateFromSends(2, email, q), null);
  });

  it('fills earliest gap: last sent 8 still generates 4–6 if missing', () => {
    const q = [rqRow(1), rqRow(2), rqRow(3), rqRow(7)]; // 4–6 missing
    assert.deepEqual(nextBatchToGenerateFromSends(8, email, q), [4, 5, 6]);
  });

  it('returns 7–9 after 5 sent when that batch incomplete', () => {
    const q = [rqRow(1), rqRow(2), rqRow(3), rqRow(4), rqRow(5), rqRow(6)];
    assert.deepEqual(nextBatchToGenerateFromSends(5, email, q), [7, 8, 9]);
  });
});

describe('hasInitialStagedBatchInReviewQueue', () => {
  it('requires steps 1–3 as drafts', () => {
    const email = 'a@example.com';
    assert.equal(hasInitialStagedBatchInReviewQueue(email, [rqRow(1), rqRow(2)]), false);
    assert.equal(
      hasInitialStagedBatchInReviewQueue(email, [rqRow(1), rqRow(2), rqRow(3)]),
      true,
    );
  });
});

describe('hasUnsyncedStagedProfileRefreshTail', () => {
  const email = 'a@example.com';

  it('ignores steps 1–3 beyond maxSynced (opening wave not refresh tail)', () => {
    const q = [rqRow(3, { campaignId: '' })];
    assert.equal(hasUnsyncedStagedProfileRefreshTail(email, 2, 5, q), false);
  });

  it('is true for step 4+ when released and beyond maxSynced', () => {
    const q = [rqRow(4, { campaignId: '' })];
    assert.equal(hasUnsyncedStagedProfileRefreshTail(email, 2, 2, q), true);
  });
});

describe('stepsToGenerateForStagedFutureTail', () => {
  it('returns batch slice from fromStep', () => {
    assert.deepEqual(stepsToGenerateForStagedFutureTail({ fromStep: 5 }), [5, 6]);
    assert.deepEqual(stepsToGenerateForStagedFutureTail({ fromStep: 4 }), [4, 5, 6]);
  });
});

describe('hasFurtherStagedRefreshDrafts', () => {
  it('detects drafts strictly above floor', () => {
    const email = 'a@example.com';
    const q = [rqRow(7, { campaignId: '' })];
    assert.equal(hasFurtherStagedRefreshDrafts(email, q, 6), true);
    assert.equal(hasFurtherStagedRefreshDrafts(email, q, 7), false);
  });
});
