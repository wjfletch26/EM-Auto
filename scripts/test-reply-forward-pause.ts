/**
 * Reply-forward-pause smoke test (Tier 3 bridge).
 *
 * This script queues one manual forwarded-reply event, runs the processor once,
 * and verifies the contact is paused in Sheets.
 *
 * Usage:
 *   npx tsx scripts/test-reply-forward-pause.ts contact@example.com
 */
import { enqueueForwardedReply } from '../src/state/local-store.js';
import { processForwardedReplyQueue } from '../src/engine/reply-forward-processor.js';
import { getContacts } from '../src/services/sheets.js';

async function main(): Promise<void> {
  const emailArg = process.argv[2]?.trim().toLowerCase();
  if (!emailArg) {
    throw new Error('Usage: npx tsx scripts/test-reply-forward-pause.ts contact@example.com');
  }

  console.log(`Queueing reply-forward event for ${emailArg}...`);
  enqueueForwardedReply({
    contactEmail: emailArg,
    fromEmail: 'prospect@example.com',
    subject: 'Re: Outreach',
    body: 'Thanks for reaching out. Please follow up next month.',
    receivedAt: new Date().toISOString(),
  });

  console.log('Running reply-forward processor...');
  const result = await processForwardedReplyQueue();
  console.log('Processor result:', result);

  const contacts = await getContacts();
  const contact = contacts.find((c) => c.email === emailArg);
  if (!contact) {
    throw new Error(`Contact not found in Sheets: ${emailArg}`);
  }

  if (contact.status !== 'paused') {
    throw new Error(`Expected status=paused, got ${contact.status}`);
  }
  if (contact.replyStatus !== 'forwarded') {
    throw new Error(`Expected replyStatus=forwarded, got ${contact.replyStatus}`);
  }

  console.log('Smoke test passed: contact was forwarded and paused.');
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
