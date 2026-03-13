/**
 * Google Sheets service — all reads and writes to the spreadsheet.
 *
 * Uses a service account for authentication (no user interaction needed).
 * Includes retry logic for 429/5xx errors with exponential backoff.
 *
 * Reference: specs/SOURCE_SYNC.md, docs/DATA_MODEL.md
 */

import { google, type sheets_v4 } from 'googleapis';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import type {
  Contact, ContactUpdate, Campaign,
  SendLogEntry, ReplyLogEntry,
} from './sheets-types.js';
import { FIELD_TO_COLUMN } from './sheets-types.js';

// Re-export types so consumers only need one import
export type { Contact, ContactUpdate, Campaign, SendLogEntry, ReplyLogEntry };

// ─── Singleton Sheets client ─────────────────────────────────────────────────

let sheetsClient: sheets_v4.Sheets | null = null;

/** Lazily initializes and caches the authenticated Sheets client. */
async function getClient(): Promise<sheets_v4.Sheets> {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.GoogleAuth({
    keyFile: config.google.serviceAccountPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

const SPREADSHEET_ID = config.google.spreadsheetId;

// ─── Retry helper ────────────────────────────────────────────────────────────

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries an async function on 429 or 5xx errors with exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      const retryable = code === 429 || (code !== undefined && code >= 500);

      if (retryable && attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        logger.warn({ module: 'sheets', attempt, delayMs, code }, 'Sheets API retryable error, retrying');
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error('withRetry: unreachable');
}

// ─── Read operations ─────────────────────────────────────────────────────────

/** Reads all contacts from the Contacts tab. Skips invalid rows with a warning. */
export async function getContacts(): Promise<Contact[]> {
  const sheets = await getClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Contacts!A2:V' })
  );

  const rows = res.data.values || [];
  const contacts: Contact[] = [];
  const seenEmails = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const email = row[0]?.trim().toLowerCase();
    const firstName = row[1]?.trim();
    const campaignId = row[5]?.trim();

    // Validate required fields
    if (!email || !email.includes('@') || !firstName || !campaignId) {
      logger.warn({ module: 'sheets', rowIndex: i + 2, email }, 'Skipping invalid contact row');
      continue;
    }

    // Deduplicate — keep only the first occurrence
    if (seenEmails.has(email)) {
      logger.warn({ module: 'sheets', email }, 'Duplicate email found, keeping first occurrence');
      continue;
    }
    seenEmails.add(email);

    contacts.push({
      email,
      firstName,
      lastName: row[2]?.trim() || '',
      company: row[3]?.trim() || '',
      title: row[4]?.trim() || '',
      campaignId,
      status: row[6]?.trim().toLowerCase() || 'new',
      lastStepSent: parseInt(row[7]) || 0,
      lastSendDate: row[8] || null,
      replyStatus: row[9] || null,
      replyDate: row[10] || null,
      replySnippet: row[11] || '',
      unsubscribed: row[12]?.toUpperCase() === 'TRUE',
      unsubscribeDate: row[13] || null,
      unsubscribeSource: row[14] || null,
      bounced: row[15]?.toUpperCase() === 'TRUE',
      bounceType: row[16] || null,
      bounceDate: row[17] || null,
      softBounceCount: parseInt(row[18]) || 0,
      custom1: row[19] || '',
      custom2: row[20] || '',
      notes: row[21] || '',
      _rowIndex: i + 2, // 1-indexed, +1 for the header row
    });
  }

  logger.info({ module: 'sheets', count: contacts.length }, 'Contacts loaded');
  return contacts;
}

/** Reads all campaigns from the Campaigns tab. */
export async function getCampaigns(): Promise<Campaign[]> {
  const sheets = await getClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Campaigns!A2:M' })
  );

  const rows = res.data.values || [];
  return rows.map((row) => ({
    campaignId: row[0]?.trim() || '',
    campaignName: row[1]?.trim() || '',
    totalSteps: parseInt(row[2]) || 0,
    steps: [
      { stepNumber: 1, templateFile: row[3] || '', subject: row[4] || '', delayDays: parseInt(row[5]) || 0 },
      { stepNumber: 2, templateFile: row[6] || '', subject: row[7] || '', delayDays: parseInt(row[8]) || 0 },
      { stepNumber: 3, templateFile: row[9] || '', subject: row[10] || '', delayDays: parseInt(row[11]) || 0 },
    ].filter((s) => s.templateFile),
    active: row[12]?.toUpperCase() === 'TRUE',
  }));
}

/** Reads the Send Log for deduplication checks. */
export async function getSendLog(): Promise<SendLogEntry[]> {
  const sheets = await getClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "'Send Log'!A2:H" })
  );

  const rows = res.data.values || [];
  return rows.map((row) => ({
    timestamp: row[0] || '',
    contactEmail: row[1]?.trim().toLowerCase() || '',
    campaignId: row[2]?.trim() || '',
    step: parseInt(row[3]) || 0,
    status: row[4]?.trim() || '',
    messageId: row[5] || '',
    errorMessage: row[6] || '',
    templateUsed: row[7] || '',
  }));
}

// ─── Write operations ────────────────────────────────────────────────────────

/** Updates specific fields on a contact row identified by email. */
export async function updateContact(
  email: string,
  rowIndex: number,
  updates: Partial<ContactUpdate>,
): Promise<void> {
  const sheets = await getClient();
  const data: sheets_v4.Schema$ValueRange[] = [];

  for (const [field, value] of Object.entries(updates)) {
    const col = FIELD_TO_COLUMN[field as keyof ContactUpdate];
    if (!col) continue;
    data.push({ range: `Contacts!${col}${rowIndex}`, values: [[value]] });
  }

  if (data.length === 0) return;

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    })
  );

  logger.info({ module: 'sheets', email, fields: Object.keys(updates) }, 'Contact updated');
}

/** Batch-updates multiple contacts in a single API call. */
export async function batchUpdateContacts(
  updates: Array<{ email: string; rowIndex: number; updates: Partial<ContactUpdate> }>,
): Promise<void> {
  const sheets = await getClient();
  const data: sheets_v4.Schema$ValueRange[] = [];

  for (const { rowIndex, updates: fields } of updates) {
    for (const [field, value] of Object.entries(fields)) {
      const col = FIELD_TO_COLUMN[field as keyof ContactUpdate];
      if (!col) continue;
      data.push({ range: `Contacts!${col}${rowIndex}`, values: [[value]] });
    }
  }

  if (data.length === 0) return;

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    })
  );

  logger.info({ module: 'sheets', count: updates.length }, 'Batch contact update complete');
}

/** Appends a row to the Send Log tab. */
export async function appendSendLog(entry: SendLogEntry): Promise<void> {
  const sheets = await getClient();
  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Send Log'!A:H",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          entry.timestamp, entry.contactEmail, entry.campaignId,
          entry.step, entry.status, entry.messageId,
          entry.errorMessage, entry.templateUsed,
        ]],
      },
    })
  );
  logger.info({ module: 'sheets', email: entry.contactEmail, step: entry.step }, 'Send log entry appended');
}

/** Appends a row to the Reply Log tab. */
export async function appendReplyLog(entry: ReplyLogEntry): Promise<void> {
  const sheets = await getClient();
  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Reply Log'!A:F",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          entry.timestamp, entry.contactEmail, entry.classification,
          entry.subjectSnippet, entry.bodySnippet, entry.source,
        ]],
      },
    })
  );
}

// ─── Startup verification ────────────────────────────────────────────────────

/** Verifies we can reach the spreadsheet. Called at app startup. */
export async function verifyAccess(): Promise<boolean> {
  try {
    const sheets = await getClient();
    await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    logger.info({ module: 'sheets' }, 'Google Sheets connection verified');
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'sheets', error: message }, 'Google Sheets access failed');
    return false;
  }
}
