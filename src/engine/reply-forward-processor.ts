/**
 * Reply forward processor (Tier 3 bridge).
 *
 * Reads queued reply events, forwards each one to the operator mailbox,
 * then pauses the matching contact so no further sends occur automatically.
 */
import { logger } from '../logging/logger.js';
import * as sheets from '../services/sheets.js';
import { forwardReplyForReview } from '../services/smtp.js';
import {
  getForwardedReplyQueue,
  saveForwardedReplyQueue,
  type ForwardedReplyEvent,
} from '../state/local-store.js';

export interface ReplyForwardResult {
  processed: number;
  paused: number;
  failed: number;
}

interface ReplyForwardDeps {
  getContacts: typeof sheets.getContacts;
  updateContact: typeof sheets.updateContact;
  appendReplyLog: typeof sheets.appendReplyLog;
  forwardReplyForReview: typeof forwardReplyForReview;
}

function truncate(value: string, limit: number): string {
  return value.trim().slice(0, limit);
}

/**
 * Processes all queued forwarded-reply events.
 * Failed events remain in the queue for retry on the next tick.
 */
export async function processForwardedReplyQueue(): Promise<ReplyForwardResult> {
  const queue = getForwardedReplyQueue();
  const result = await processForwardedReplyEvents(queue, {
    getContacts: sheets.getContacts,
    updateContact: sheets.updateContact,
    appendReplyLog: sheets.appendReplyLog,
    forwardReplyForReview,
  });
  saveForwardedReplyQueue(result.retryQueue);
  return result.summary;
}

/**
 * Pure-ish processing helper used by tests.
 * Accepts events + explicit dependencies and returns a retry queue.
 */
export async function processForwardedReplyEvents(
  queue: ForwardedReplyEvent[],
  deps: ReplyForwardDeps,
): Promise<{ summary: ReplyForwardResult; retryQueue: ForwardedReplyEvent[] }> {
  if (queue.length === 0) {
    return {
      summary: { processed: 0, paused: 0, failed: 0 },
      retryQueue: [],
    };
  }

  const contacts = await deps.getContacts();
  const contactMap = new Map(contacts.map((c) => [c.email.toLowerCase(), c]));

  let processed = 0;
  let paused = 0;
  let failed = 0;
  const retryQueue: ForwardedReplyEvent[] = [];

  for (const event of queue) {
    const normalizedEmail = event.contactEmail.trim().toLowerCase();
    const contact = contactMap.get(normalizedEmail);

    if (!contact) {
      failed++;
      logger.warn(
        { module: 'reply-forward', contactEmail: normalizedEmail },
        'Reply event has no matching contact — dropping event',
      );
      continue;
    }

    try {
      logger.info(
        { module: 'reply-forward', contactEmail: normalizedEmail, from: event.fromEmail },
        'Reply detected for contact',
      );

      await deps.forwardReplyForReview({
        contactEmail: normalizedEmail,
        fromEmail: event.fromEmail,
        subject: event.subject,
        body: event.body,
      });

      const nowIso = new Date().toISOString();
      await deps.updateContact(contact.email, contact._rowIndex, {
        status: 'paused',
        replyStatus: 'forwarded',
        replyDate: nowIso,
        replySnippet: truncate(event.body, 500),
      });

      await deps.appendReplyLog({
        timestamp: nowIso,
        contactEmail: contact.email,
        classification: 'forwarded',
        subjectSnippet: truncate(event.subject, 200),
        bodySnippet: truncate(event.body, 500),
        source: 'manual_forward',
      });

      logger.info(
        { module: 'reply-forward', contactEmail: normalizedEmail },
        'Reply forwarded and contact paused',
      );

      processed++;
      paused++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      failed++;
      retryQueue.push(event);
      logger.error(
        { module: 'reply-forward', contactEmail: normalizedEmail, error: message },
        'Failed to process reply-forward event',
      );
    }
  }

  return {
    summary: { processed, paused, failed },
    retryQueue,
  };
}
