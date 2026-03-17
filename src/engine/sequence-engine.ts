/**
 * Sequence Engine — pure logic module that determines contact eligibility.
 *
 * No I/O, no side effects. The Send Engine calls evaluateContact()
 * with data from Sheets and gets back a decision.
 *
 * Reference: specs/SEQUENCE_ENGINE.md
 */

import { logger } from '../logging/logger.js';
import type { Contact, Campaign, CampaignStep } from '../services/sheets-types.js';

// Monthly cadence requirement: after step 1, wait at least 30 days.
const MIN_MONTHLY_DELAY_DAYS = 30;

// ─── Types ───────────────────────────────────────────────────────────────────

/** The result of evaluating a single contact for eligibility. */
export interface EligibilityResult {
  eligible: boolean;
  /** Human-readable explanation for logging/debugging. */
  reason: string;
  /** The step to send next (only present when eligible === true). */
  nextStep?: CampaignStep;
}

// ─── Main evaluation function ────────────────────────────────────────────────

/**
 * Determines whether a contact should receive their next email.
 * Checks halt conditions, campaign validity, sequence position, and timing.
 *
 * @param contact  - The contact row from Sheets
 * @param campaign - The campaign this contact belongs to (or undefined if not found)
 * @param now      - Current time (injected for testability)
 */
export function evaluateContact(
  contact: Contact,
  campaign: Campaign | undefined,
  now: Date,
): EligibilityResult {

  // ── Halt conditions (checked first, in priority order) ──

  if (contact.unsubscribed) {
    return { eligible: false, reason: 'Contact is unsubscribed' };
  }

  if (contact.bounced) {
    return { eligible: false, reason: 'Contact has bounced' };
  }

  if (contact.status === 'do_not_contact') {
    return { eligible: false, reason: 'Contact is marked do_not_contact' };
  }

  if (contact.status === 'paused') {
    return { eligible: false, reason: 'Contact is paused' };
  }

  // Any reply halts the sequence — the human operator decides next steps
  if (contact.replyStatus !== null && contact.replyStatus !== '') {
    return { eligible: false, reason: `Contact has replied (${contact.replyStatus})` };
  }

  if (contact.status === 'bounced' || contact.status === 'unsubscribed') {
    return { eligible: false, reason: `Contact status is ${contact.status}` };
  }

  // ── Campaign checks ──

  if (!campaign) {
    logger.warn(
      { module: 'sequence-engine', email: contact.email, campaignId: contact.campaignId },
      'Campaign not found for contact',
    );
    return { eligible: false, reason: `Campaign ${contact.campaignId} not found` };
  }

  if (!campaign.active) {
    return { eligible: false, reason: `Campaign ${campaign.campaignId} is inactive` };
  }

  // ── Sequence position ──

  const nextStepNumber = (contact.lastStepSent || 0) + 1;

  if (nextStepNumber > campaign.totalSteps) {
    return { eligible: false, reason: 'Sequence complete' };
  }

  const step = campaign.steps.find((s) => s.stepNumber === nextStepNumber);
  if (!step) {
    return { eligible: false, reason: `Step ${nextStepNumber} not defined in campaign` };
  }

  // ── Timing check ──

  // Treat negative or NaN delayDays as 0 (send immediately) with a warning
  let delayDays = step.delayDays;
  if (isNaN(delayDays) || delayDays < 0) {
    logger.warn(
      { module: 'sequence-engine', email: contact.email, delayDays: step.delayDays },
      'Invalid delayDays — treating as 0',
    );
    delayDays = 0;
  }

  // First step with no delay — send immediately
  if (nextStepNumber === 1 && delayDays === 0) {
    return { eligible: true, reason: 'First step, no delay', nextStep: step };
  }

  // Never been sent to and this is step 1 — send immediately
  if (contact.lastSendDate === null && nextStepNumber === 1) {
    return { eligible: true, reason: 'New contact, first step', nextStep: step };
  }

  // Need a lastSendDate to calculate timing for step 2+
  if (contact.lastSendDate === null) {
    return { eligible: false, reason: 'No last send date recorded — cannot calculate delay' };
  }

  // Enforce a minimum monthly cadence for follow-up steps.
  if (nextStepNumber > 1 && delayDays < MIN_MONTHLY_DELAY_DAYS) {
    delayDays = MIN_MONTHLY_DELAY_DAYS;
  }

  // Calculate when this contact becomes eligible
  const lastSend = new Date(contact.lastSendDate);
  const eligibleDate = new Date(lastSend.getTime() + delayDays * 24 * 60 * 60 * 1000);

  if (now < eligibleDate) {
    const daysRemaining = Math.ceil((eligibleDate.getTime() - now.getTime()) / 86_400_000);
    return { eligible: false, reason: `Delay not elapsed (${daysRemaining} days remaining)` };
  }

  // All checks passed
  return { eligible: true, reason: `Eligible for step ${nextStepNumber}`, nextStep: step };
}
