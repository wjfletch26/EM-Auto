import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildApprovalContactUpdate,
  collectApprovedStepsByStep,
  maxSyncedStepFromCampaign,
  planIncrementalCampaignSync,
  validateApprovedSteps,
  validateContiguousApprovedPrefix,
} from './approval-watcher.js';
import type { Campaign, Contact, ReviewQueueEntry } from '../services/sheets-types.js';

function baseContact(overrides: Partial<Contact> = {}): Contact {
  const c: Contact = {
    email: 'test@example.com',
    firstName: 'Ada',
    lastName: '',
    company: 'Acme',
    title: '',
    campaignId: '',
    status: 'active',
    lastStepSent: 0,
    lastSendDate: null,
    replyStatus: null,
    replyDate: null,
    replySnippet: '',
    unsubscribed: false,
    unsubscribeDate: null,
    unsubscribeSource: null,
    bounced: false,
    bounceType: null,
    bounceDate: null,
    softBounceCount: 0,
    custom1: '',
    custom2: '',
    notes: '',
    companyUrl: '',
    pipelineStatus: 'pending_review',
    lastProfileVersionUsedForGeneration: '',
    _rowIndex: 2,
    ...overrides,
  };
  return c;
}

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
    _rowIndex: stepNumber + 10,
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

function baseAiCampaign(steps: Campaign['steps'], overrides: Partial<Campaign> = {}): Campaign {
  return {
    campaignId: 'ai_acme',
    campaignName: 'AI: Acme',
    totalSteps: 12,
    steps,
    active: true,
    campaignType: 'ai_generated',
    _rowIndex: 99,
    ...overrides,
  };
}

describe('collectApprovedStepsByStep', () => {
  it('rejects duplicate approved steps', () => {
    const approved = Array.from({ length: 12 }, (_v, i) => makeApprovedEntry(i + 1));
    approved.push(makeApprovedEntry(3, { _rowIndex: 999 }));

    const result = collectApprovedStepsByStep(approved);
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /duplicate approved steps/i);
  });
});

describe('validateContiguousApprovedPrefix', () => {
  const mapOk = (): Map<number, ReviewQueueEntry> => {
    const m = new Map<number, ReviewQueueEntry>();
    m.set(1, makeApprovedEntry(1));
    m.set(2, makeApprovedEntry(2));
    return m;
  };

  it('passes when 1..N are present with subject and body', () => {
    const m = mapOk();
    const r = validateContiguousApprovedPrefix(m, 2);
    assert.equal(r.ok, true);
  });

  it('fails at step N when missing', () => {
    const m = new Map<number, ReviewQueueEntry>();
    m.set(1, makeApprovedEntry(1));
    m.set(3, makeApprovedEntry(3));
    const r = validateContiguousApprovedPrefix(m, 3);
    assert.equal(r.ok, false);
    assert.match(r.reason || '', /missing approved step 2/i);
  });

  it('fails when subject or body blank', () => {
    const m = new Map<number, ReviewQueueEntry>();
    m.set(1, makeApprovedEntry(1));
    m.set(2, makeApprovedEntry(2, { subject: '' }));
    const subjectCheck = validateContiguousApprovedPrefix(m, 2);
    assert.equal(subjectCheck.ok, false);

    const m2 = new Map<number, ReviewQueueEntry>();
    m2.set(1, makeApprovedEntry(1));
    m2.set(2, makeApprovedEntry(2, { subject: 'S', body: '  ' }));
    const bodyCheck = validateContiguousApprovedPrefix(m2, 2);
    assert.equal(bodyCheck.ok, false);
  });
});

describe('planIncrementalCampaignSync', () => {
  const entriesSteps = (...steps: ReviewQueueEntry[]) => [...steps];

  it('plans append when step 1 approved and contact has no campaign', () => {
    const contact = baseContact({ campaignId: '' });
    const plan = planIncrementalCampaignSync(contact, entriesSteps(makeApprovedEntry(1)), undefined);
    assert.equal(plan.kind, 'append_step1');
    if (plan.kind === 'append_step1') assert.equal(plan.entry.stepNumber, 1);
  });

  it('plans patch step 2 when campaign has step 1 and prefix 1-2 approved', () => {
    const contact = baseContact({ campaignId: 'ai_acme' });
    const cmp = baseAiCampaign([
      { stepNumber: 1, templateFile: 'ai_review_queue:11', subject: 'S1', delayDays: 0 },
    ]);
    const plan = planIncrementalCampaignSync(contact, entriesSteps(makeApprovedEntry(1), makeApprovedEntry(2)), cmp);
    assert.equal(plan.kind, 'patch_step');
    if (plan.kind === 'patch_step') {
      assert.equal(plan.step, 2);
      assert.equal(plan.campaign._rowIndex, 99);
    }
  });

  it('noop when step 3 approved but step 2 is not approved (contiguous gate)', () => {
    const contact = baseContact({ campaignId: 'ai_acme' });
    const cmp = baseAiCampaign([
      { stepNumber: 1, templateFile: 'ai_review_queue:11', subject: 'S1', delayDays: 0 },
    ]);
    const plan = planIncrementalCampaignSync(
      contact,
      entriesSteps(makeApprovedEntry(1), makeApprovedEntry(3, { campaignId: 'ai_acme' })),
      cmp,
    );
    assert.equal(plan.kind, 'noop');
    assert.match(plan.reason || '', /missing approved step 2/i);
  });

  it('single-step semantics: approved 2 and on campaign only step 1 — only step 2 (not hypothetical 3)', () => {
    const contact = baseContact({ campaignId: 'ai_acme' });
    const cmp = baseAiCampaign([
      { stepNumber: 1, templateFile: 'ai_review_queue:11', subject: 'S1', delayDays: 0 },
    ]);
    const e1 = makeApprovedEntry(1, { campaignId: 'ai_acme' });
    const e2 = makeApprovedEntry(2);
    const plan = planIncrementalCampaignSync(contact, entriesSteps(e1, e2), cmp);
    assert.equal(plan.kind, 'patch_step');
    if (plan.kind === 'patch_step') assert.equal(plan.step, 2);
  });

  /** Simulate second watcher cycle after step 3 was written to Campaigns — no further eligible step if only three drafts exist. */
  it('returns noop after max synced catches up with latest approved draft (waiting next approval)', () => {
    const contact = baseContact({ campaignId: 'ai_acme' });
    let cmp = baseAiCampaign([
      { stepNumber: 1, templateFile: 'ai_review_queue:11', subject: 'S1', delayDays: 0 },
      { stepNumber: 2, templateFile: 'ai_review_queue:12', subject: 'S2', delayDays: 30 },
      { stepNumber: 3, templateFile: 'ai_review_queue:13', subject: 'S3', delayDays: 30 },
    ]);
    let approvedRows = entriesSteps(
      makeApprovedEntry(1, { campaignId: 'ai_acme' }),
      makeApprovedEntry(2, { campaignId: 'ai_acme' }),
      makeApprovedEntry(3, { campaignId: 'ai_acme' }),
    );
    let plan = planIncrementalCampaignSync(contact, approvedRows, cmp);
    assert.equal(plan.kind, 'noop');
    assert.match(plan.kind === 'noop' ? plan.reason : '', /missing approved step 4/i);

    const twelveSteps = Array.from({ length: 12 }, (_, i) => ({
      stepNumber: i + 1,
      templateFile: `ai_review_queue:${20 + i}`,
      subject: `S${i + 1}`,
      delayDays: i === 0 ? 0 : 30,
    }));
    cmp = baseAiCampaign(twelveSteps);
    approvedRows = twelveSteps.map((_, i) => makeApprovedEntry(i + 1, { campaignId: 'ai_acme' }));
    plan = planIncrementalCampaignSync(contact, approvedRows, cmp);
    assert.equal(plan.kind, 'noop');
    assert.equal(plan.kind === 'noop' ? plan.reason : '', 'nothing_to_do');
  });

  it('noop step_already_synced when rq row already has matching campaign_id for next step', () => {
    const contact = baseContact({ campaignId: 'ai_acme' });
    const cmp = baseAiCampaign([
      { stepNumber: 1, templateFile: 'ai_review_queue:11', subject: 'S1', delayDays: 0 },
    ]);
    const plan = planIncrementalCampaignSync(
      contact,
      entriesSteps(makeApprovedEntry(1, { campaignId: 'ai_acme' }), makeApprovedEntry(2, { campaignId: 'ai_acme' })),
      cmp,
    );
    assert.equal(plan.kind, 'noop');
    assert.equal(plan.reason, 'step_already_synced');
  });
});

describe('maxSyncedStepFromCampaign', () => {
  it('returns 0 without steps', () => {
    assert.equal(maxSyncedStepFromCampaign(undefined), 0);
    assert.equal(maxSyncedStepFromCampaign(baseAiCampaign([])), 0);
  });

  it('returns max loaded step number', () => {
    assert.equal(maxSyncedStepFromCampaign(baseAiCampaign([{ stepNumber: 5, templateFile: 'x', subject: 's', delayDays: 30 }])), 5);
  });
});

describe('validateApprovedSteps (legacy all-12)', () => {
  it('rejects missing step in 1..12', () => {
    const approved = Array.from({ length: 11 }, (_v, i) => makeApprovedEntry(i + 1));
    const result = validateApprovedSteps(approved);
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /missing approved step 12/i);
  });

  it('accepts twelve unique approved rows', () => {
    const approved = Array.from({ length: 12 }, (_v, i) => makeApprovedEntry(i + 1));
    const result = validateApprovedSteps(approved);
    assert.equal(result.ok, true);
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
