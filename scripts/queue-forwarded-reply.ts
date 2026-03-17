/**
 * Queue one forwarded-reply event for the scheduler reply cycle.
 *
 * Usage:
 *   npx tsx scripts/queue-forwarded-reply.ts contact@example.com "Subject line" "Reply body snippet"
 */
import { enqueueForwardedReply } from '../src/state/local-store.js';

async function main(): Promise<void> {
  const contactEmail = process.argv[2]?.trim().toLowerCase();
  const subject = process.argv[3]?.trim() ?? '';
  const body = process.argv[4]?.trim() ?? '';

  if (!contactEmail) {
    throw new Error(
      'Usage: npx tsx scripts/queue-forwarded-reply.ts contact@example.com "Subject" "Body"',
    );
  }

  enqueueForwardedReply({
    contactEmail,
    fromEmail: 'manual-forward@outlook-rule.local',
    subject,
    body,
    receivedAt: new Date().toISOString(),
  });

  console.log(`Queued forwarded reply event for ${contactEmail}`);
}

main().catch((err) => {
  console.error('Failed to queue forwarded reply:', err);
  process.exit(1);
});
