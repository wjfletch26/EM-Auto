/**
 * Phase 0 — IMAP Credential Validation
 *
 * Connects to outlook.office365.com:993 over TLS and attempts to
 * list the 5 most recent messages in the inbox. This tells us
 * whether IMAP access is available (Tier 1) or not.
 *
 * Usage:  npm run test:imap
 * Requires: .env file with IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS
 */

import 'dotenv/config';
import { ImapFlow } from 'imapflow';

// ---------------------------------------------------------------------------
// 1. Read credentials from .env
// ---------------------------------------------------------------------------

const IMAP_HOST = process.env.IMAP_HOST ?? 'outlook.office365.com';
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 993);
// Fall back to SMTP creds if IMAP-specific ones aren't set
const IMAP_USER = process.env.IMAP_USER ?? process.env.SMTP_USER;
const IMAP_PASS = process.env.IMAP_PASS ?? process.env.SMTP_PASS;

// ---------------------------------------------------------------------------
// 2. Validate that required values are present
// ---------------------------------------------------------------------------

if (!IMAP_USER || !IMAP_PASS) {
  console.error('❌  Missing IMAP_USER/IMAP_PASS (or SMTP_USER/SMTP_PASS) in .env');
  console.error('    Copy .env.example → .env and fill in your credentials.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Run the test
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== IMAP Credential Test ===\n');
  console.log(`  Host: ${IMAP_HOST}`);
  console.log(`  Port: ${IMAP_PORT}`);
  console.log(`  User: ${IMAP_USER}`);
  console.log();

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true, // TLS on port 993
    auth: {
      user: IMAP_USER,
      pass: IMAP_PASS,
    },
    logger: false, // suppress verbose IMAP protocol logs
  });

  try {
    // Step A — Connect and authenticate
    console.log('→ Connecting to IMAP server...');
    await client.connect();
    console.log('✅  IMAP connection succeeded (auth OK).\n');

    // Step B — Open the INBOX
    console.log('→ Opening INBOX...');
    const mailbox = await client.mailboxOpen('INBOX');
    console.log(`✅  INBOX opened. Total messages: ${mailbox.exists}\n`);

    // Step C — Fetch the 5 most recent messages (headers only)
    console.log('→ Fetching 5 most recent messages...\n');

    // ImapFlow uses sequence numbers; "*" = last, fetch last 5
    const totalMessages = mailbox.exists ?? 0;
    if (totalMessages === 0) {
      console.log('  (Inbox is empty — no messages to display.)');
    } else {
      // Range: from (total - 4) to total, clamped to 1
      const startSeq = Math.max(1, totalMessages - 4);
      const range = `${startSeq}:*`;

      let count = 0;
      for await (const msg of client.fetch(range, { envelope: true })) {
        count++;
        const env = msg.envelope;
        const from = env.from?.[0]
          ? `${env.from[0].name ?? ''} <${env.from[0].address ?? ''}>`
          : '(unknown)';
        const date = env.date ? env.date.toISOString() : '(no date)';
        const subject = env.subject ?? '(no subject)';

        console.log(`  ${count}. ${date}`);
        console.log(`     From:    ${from}`);
        console.log(`     Subject: ${subject}`);
        console.log();
      }

      if (count === 0) {
        console.log('  (No messages returned in range.)');
      }
    }

    // ---------------------------------------------------------------------------
    // Result
    // ---------------------------------------------------------------------------
    console.log('=== IMAP TEST PASSED ===');
    console.log('→ IMAP access works. This system qualifies for Tier 1 (automated reply processing).');
    console.log('  Set IMAP_ENABLED=true in .env when ready.');

  } catch (err: unknown) {
    console.error('❌  IMAP test failed:\n');
    console.error(err);

    console.error('\nPossible causes:');
    console.error('  • IMAP disabled for this mailbox (GoDaddy/M365 admin setting)');
    console.error('  • Wrong password');
    console.error('  • Security Defaults blocking basic auth (Azure AD)');
    console.error('  • Firewall blocking port 993');
    console.error('\n→ If IMAP does not work, try the EWS test: npm run test:ews');
    console.error('→ If neither works, this system will run in Tier 3 (manual reply processing).');
    process.exit(1);

  } finally {
    // Always disconnect cleanly
    try {
      await client.logout();
    } catch {
      // Ignore logout errors — connection may already be closed
    }
  }
}

main();
