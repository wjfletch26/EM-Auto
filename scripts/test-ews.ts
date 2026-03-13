/**
 * Phase 0 — EWS (Exchange Web Services) Credential Validation
 *
 * Fallback test if IMAP doesn't work. Connects to the Microsoft 365
 * EWS endpoint using basic auth and attempts to list recent inbox
 * messages. This tells us whether EWS access is available (Tier 2).
 *
 * EWS uses a SOAP XML API over HTTPS — no extra npm packages needed,
 * just the built-in fetch API (Node 18+).
 *
 * Usage:  npm run test:ews
 * Requires: .env file with SMTP_USER and SMTP_PASS (reuses SMTP creds)
 */

import 'dotenv/config';

// ---------------------------------------------------------------------------
// 1. Read credentials from .env
// ---------------------------------------------------------------------------

const EWS_USER = process.env.IMAP_USER ?? process.env.SMTP_USER;
const EWS_PASS = process.env.IMAP_PASS ?? process.env.SMTP_PASS;
const EWS_URL = 'https://outlook.office365.com/EWS/Exchange.asmx';

// ---------------------------------------------------------------------------
// 2. Validate that required values are present
// ---------------------------------------------------------------------------

if (!EWS_USER || !EWS_PASS) {
  console.error('❌  Missing credentials in .env (need SMTP_USER/SMTP_PASS or IMAP_USER/IMAP_PASS)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Build the SOAP request to find recent inbox items
// ---------------------------------------------------------------------------

// This SOAP envelope asks for the 5 most recent items in the Inbox,
// returning just the Subject, DateTimeReceived, and From fields.
const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013_SP1" />
  </soap:Header>
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>Default</t:BaseShape>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="5" Offset="0" BasePoint="Beginning" />
      <m:SortOrder>
        <t:FieldOrder Order="Descending">
          <t:FieldURI FieldURI="item:DateTimeReceived" />
        </t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="inbox" />
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;

// ---------------------------------------------------------------------------
// 4. Run the test
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== EWS Credential Test ===\n');
  console.log(`  Endpoint: ${EWS_URL}`);
  console.log(`  User:     ${EWS_USER}`);
  console.log();

  console.log('→ Sending EWS FindItem request...');

  try {
    // Basic auth header: base64(user:pass)
    const authHeader = 'Basic ' + Buffer.from(`${EWS_USER}:${EWS_PASS}`).toString('base64');

    const response = await fetch(EWS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Authorization': authHeader,
      },
      body: soapBody,
    });

    console.log(`  HTTP Status: ${response.status} ${response.statusText}\n`);

    const body = await response.text();

    // Check for HTTP-level failures
    if (!response.ok) {
      console.error('❌  EWS request failed (HTTP error).\n');

      if (response.status === 401) {
        console.error('  → 401 Unauthorized: credentials rejected.');
        console.error('    Basic auth may be disabled for EWS (Azure AD Security Defaults).');
      } else if (response.status === 403) {
        console.error('  → 403 Forbidden: EWS access is blocked for this account.');
      } else {
        console.error(`  Response body (first 500 chars):\n${body.slice(0, 500)}`);
      }

      process.exit(1);
    }

    // Check for SOAP-level errors
    if (body.includes('ResponseClass="Error"')) {
      console.error('❌  EWS returned a SOAP error.\n');
      // Try to extract the error message
      const msgMatch = body.match(/<m:MessageText>(.*?)<\/m:MessageText>/);
      if (msgMatch) {
        console.error(`  Error: ${msgMatch[1]}`);
      } else {
        console.error(`  Response (first 500 chars):\n${body.slice(0, 500)}`);
      }
      process.exit(1);
    }

    // Parse subjects from the response (lightweight regex parsing)
    console.log('✅  EWS request succeeded!\n');
    console.log('  Recent inbox messages:');

    const subjectRegex = /<t:Subject>(.*?)<\/t:Subject>/g;
    const dateRegex = /<t:DateTimeReceived>(.*?)<\/t:DateTimeReceived>/g;

    const subjects: string[] = [];
    const dates: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = subjectRegex.exec(body)) !== null) {
      subjects.push(match[1]);
    }
    while ((match = dateRegex.exec(body)) !== null) {
      dates.push(match[1]);
    }

    if (subjects.length === 0) {
      console.log('    (No messages found or inbox is empty.)');
    } else {
      for (let i = 0; i < subjects.length; i++) {
        const date = dates[i] ?? '(no date)';
        console.log(`    ${i + 1}. [${date}] ${subjects[i]}`);
      }
    }

    console.log('\n=== EWS TEST PASSED ===');
    console.log('→ EWS access works. This system qualifies for Tier 2 (EWS-based reply processing).');
    console.log('  You will need to build src/services/ews.ts instead of src/services/imap.ts.');

  } catch (err: unknown) {
    console.error('❌  EWS test failed:\n');
    console.error(err);

    console.error('\nPossible causes:');
    console.error('  • Network error / DNS failure');
    console.error('  • EWS endpoint blocked by firewall or Azure AD policy');
    console.error('\n→ If neither IMAP nor EWS works, this system will run in');
    console.error('  Tier 3 (manual reply processing). That is perfectly fine for MVP.');
    process.exit(1);
  }
}

main();
