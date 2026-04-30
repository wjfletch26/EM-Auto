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
  Contact, ContactUpdate, ContactProfileUpdate, ContactAppendPayload, Campaign,
  SendLogEntry, ReplyLogEntry,
  CompanyIntelligence, CompanyIntelUpdate,
  ReviewQueueEntry, ReviewQueueUpdate, QcRegenAuditEntry,
} from './sheets-types.js';
import {
  FIELD_TO_COLUMN,
  PROFILE_FIELD_TO_COLUMN,
  INTEL_FIELD_TO_COLUMN,
  REVIEW_FIELD_TO_COLUMN,
} from './sheets-types.js';

// Re-export types so consumers only need one import
export type {
  Contact, ContactUpdate, ContactProfileUpdate, ContactAppendPayload, Campaign,
  SendLogEntry, ReplyLogEntry,
  CompanyIntelligence, CompanyIntelUpdate,
  ReviewQueueEntry, ReviewQueueUpdate, QcRegenAuditEntry,
};

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

/** Converts values for RAW Sheets writes (booleans → TRUE/FALSE). */
function toSheetCell(value: unknown): string | number {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return value;
  return value === null || value === undefined ? '' : String(value);
}

// ─── Read operations ─────────────────────────────────────────────────────────

/** Reads all contacts from the Contacts tab. Skips invalid rows with a warning. */
export async function getContacts(): Promise<Contact[]> {
  const sheets = await getClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Contacts!A2:X' })
  );

  const rows = res.data.values || [];
  const contacts: Contact[] = [];
  const seenEmails = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const email = row[0]?.trim().toLowerCase();
    const firstName = row[1]?.trim();
    const campaignId = row[5]?.trim();

    // Validate required fields — email and first name are mandatory.
    // campaign_id is optional: pipeline contacts won't have one until approval.
    if (!email || !email.includes('@') || !firstName) {
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
      companyUrl: row[22] || '',
      pipelineStatus: row[23] || '',
      _rowIndex: i + 2, // 1-indexed, +1 for the header row
    });
  }

  logger.info({ module: 'sheets', count: contacts.length }, 'Contacts loaded');
  return contacts;
}

/**
 * Reads all campaigns from the Campaigns tab.
 * Supports up to 12 steps. Each step uses 3 columns (template, subject, delay_days).
 * Columns: A=id, B=name, C=total_steps, D-F=step1, G-I=step2, ... , AK-AM=step12, AN=active, AO=campaign_type
 */
export async function getCampaigns(): Promise<Campaign[]> {
  const sheets = await getClient();
  // Read enough columns for 12 steps: A-AO (cols 0-40)
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Campaigns!A2:AO' })
  );

  const rows = res.data.values || [];
  return rows.map((row) => {
    const totalSteps = parseInt(row[2]) || 0;
    const steps = [];

    // Each step occupies 3 columns starting at index 3 (col D)
    for (let s = 0; s < Math.min(totalSteps, 12); s++) {
      const base = 3 + s * 3;
      const templateFile = row[base] || '';
      if (templateFile) {
        steps.push({
          stepNumber: s + 1,
          templateFile,
          subject: row[base + 1] || '',
          delayDays: parseInt(row[base + 2]) || 0,
        });
      }
    }

    // active is at column index 3 + 12*3 = 39, campaign_type at 40
    const activeIdx = 3 + 12 * 3; // col AN (index 39)
    const typeIdx = activeIdx + 1;  // col AO (index 40)

    return {
      campaignId: row[0]?.trim() || '',
      campaignName: row[1]?.trim() || '',
      totalSteps,
      steps,
      active: row[activeIdx]?.toUpperCase() === 'TRUE',
      campaignType: (row[typeIdx]?.trim() || 'template') as 'template' | 'ai_generated',
    };
  });
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

/** Normalizes values so Google Sheets shows booleans and numbers predictably. */
function contactCellValue(value: unknown): string | number {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return value;
  return value === null || value === undefined ? '' : String(value);
}

/** Normalizes values for Review Queue updates. */
function reviewQueueCellValue(value: unknown): string | number {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return value;
  return value === null || value === undefined ? '' : String(value);
}

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
    data.push({ range: `Contacts!${col}${rowIndex}`, values: [[toSheetCell(value)]] });
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
      data.push({ range: `Contacts!${col}${rowIndex}`, values: [[toSheetCell(value)]] });
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

/**
 * Updates operator-editable contact columns (B–F, T–W).
 * Does not change email (column A); use appendContact for new rows.
 */
export async function updateContactProfile(
  email: string,
  rowIndex: number,
  updates: Partial<ContactProfileUpdate>,
): Promise<void> {
  const sheets = await getClient();
  const data: sheets_v4.Schema$ValueRange[] = [];

  for (const [field, value] of Object.entries(updates)) {
    const col = PROFILE_FIELD_TO_COLUMN[field as keyof ContactProfileUpdate];
    if (!col) continue;
    data.push({ range: `Contacts!${col}${rowIndex}`, values: [[toSheetCell(value)]] });
  }

  if (data.length === 0) return;

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    })
  );

  logger.info({ module: 'sheets', email, fields: Object.keys(updates) }, 'Contact profile updated');
}

/**
 * Appends a new contact row. Fails if the email already exists (case-insensitive).
 */
export async function appendContact(payload: ContactAppendPayload): Promise<void> {
  const email = payload.email.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new Error('appendContact: valid email is required');
  }
  const firstName = payload.firstName?.trim();
  if (!firstName) {
    throw new Error('appendContact: firstName is required');
  }

  const existing = await getContacts();
  if (existing.some((c) => c.email === email)) {
    throw new Error(`appendContact: duplicate email ${email}`);
  }

  const row: (string | number)[] = [
    email,
    firstName,
    payload.lastName?.trim() ?? '',
    payload.company?.trim() ?? '',
    payload.title?.trim() ?? '',
    payload.campaignId?.trim() ?? '',
    'new',
    0,
    '',
    '',
    '',
    '',
    'FALSE',
    '',
    '',
    'FALSE',
    '',
    '',
    0,
    payload.custom1?.trim() ?? '',
    payload.custom2?.trim() ?? '',
    payload.notes?.trim() ?? '',
    payload.companyUrl?.trim() ?? '',
    payload.pipelineStatus?.trim() || 'new',
  ];

  const sheets = await getClient();
  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Contacts!A:X',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    })
  );

  logger.info({ module: 'sheets', email }, 'Contact row appended');
}

/**
 * Soft-delete: marks do_not_contact and appends an archive line to notes (does not remove the row).
 */
export async function softDeleteContact(email: string, rowIndex: number): Promise<void> {
  const contacts = await getContacts();
  const contact = contacts.find((c) => c.email === email && c._rowIndex === rowIndex);
  if (!contact) {
    throw new Error(`softDeleteContact: contact not found for ${email} row ${rowIndex}`);
  }

  const archiveLine = `[archived ${new Date().toISOString().slice(0, 10)}]`;
  const newNotes = contact.notes ? `${contact.notes}\n${archiveLine}` : archiveLine;

  const sheets = await getClient();
  const data: sheets_v4.Schema$ValueRange[] = [
    { range: `Contacts!G${rowIndex}`, values: [['do_not_contact']] },
    { range: `Contacts!V${rowIndex}`, values: [[newNotes]] },
  ];

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    })
  );

  logger.info({ module: 'sheets', email }, 'Contact soft-deleted (do_not_contact)');
}

/**
 * Sets Review Queue status to `superseded` for all rows for this contact that have no campaign_id yet.
 * Used before regenerating AI sequences so old drafts are not confused with the new batch.
 */
export async function markReviewQueueSupersededForContact(contactEmail: string): Promise<number> {
  const normalized = contactEmail.trim().toLowerCase();
  const queue = await getReviewQueue();
  const targets = queue.filter(
    (e) => e.contactEmail === normalized && !e.campaignId?.trim() && e.status !== 'superseded',
  );

  if (targets.length === 0) return 0;

  const sheets = await getClient();
  const data: sheets_v4.Schema$ValueRange[] = targets.map((e) => ({
    range: `'Review Queue'!G${e._rowIndex}`,
    values: [['superseded']],
  }));

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    })
  );

  logger.info({ module: 'sheets', email: normalized, count: targets.length }, 'Review queue rows superseded');
  return targets.length;
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

// ─── Company Intelligence Tab ────────────────────────────────────────────────

/** Reads all rows from the Company Intelligence tab. */
export async function getCompanyIntelligence(): Promise<CompanyIntelligence[]> {
  const sheets = await getClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "'Company Intelligence'!A2:R" })
  );

  const rows = res.data.values || [];
  return rows.map((row, i) => ({
    contactEmail: row[0]?.trim().toLowerCase() || '',
    companyUrl: row[1] || '',
    companyName: row[2] || '',
    industry: row[3] || '',
    productSummary: row[4] || '',
    companySize: row[5] || '',
    signals: row[6] || '',
    signalSummary: row[7] || '',
    deatonCapabilitiesMatched: row[8] || '',
    caseStudiesSelected: row[9] || '',
    alignmentRationale: row[10] || '',
    confidenceScore: row[11] || '',
    davidProjectNotes: row[12] || '',
    executiveBrief: row[13] || '',
    pipelineStatus: row[14] || '',
    researchedDate: row[15] || '',
    generatedDate: row[16] || '',
    errorLog: row[17] || '',
    _rowIndex: i + 2,
  }));
}

/** Appends a new row to the Company Intelligence tab. */
export async function appendCompanyIntelligence(entry: Omit<CompanyIntelligence, '_rowIndex'>): Promise<void> {
  const sheets = await getClient();
  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Company Intelligence'!A:R",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          entry.contactEmail, entry.companyUrl, entry.companyName,
          entry.industry, entry.productSummary, entry.companySize,
          entry.signals, entry.signalSummary, entry.deatonCapabilitiesMatched,
          entry.caseStudiesSelected, entry.alignmentRationale, entry.confidenceScore,
          entry.davidProjectNotes, entry.executiveBrief, entry.pipelineStatus,
          entry.researchedDate, entry.generatedDate, entry.errorLog,
        ]],
      },
    })
  );
  logger.info({ module: 'sheets', email: entry.contactEmail }, 'Company intelligence row appended');
}

/** Updates specific fields on a Company Intelligence row. */
export async function updateCompanyIntelligence(
  contactEmail: string,
  rowIndex: number,
  updates: Partial<CompanyIntelUpdate>,
): Promise<void> {
  const sheets = await getClient();
  const data: sheets_v4.Schema$ValueRange[] = [];

  for (const [field, value] of Object.entries(updates)) {
    const col = INTEL_FIELD_TO_COLUMN[field as keyof CompanyIntelUpdate];
    if (!col) continue;
    data.push({ range: `'Company Intelligence'!${col}${rowIndex}`, values: [[value]] });
  }

  if (data.length === 0) return;

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    })
  );

  logger.info({ module: 'sheets', email: contactEmail, fields: Object.keys(updates) }, 'Company intelligence updated');
}

// ─── Review Queue Tab ────────────────────────────────────────────────────────

/** Reads all rows from the Review Queue tab. */
export async function getReviewQueue(): Promise<ReviewQueueEntry[]> {
  const sheets = await getClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "'Review Queue'!A2:P" })
  );

  const rows = res.data.values || [];
  return rows.map((row, i) => ({
    contactEmail: row[0]?.trim().toLowerCase() || '',
    companyName: row[1] || '',
    stepNumber: parseInt(row[2]) || 0,
    emailPurpose: row[3] || '',
    subject: row[4] || '',
    body: row[5] || '',
    status: row[6]?.trim().toLowerCase() || '',
    reviewerNotes: row[7] || '',
    generatedDate: row[8] || '',
    approvedDate: row[9] || '',
    campaignId: row[10] || '',
    daveNotes: row[11] || '',
    manualReviewRequired: row[12]?.toUpperCase() === 'TRUE',
    qcAutoStatus: ((row[13] || 'ok').trim().toLowerCase() as ReviewQueueEntry['qcAutoStatus']),
    nextAction: row[14] || '',
    regenMode: ((row[15] || '').trim().toLowerCase() as ReviewQueueEntry['regenMode']),
    _rowIndex: i + 2,
  }));
}

/** Appends a batch of emails (typically 12) to the Review Queue tab. */
export async function appendReviewQueueBatch(entries: Omit<ReviewQueueEntry, '_rowIndex'>[]): Promise<void> {
  const sheets = await getClient();
  const values = entries.map((e) => [
    e.contactEmail, e.companyName, e.stepNumber, e.emailPurpose,
    e.subject, e.body, e.status, e.reviewerNotes,
    e.generatedDate, e.approvedDate, e.campaignId, e.daveNotes ?? '',
    e.manualReviewRequired ? 'TRUE' : 'FALSE',
    e.qcAutoStatus ?? 'ok',
    e.nextAction ?? '',
    e.regenMode ?? '',
  ]);

  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Review Queue'!A:P",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    })
  );

  logger.info({ module: 'sheets', count: entries.length }, 'Review queue entries appended');
}

/** Updates specific fields on a Review Queue row. */
export async function updateReviewQueueEntry(
  rowIndex: number,
  updates: Partial<ReviewQueueUpdate>,
): Promise<void> {
  const sheets = await getClient();
  const data: sheets_v4.Schema$ValueRange[] = [];

  for (const [field, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const col = REVIEW_FIELD_TO_COLUMN[field as keyof ReviewQueueUpdate];
    if (!col) continue;
    data.push({ range: `'Review Queue'!${col}${rowIndex}`, values: [[reviewQueueCellValue(value)]] });
  }

  if (data.length === 0) return;

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    })
  );
}

/** Appends one row to the QC Regen Audit tab (append-only). */
export async function appendQcRegenAudit(entry: QcRegenAuditEntry): Promise<void> {
  const sheets = await getClient();
  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'QC Regen Audit'!A:M",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          entry.timestamp,
          entry.contactEmail,
          entry.stepNumber,
          entry.attemptNumber,
          entry.regenMode,
          entry.inputSourcesUsed,
          entry.triggerReason,
          entry.qcIssuesJson,
          entry.suggestionUsed,
          entry.subjectBefore,
          entry.bodyBefore,
          entry.subjectAfter,
          entry.bodyAfter,
        ]],
      },
    })
  );
}

// Cached numeric sheet id for the "Review Queue" tab (used by row delete).
let reviewQueueSheetIdCache: number | null = null;

async function resolveReviewQueueSheetId(): Promise<number> {
  if (reviewQueueSheetIdCache != null) return reviewQueueSheetIdCache;
  const sheets = await getClient();
  const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }));
  const found = meta.data.sheets?.find((s) => s.properties?.title === 'Review Queue');
  const id = found?.properties?.sheetId;
  if (id === undefined || id === null) {
    throw new Error('Spreadsheet has no "Review Queue" tab');
  }
  reviewQueueSheetIdCache = id;
  return id;
}

/**
 * Deletes a single row from the Review Queue tab.
 *
 * @param rowIndex Same 1-based row number as `_rowIndex` on `ReviewQueueEntry` (header is row 1).
 */
export async function deleteReviewQueueRow(rowIndex: number): Promise<void> {
  if (!Number.isInteger(rowIndex) || rowIndex < 2) {
    throw new Error('rowIndex must be an integer sheet row >= 2');
  }
  const sheets = await getClient();
  const sheetId = await resolveReviewQueueSheetId();
  const start0 = rowIndex - 1;
  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: start0,
                endIndex: rowIndex,
              },
            },
          },
        ],
      },
    })
  );
  logger.info({ module: 'sheets', rowIndex }, 'Review queue row deleted');
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
