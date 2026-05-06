/**
 * Tests for companyNeedsRefreshSpend (refresh gate only).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { companyNeedsRefreshSpend } from './company-actionable.js';
import type { Campaign, Contact, ReviewQueueEntry } from '../services/sheets-types.js';

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    email: 'a@acme.test',
    firstName: 'A',
    lastName: '',
    company: 'Acme',
    title: 'VP',
    campaignId: 'ai_acme',
    status: 'active',
    lastStepSent: 12,
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
    companyUrl: 'https://acme.test',
    pipelineStatus: 'approved',
    lastProfileVersionUsedForGeneration: '2',
    _rowIndex: 2,
    ...overrides,
  };
}

function campaignTwelveSynced(): Campaign {
  const steps = Array.from({ length: 12 }, (_, i) => ({
    stepNumber: i + 1,
    templateFile: `ai_review_queue:${100 + i}`,
    subject: `S${i + 1}`,
    delayDays: i === 0 ? 0 : 30,
  }));
  return {
    campaignId: 'ai_acme',
    campaignName: 'AI: Acme',
    totalSteps: 12,
    steps,
    active: true,
    campaignType: 'ai_generated',
    _rowIndex: 5,
  };
}

describe('companyNeedsRefreshSpend', () => {
  it('returns false when every contact is sequence-complete and no other signals', () => {
    const c = campaignTwelveSynced();
    const map = new Map([[c.campaignId, c]]);
    const spend = companyNeedsRefreshSpend('https://acme.test', {
      contacts: [contact()],
      reviewQueue: [],
      campaignById: map,
      now: new Date('2026-01-15T12:00:00Z'),
    });
    assert.equal(spend, false);
  });

  it('returns true when a contact is still pipeline new', () => {
    const c = campaignTwelveSynced();
    const map = new Map([[c.campaignId, c]]);
    const spend = companyNeedsRefreshSpend('https://acme.test', {
      contacts: [contact({ pipelineStatus: 'new', lastStepSent: 0 })],
      reviewQueue: [],
      campaignById: map,
      now: new Date(),
    });
    assert.equal(spend, true);
  });

  it('returns true when approved Review Queue row is unsynced even if planner could be blocked', () => {
    const c = campaignTwelveSynced();
    const map = new Map([[c.campaignId, c]]);
    const rq: ReviewQueueEntry[] = [
      {
        contactEmail: 'a@acme.test',
        companyName: 'Acme',
        stepNumber: 3,
        emailPurpose: 'p',
        subject: 'Sub',
        body: 'Body',
        status: 'approved',
        reviewerNotes: '',
        generatedDate: '',
        approvedDate: '',
        campaignId: '',
        daveNotes: '',
        manualReviewRequired: false,
        qcAutoStatus: 'ok',
        nextAction: '',
        regenMode: '',
        _rowIndex: 10,
      },
    ];
    const spend = companyNeedsRefreshSpend('https://acme.test', {
      contacts: [contact()],
      reviewQueue: rq,
      campaignById: map,
      now: new Date(),
    });
    assert.equal(spend, true);
  });
});
