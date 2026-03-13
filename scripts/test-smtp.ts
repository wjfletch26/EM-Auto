/**
 * Phase 0 — SMTP Credential Validation
 *
 * Connects to smtp.office365.com:587 with STARTTLS and sends a
 * test email to the operator's address. If this succeeds, SMTP
 * sending is confirmed and we can proceed to Phase 1.
 *
 * Usage:  npm run test:smtp
 * Requires: .env file with SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 */

import 'dotenv/config';
import nodemailer from 'nodemailer';

// ---------------------------------------------------------------------------
// 1. Read credentials from .env
// ---------------------------------------------------------------------------

const SMTP_HOST = process.env.SMTP_HOST ?? 'smtp.office365.com';
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME ?? 'Deaton Outreach Test';

// Where the test email gets sent — defaults to the sender address
const TEST_RECIPIENT = process.env.TEST_RECIPIENT ?? SMTP_USER;

// ---------------------------------------------------------------------------
// 2. Validate that required values are present
// ---------------------------------------------------------------------------

if (!SMTP_USER || !SMTP_PASS) {
  console.error('❌  Missing SMTP_USER or SMTP_PASS in .env');
  console.error('    Copy .env.example → .env and fill in your credentials.');
  process.exit(1);
}

if (!TEST_RECIPIENT) {
  console.error('❌  No TEST_RECIPIENT or SMTP_USER set. Cannot determine where to send.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Create the Nodemailer transporter
// ---------------------------------------------------------------------------

// SMTP_SECURE=false + port 587 → STARTTLS (correct for Microsoft 365)
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false, // STARTTLS on 587
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
  // Microsoft 365 TLS requirement
  tls: {
    ciphers: 'SSLv3',
    rejectUnauthorized: true,
  },
});

// ---------------------------------------------------------------------------
// 4. Run the test
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== SMTP Credential Test ===\n');
  console.log(`  Host:      ${SMTP_HOST}`);
  console.log(`  Port:      ${SMTP_PORT}`);
  console.log(`  User:      ${SMTP_USER}`);
  console.log(`  Recipient: ${TEST_RECIPIENT}`);
  console.log();

  // Step A — Verify the connection (auth handshake)
  console.log('→ Verifying SMTP connection...');
  try {
    await transporter.verify();
    console.log('✅  SMTP connection verified (auth succeeded).\n');
  } catch (err: unknown) {
    console.error('❌  SMTP connection failed:\n');
    console.error(err);
    console.error('\nPossible causes:');
    console.error('  • Wrong password');
    console.error('  • SMTP AUTH not enabled for this mailbox');
    console.error('  • Security Defaults blocking basic auth (Azure AD)');
    console.error('  • Firewall blocking port 587');
    process.exit(1);
  }

  // Step B — Send a test email
  console.log('→ Sending test email...');
  try {
    const info = await transporter.sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_USER}>`,
      to: TEST_RECIPIENT,
      subject: `[Deaton Outreach] SMTP Test — ${new Date().toISOString()}`,
      text: [
        'This is an automated test from the Deaton Outreach system.',
        '',
        'If you received this email, SMTP sending is working correctly.',
        '',
        `Sent at: ${new Date().toISOString()}`,
        `From:    ${SMTP_USER}`,
        `To:      ${TEST_RECIPIENT}`,
      ].join('\n'),
    });

    console.log('✅  Email sent successfully!');
    console.log(`    Message ID: ${info.messageId}`);
    console.log(`    Response:   ${info.response}`);
    console.log(`\n  → Check ${TEST_RECIPIENT}'s inbox (and spam folder) for the test email.`);
  } catch (err: unknown) {
    console.error('❌  Failed to send email:\n');
    console.error(err);
    process.exit(1);
  }
}

main();
