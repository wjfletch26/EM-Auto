import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildApprovalContactUpdate,
  validateApprovedSteps,
} from './approval-watcher.js';
import type { ReviewQueueEntry } from '../services/sheets-types.js';

function makeApprovedEntry(stepNumber: number, overrides: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry {
  const merged = {
    contactEmail: 'test@example.com',
    companyName: 'Acme',
    stepNumber,
    emailPurpose: `Step ${stepNumber}`,
    subject: `Subject ${stepNumber}`,
    body: `Body ${stepNumber}`,
    status: 'approved',
    reviewerNotes: '',
    generatedDate: '2026-01-01T00:00:00.000Z',
    approvedDate: '2026-01-01T00:00:00.000Z',
    campaignId: '',
    daveNotes: '',
    manualReviewRequired: false,
    qcAutoStatus: 'ok',
    nextAction: '',
    regenMode: '',
    _rowIndex: stepNumber + 1,
    ...overrides,
  };

  return {
    ...merged,
    daveNotes: merged.daveNotes ?? '',
    manualReviewRequired: merged.manualReviewRequired ?? false,
    qcAutoStatus: (merged.qcAutoStatus ?? 'ok') as ReviewQueueEntry['qcAutoStatus'],
    nextAction: merged.nextAction ?? '',
    regenMode: (merged.regenMode ?? '') as ReviewQueueEntry['regenMode'],
  };
}

describe('approval watcher step validation', () => {
  it('rejects duplicate approved steps', () => {
    const approved = Array.from({ length: 12 }, (_v, i) => makeApprovedEntry(i + 1));
    approved.push(makeApprovedEntry(3, { _rowIndex: 999 }));

    const result = validateApprovedSteps(approved);
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /duplicate approved steps/i);
  });

  it('rejects missing step in 1..12', () => {
    const approved = Array.from({ length: 11 }, (_v, i) => makeApprovedEntry(i + 1));
    const result = validateApprovedSteps(approved);
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /missing approved step 12/i);
  });

  it('rejects blank subject/body entries', () => {
    const approved = Array.from({ length: 12 }, (_v, i) => makeApprovedEntry(i + 1));
    approved[5] = makeApprovedEntry(6, { subject: '   ' });
    const subjectResult = validateApprovedSteps(approved);
    assert.equal(subjectResult.ok, false);
    assert.match(subjectResult.reason || '', /blank subject/i);

    approved[5] = makeApprovedEntry(6, { subject: 'OK', body: '   ' });
    const bodyResult = validateApprovedSteps(approved);
    assert.equal(bodyResult.ok, false);
    assert.match(bodyResult.reason || '', /blank body/i);
  });
});

describe('approval watcher contact update payload', () => {
  it('does not reset sequence status or step progress', () => {
    const updates = buildApprovalContactUpdate();
    assert.deepEqual(updates, { pipelineStatus: 'approved' });
    assert.equal('status' in updates, false);
    assert.equal('lastStepSent' in updates, false);
    assert.equal('lastSendDate' in updates, false);
  });
});
