/**
 * Unsubscribe endpoint smoke test.
 *
 * This starts the web server, checks /health, checks invalid/expired token handling,
 * and checks a valid token flow for one known contact email.
 *
 * Usage: npx tsx scripts/test-unsubscribe-web.ts
 */

import { URL } from 'node:url';
import { config } from '../src/config/index.js';
import { generateUnsubscribeUrl } from '../src/engine/unsubscribe.js';
import { hmacSha256, base64urlEncode } from '../src/utils/crypto.js';
import { startWebServer } from '../src/web/server.js';
import { getContacts } from '../src/services/sheets.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectStatus(path: string, expected: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${config.unsub.port}${path}`);
  const body = await response.text();

  if (response.status !== expected) {
    throw new Error(
      `Expected ${expected} for ${path}, got ${response.status}\nResponse body:\n${body}`,
    );
  }

  return body;
}

function buildExpiredToken(email: string): string {
  // Expiry = unix timestamp 1 (1970-01-01), so the token is always expired.
  const payload = `${email}|1`;
  const signature = hmacSha256(payload, config.unsub.secret);
  return `${base64urlEncode(payload)}.${base64urlEncode(signature)}`;
}

async function main(): Promise<void> {
  console.log('Starting unsubscribe web smoke test...\n');

  const server = startWebServer();
  await new Promise((resolve) => setTimeout(resolve, 250));

  try {
    console.log('1) Checking /health...');
    const healthBody = await expectStatus('/health', 200);
    if (!healthBody.includes('"status":"ok"')) {
      throw new Error(`/health response did not include status ok: ${healthBody}`);
    }

    console.log('2) Checking invalid token response...');
    const invalidBody = await expectStatus('/unsubscribe?token=bad.token', 400);
    if (!invalidBody.includes('Link Not Valid')) {
      throw new Error('Invalid token page content mismatch');
    }

    const contacts = await getContacts();
    if (contacts.length === 0) {
      throw new Error('No contacts found in Sheets. Cannot run valid token smoke test.');
    }

    // Use any known contact for the expired-token behavior check.
    const sampleEmail = contacts[0].email;
    console.log(`3) Checking expired token response (${sampleEmail})...`);
    const expiredToken = buildExpiredToken(sampleEmail);
    const expiredBody = await expectStatus(`/unsubscribe?token=${expiredToken}`, 400);
    if (!expiredBody.includes('Link Expired')) {
      throw new Error('Expired token page content mismatch');
    }

    // If we can find a contact that is not unsubscribed yet, we can assert the write-path.
    const writePathContact = contacts.find((contact) => !contact.unsubscribed) ?? null;
    const validTokenEmail = writePathContact?.email ?? contacts[0].email;

    console.log(`4) Checking valid token response (${validTokenEmail})...`);
    const unsubscribeUrl = generateUnsubscribeUrl(validTokenEmail);
    const token = new URL(unsubscribeUrl).searchParams.get('token');
    if (!token) {
      throw new Error('Failed to generate valid unsubscribe token');
    }

    const validBody = await expectStatus(`/unsubscribe?token=${token}`, 200);
    if (!validBody.includes('Unsubscribed')) {
      throw new Error('Valid token page content mismatch');
    }

    // Enforce Sheets mutation assertions only when we found an active contact.
    // If all contacts are already unsubscribed, the endpoint is expected to no-op.
    if (writePathContact) {
      console.log(`5) Verifying Sheets row updates (${validTokenEmail})...`);

      let updated = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const latestContacts = await getContacts();
        updated = latestContacts.find((contact) => contact.email === validTokenEmail) ?? null;
        if (updated?.unsubscribed && updated.status === 'unsubscribed' && updated.unsubscribeSource === 'link') {
          break;
        }
        await sleep(250);
      }

      if (!updated) {
        throw new Error(`Could not find updated contact row for ${validTokenEmail}`);
      }
      if (!updated.unsubscribed) {
        throw new Error(`Expected unsubscribed=true for ${validTokenEmail}`);
      }
      if (updated.status !== 'unsubscribed') {
        throw new Error(`Expected status=unsubscribed for ${validTokenEmail}, got ${updated.status}`);
      }
      if (updated.unsubscribeSource !== 'link') {
        throw new Error(
          `Expected unsubscribeSource=link for ${validTokenEmail}, got ${updated.unsubscribeSource}`,
        );
      }
      if (!updated.unsubscribeDate) {
        throw new Error(`Expected unsubscribeDate to be set for ${validTokenEmail}`);
      }
    } else {
      console.log('5) Skipping Sheets write-path assertion (all contacts already unsubscribed).');
    }

    console.log('\nSmoke test passed.');
    console.log('Checked: /health, invalid token, expired token, valid token, optional Sheets write-path.');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('\nSmoke test failed:', err);
  process.exit(1);
});
