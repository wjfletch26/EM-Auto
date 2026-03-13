/**
 * Bounce Handler — detects and records email bounces.
 *
 * Called from two places:
 * 1. Send Engine — when SMTP returns a rejection code at send time.
 * 2. Reply Processor — when an inbound message is classified as an NDR bounce.
 *
 * Hard bounces (550, 551, etc.) permanently disable the contact.
 * Soft bounces increment a counter; 3 soft bounces convert to a hard bounce.
 *
 * Reference: specs/BOUNCE_HANDLER.md
 */

import { logger } from '../logging/logger.js';
import * as sheets from '../services/sheets.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type BounceType = 'hard' | 'soft';

export interface BounceEvent {
  contactEmail: string;
  bounceType: BounceType;
  errorCode?: string;
  errorMessage?: string;
  /** Where the bounce was detected: smtp (at send time) or ndr (from a reply). */
  source: 'smtp' | 'ndr';
}

// ─── SMTP error classification ───────────────────────────────────────────────

/** Hard bounce codes — permanent failures, mailbox will never work. */
const HARD_BOUNCE_CODES = new Set([550, 551, 552, 553, 556]);

/** Soft bounce codes — temporary failures, may succeed later. */
const SOFT_BOUNCE_CODES = new Set([421, 450, 451, 452]);

/** Soft bounce threshold — after this many soft bounces, treat as hard. */
const SOFT_BOUNCE_THRESHOLD = 3;

/**
 * Classifies an SMTP error code as hard bounce, soft bounce, or neither.
 * Returns null if the code is not a recognized bounce code.
 */
export function classifySmtpError(code: number, _message: string): BounceType | null {
  if (HARD_BOUNCE_CODES.has(code)) return 'hard';
  if (SOFT_BOUNCE_CODES.has(code)) return 'soft';
  return null;
}

// ─── Record bounce ───────────────────────────────────────────────────────────

/**
 * Records a bounce event: updates the contact in Google Sheets.
 *
 * Hard bounces → contact permanently disabled (bounced=TRUE, status="bounced").
 * Soft bounces → counter incremented; converts to hard after 3.
 */
export async function recordBounce(event: BounceEvent): Promise<void> {
  logger.info(
    {
      module: 'bounce-handler',
      email: event.contactEmail,
      type: event.bounceType,
      code: event.errorCode,
      source: event.source,
    },
    'Bounce detected',
  );

  // Find the contact row in Sheets
  const contacts = await sheets.getContacts();
  const contact = contacts.find((c) => c.email === event.contactEmail.trim().toLowerCase());

  if (!contact) {
    logger.warn(
      { module: 'bounce-handler', email: event.contactEmail },
      'Bounce for unknown contact — no row to update',
    );
    return;
  }

  if (event.bounceType === 'hard') {
    // Permanent failure — disable this contact immediately
    await sheets.updateContact(contact.email, contact._rowIndex, {
      bounced: true,
      bounceType: 'hard',
      bounceDate: new Date().toISOString(),
      status: 'bounced',
    });

    logger.info(
      { module: 'bounce-handler', email: contact.email },
      'Hard bounce recorded — contact will not be emailed again',
    );
    return;
  }

  // Soft bounce — increment counter, check threshold
  const newCount = (contact.softBounceCount || 0) + 1;

  if (newCount >= SOFT_BOUNCE_THRESHOLD) {
    // Threshold reached — escalate to hard bounce
    await sheets.updateContact(contact.email, contact._rowIndex, {
      bounced: true,
      bounceType: 'hard',
      bounceDate: new Date().toISOString(),
      status: 'bounced',
      softBounceCount: newCount,
    });

    logger.info(
      { module: 'bounce-handler', email: contact.email, count: newCount },
      'Soft bounce threshold reached — converted to hard bounce',
    );
  } else {
    // Below threshold — just record the count, contact stays active
    await sheets.updateContact(contact.email, contact._rowIndex, {
      softBounceCount: newCount,
    });

    logger.info(
      { module: 'bounce-handler', email: contact.email, count: newCount },
      `Soft bounce #${newCount} recorded — will retry on next cycle`,
    );
  }
}
