/**
 * Unit tests for the Sequence Engine.
 *
 * The sequence engine is pure logic — no I/O, no mocks needed.
 * Tests cover halt conditions, cadence, and sequence boundaries.
 *
 * Run with: npx tsx --test src/engine/sequence-engine.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateContact } from './sequence-engine.js';
import type { Contact, Campaign } from '../services/sheets-types.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Builds a default contact with sensible defaults. Override fields as needed. */
function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    company: 'Acme',
    title: 'Engineer',
    campaignId: 'q1_outreach',
    status: 'new',
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
    _rowIndex: 2,
    ...overrides,
  };
}

/** Builds a default campaign with 3 steps. Override fields as needed. */
function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    campaignId: 'q1_outreach',
    campaignName: 'Q1 Outreach',
    totalSteps: 3,
    steps: [
      { stepNumber: 1, templateFile: 'q1_step1.hbs', subject: 'Hi {{first_name}}', delayDays: 0 },
      { stepNumber: 2, templateFile: 'q1_step2.hbs', subject: 'Following up', delayDays: 3 },
      { stepNumber: 3, templateFile: 'q1_step3.hbs', subject: 'Last check-in', delayDays: 5 },
    ],
    active: true,
    ...overrides,
  };
}

/** Returns a Date that is `days` days ago from now. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Sequence Engine — evaluateContact()', () => {
  const now = new Date();

  // Test 1: New contact, step 1, delay 0 → eligible
  it('should mark a new contact as eligible for step 1 with no delay', () => {
    const contact = makeContact();
    const campaign = makeCampaign();
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, true);
    assert.equal(result.nextStep?.stepNumber, 1);
    assert.match(result.reason, /first step/i);
  });

  // Test 2: Contact sent step 1 today, step 2 delay 3 days → not eligible
  it('should reject when delay has not elapsed', () => {
    const contact = makeContact({
      lastStepSent: 1,
      lastSendDate: new Date().toISOString(),
      status: 'active',
    });
    const campaign = makeCampaign();
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, false);
    assert.match(result.reason, /delay not elapsed/i);
  });

  // Test 3: Monthly cadence: 4 days is still too early for follow-up
  it('should reject follow-up sends before monthly cadence elapses', () => {
    const contact = makeContact({
      lastStepSent: 1,
      lastSendDate: daysAgo(4).toISOString(),
      status: 'active',
    });
    const campaign = makeCampaign();
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, false);
    assert.match(result.reason, /delay not elapsed/i);
  });

  // Test 4: Contact unsubscribed → not eligible
  it('should reject unsubscribed contacts', () => {
    const contact = makeContact({ unsubscribed: true });
    const campaign = makeCampaign();
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, false);
    assert.match(result.reason, /unsubscribed/i);
  });

  // Test 5: Contact bounced → not eligible
  it('should reject bounced contacts', () => {
    const contact = makeContact({ bounced: true });
    const campaign = makeCampaign();
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, false);
    assert.match(result.reason, /bounced/i);
  });

  // Test 6: Contact replied (any classification) → not eligible
  it('should reject contacts who have replied', () => {
    const contact = makeContact({ replyStatus: 'QUALIFIED' });
    const campaign = makeCampaign();
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, false);
    assert.match(result.reason, /replied/i);
  });

  // Test 7: Contact completed all steps → not eligible
  it('should reject contacts who completed the full sequence', () => {
    const contact = makeContact({
      lastStepSent: 3,
      lastSendDate: daysAgo(1).toISOString(),
      status: 'active',
    });
    const campaign = makeCampaign();
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, false);
    assert.match(result.reason, /sequence complete/i);
  });

  // Test 8: Campaign inactive → not eligible
  it('should reject contacts in an inactive campaign', () => {
    const contact = makeContact();
    const campaign = makeCampaign({ active: false });
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, false);
    assert.match(result.reason, /inactive/i);
  });

  // Test 9: Missing campaign → not eligible
  it('should reject contacts with a missing campaign', () => {
    const contact = makeContact({ campaignId: 'nonexistent' });
    const result = evaluateContact(contact, undefined, now);

    assert.equal(result.eligible, false);
    assert.match(result.reason, /not found/i);
  });

  // Test 10: Paused contact → not eligible
  it('should reject paused contacts', () => {
    const contact = makeContact({ status: 'paused' });
    const campaign = makeCampaign();
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, false);
    assert.match(result.reason, /paused/i);
  });

  // Test 11: Monthly cadence met (31 days) → eligible for follow-up
  it('should approve follow-up sends after monthly cadence elapses', () => {
    const contact = makeContact({
      lastStepSent: 1,
      lastSendDate: daysAgo(31).toISOString(),
      status: 'active',
    });
    const campaign = makeCampaign();
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, true);
    assert.equal(result.nextStep?.stepNumber, 2);
  });

  // Test 12: Campaign-defined total steps respected for 5-step campaigns
  it('should stop at totalSteps for a 5-step campaign', () => {
    const contact = makeContact({
      lastStepSent: 5,
      lastSendDate: daysAgo(31).toISOString(),
      status: 'active',
    });
    const campaign = makeCampaign({
      totalSteps: 5,
      steps: [
        { stepNumber: 1, templateFile: 's1.hbs', subject: 's1', delayDays: 0 },
        { stepNumber: 2, templateFile: 's2.hbs', subject: 's2', delayDays: 30 },
        { stepNumber: 3, templateFile: 's3.hbs', subject: 's3', delayDays: 30 },
        { stepNumber: 4, templateFile: 's4.hbs', subject: 's4', delayDays: 30 },
        { stepNumber: 5, templateFile: 's5.hbs', subject: 's5', delayDays: 30 },
      ],
    });
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, false);
    assert.match(result.reason, /sequence complete/i);
  });

  // Test 13: Campaign-defined total steps respected for 6-step campaigns
  it('should allow step 6 when campaign totalSteps is 6', () => {
    const contact = makeContact({
      lastStepSent: 5,
      lastSendDate: daysAgo(31).toISOString(),
      status: 'active',
    });
    const campaign = makeCampaign({
      totalSteps: 6,
      steps: [
        { stepNumber: 1, templateFile: 's1.hbs', subject: 's1', delayDays: 0 },
        { stepNumber: 2, templateFile: 's2.hbs', subject: 's2', delayDays: 30 },
        { stepNumber: 3, templateFile: 's3.hbs', subject: 's3', delayDays: 30 },
        { stepNumber: 4, templateFile: 's4.hbs', subject: 's4', delayDays: 30 },
        { stepNumber: 5, templateFile: 's5.hbs', subject: 's5', delayDays: 30 },
        { stepNumber: 6, templateFile: 's6.hbs', subject: 's6', delayDays: 30 },
      ],
    });
    const result = evaluateContact(contact, campaign, now);

    assert.equal(result.eligible, true);
    assert.equal(result.nextStep?.stepNumber, 6);
  });
});
