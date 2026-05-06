/**
 * Tests for sequence-funnel-state helpers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequenceComplete, parseProfileVersionInt } from './sequence-funnel-state.js';
import type { Campaign, Contact } from '../services/sheets-types.js';

function baseContact(overrides: Partial<Contact> = {}): Contact {
  return {
    email: 'a@x.com',
    firstName: 'A',
    lastName: '',
    company: 'X',
    title: '',
    campaignId: 'c1',
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
    companyUrl: 'https://x.com',
    pipelineStatus: '',
    lastProfileVersionUsedForGeneration: '',
    _rowIndex: 2,
    ...overrides,
  };
}

function campWithMaxStep(maxStep: number): Campaign {
  const steps = Array.from({ length: maxStep }, (_, i) => ({
    stepNumber: i + 1,
    templateFile: 't',
    subject: 's',
    delayDays: 0,
  }));
  return {
    campaignId: 'c1',
    campaignName: 'N',
    totalSteps: 12,
    steps,
    active: true,
    campaignType: 'ai_generated',
    _rowIndex: 2,
  };
}

describe('parseProfileVersionInt', () => {
  it('parses integers and maps garbage to 0', () => {
    assert.equal(parseProfileVersionInt('7'), 7);
    assert.equal(parseProfileVersionInt(''), 0);
    assert.equal(parseProfileVersionInt('abc'), 0);
  });
});

describe('sequenceComplete', () => {
  it('is true only when campaign has 12 synced steps and contact lastStepSent is 12', () => {
    const c = baseContact({ lastStepSent: 12, campaignId: 'c1' });
    assert.equal(sequenceComplete(c, campWithMaxStep(12)), true);
  });

  it('is false when lastStepSent is 12 but maxSynced is 11 (inconsistent sheets)', () => {
    const c = baseContact({ lastStepSent: 12 });
    assert.equal(sequenceComplete(c, campWithMaxStep(11)), false);
  });

  it('is false when campaign missing', () => {
    const c = baseContact({ lastStepSent: 12 });
    assert.equal(sequenceComplete(c, undefined), false);
  });
});
