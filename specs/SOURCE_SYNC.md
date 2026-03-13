# Spec: Source Sync (Google Sheets Service)

**File**: `src/services/sheets.ts`
**Dependencies**: `googleapis`, `src/config/index.ts`, `src/logging/logger.ts`

---

## Purpose

Source Sync is the Google Sheets service layer. It handles all reads and writes to the Google Spreadsheet. It translates between Sheets row/column data and typed TypeScript objects used by the engine layer.

---

## Public Interface

```typescript
// --- Read Operations ---

// Read all contacts from the "Contacts" tab.
async function getContacts(): Promise<Contact[]>

// Read all campaigns from the "Campaigns" tab.
async function getCampaigns(): Promise<Campaign[]>

// Read the Send Log for deduplication checks.
async function getSendLog(): Promise<SendLogEntry[]>

// --- Write Operations ---

// Update specific cells in a contact's row.
async function updateContact(email: string, updates: Partial<ContactUpdate>): Promise<void>

// Append a row to the Send Log tab.
async function appendSendLog(entry: SendLogEntry): Promise<void>

// Append a row to the Reply Log tab.
async function appendReplyLog(entry: ReplyLogEntry): Promise<void>

// Batch update multiple contacts (reduces API calls).
async function batchUpdateContacts(updates: Array<{ email: string; updates: Partial<ContactUpdate> }>): Promise<void>
```

---

## Authentication

Uses a Google Cloud service account with a JSON key file.

```typescript
import { google } from 'googleapis';

async function authorize() {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.google.serviceAccountPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth;
}

const sheets = google.sheets({ version: 'v4', auth: await authorize() });
```

**Scopes**: Only `spreadsheets` scope is needed (read + write).

---

## Tab and Range Mapping

| Tab Name | Read Range | Write Range | Purpose |
|---|---|---|---|
| `Contacts` | `Contacts!A1:V` | Individual cells | Master contact list |
| `Campaigns` | `Campaigns!A1:M` | (Read-only at MVP) | Campaign definitions |
| `Send Log` | `Send Log!A1:H` | Append rows | Send history |
| `Reply Log` | `Reply Log!A1:F` | Append rows | Reply history |

**Important**: Tab names contain spaces. They must be quoted or referenced correctly in the API call range parameter.

---

## Read Operations

### getContacts()

```
1. Call sheets.spreadsheets.values.get({
     spreadsheetId: config.google.spreadsheetId,
     range: 'Contacts!A2:V',  // Skip header row
   })

2. Parse each row into a Contact object:
   {
     email:            row[0]?.trim().toLowerCase(),
     firstName:        row[1]?.trim(),
     lastName:         row[2]?.trim() || '',
     company:          row[3]?.trim() || '',
     title:            row[4]?.trim() || '',
     campaignId:       row[5]?.trim(),
     status:           row[6]?.trim().toLowerCase() || 'new',
     lastStepSent:     parseInt(row[7]) || 0,
     lastSendDate:     row[8] || null,
     replyStatus:      row[9] || null,
     replyDate:        row[10] || null,
     replySnippet:     row[11] || '',
     unsubscribed:     row[12]?.toUpperCase() === 'TRUE',
     unsubscribeDate:  row[13] || null,
     unsubscribeSource: row[14] || null,
     bounced:          row[15]?.toUpperCase() === 'TRUE',
     bounceType:       row[16] || null,
     bounceDate:       row[17] || null,
     softBounceCount:  parseInt(row[18]) || 0,
     custom1:          row[19] || '',
     custom2:          row[20] || '',
     notes:            row[21] || '',
     _rowIndex:        index + 2,  // Track row number for updates (1-indexed, +1 for header)
   }

3. Validate each contact:
   - email must be non-empty and contain "@".
   - firstName must be non-empty.
   - campaignId must be non-empty.
   - Invalid contacts are logged with a warning and skipped.

4. Check for duplicate emails. If found, log warning and keep only the first occurrence.

5. Return the array of valid Contact objects.
```

### getCampaigns()

```
1. Call sheets.spreadsheets.values.get({
     spreadsheetId: config.google.spreadsheetId,
     range: 'Campaigns!A2:M',
   })

2. Parse each row into a Campaign object:
   {
     campaignId: row[0]?.trim(),
     campaignName: row[1]?.trim() || '',
     totalSteps: parseInt(row[2]) || 0,
     steps: [
       { stepNumber: 1, templateFile: row[3], subject: row[4], delayDays: parseInt(row[5]) || 0 },
       { stepNumber: 2, templateFile: row[6], subject: row[7], delayDays: parseInt(row[8]) || 0 },
       { stepNumber: 3, templateFile: row[9], subject: row[10], delayDays: parseInt(row[11]) || 0 },
     ].filter(s => s.templateFile),  // Only include steps that have a template defined
     active: row[12]?.toUpperCase() === 'TRUE',
   }

3. Return the array of Campaign objects.
```

### getSendLog()

```
1. Call sheets.spreadsheets.values.get({
     spreadsheetId: config.google.spreadsheetId,
     range: "'Send Log'!A2:H",  // Tab name with space needs quotes
   })

2. Parse into SendLogEntry objects:
   {
     timestamp: row[0],
     contactEmail: row[1]?.trim().toLowerCase(),
     campaignId: row[2]?.trim(),
     step: parseInt(row[3]) || 0,
     status: row[4]?.trim(),
     messageId: row[5] || '',
     errorMessage: row[6] || '',
     templateUsed: row[7] || '',
   }

3. Return the array.
```

---

## Write Operations

### updateContact(email, updates)

```
1. Find the contact's row index using the _rowIndex from getContacts().
   - If building a row map: maintain { email → rowIndex } map after getContacts().

2. Build a list of cell updates:
   Map each field in 'updates' to the corresponding column:
   {
     status:           column G,
     lastStepSent:     column H,
     lastSendDate:     column I,
     replyStatus:      column J,
     replyDate:        column K,
     replySnippet:     column L,
     unsubscribed:     column M,
     unsubscribeDate:  column N,
     unsubscribeSource: column O,
     bounced:          column P,
     bounceType:       column Q,
     bounceDate:       column R,
     softBounceCount:  column S,
   }

3. For each field, call:
   sheets.spreadsheets.values.update({
     spreadsheetId: config.google.spreadsheetId,
     range: `Contacts!${column}${rowIndex}`,
     valueInputOption: 'RAW',
     requestBody: { values: [[value]] },
   })

   OR (better): batch all cell updates into a single batchUpdate call.
```

### batchUpdateContacts(updates)

Uses the Sheets `batchUpdate` API to update multiple cells in a single request, reducing API calls.

```typescript
async function batchUpdateContacts(updates) {
  const data = [];

  for (const { email, updates: fields } of updates) {
    const rowIndex = emailToRowMap.get(email);
    if (!rowIndex) continue;

    for (const [field, value] of Object.entries(fields)) {
      const column = fieldToColumn(field);
      data.push({
        range: `Contacts!${column}${rowIndex}`,
        values: [[value]],
      });
    }
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.google.spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data,
    },
  });
}
```

### appendSendLog(entry)

```
sheets.spreadsheets.values.append({
  spreadsheetId: config.google.spreadsheetId,
  range: "'Send Log'!A:H",
  valueInputOption: 'RAW',
  insertDataOption: 'INSERT_ROWS',
  requestBody: {
    values: [[
      entry.timestamp,
      entry.contactEmail,
      entry.campaignId,
      entry.step,
      entry.status,
      entry.messageId,
      entry.errorMessage,
      entry.templateUsed,
    ]],
  },
});
```

### appendReplyLog(entry)

Same pattern as appendSendLog, targeting the Reply Log tab.

---

## Row Index Tracking

The service maintains an in-memory map of `{ email → rowIndex }` after each `getContacts()` call. This map is used by write operations to target the correct row.

**Important**: The map is rebuilt on every send cycle (because the operator may add or reorder rows). Do NOT cache this map across cycles.

---

## API Rate Limiting

Google Sheets API limits:
- **Read**: 60 requests per minute per user
- **Write**: 60 requests per minute per user
- **Total**: 300 requests per minute per project

At <50 emails/day, a typical send cycle makes:
- 3 reads (Contacts, Campaigns, Send Log) = 3 requests
- 10 writes (update contact + append send log, batched) = ~5 requests
- Total: ~8 requests per cycle

This is well within limits. However, the service should include retry logic for 429 responses:

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.code === 429 && attempt < maxRetries - 1) {
        const delayMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        logger.warn({ attempt, delayMs }, 'Sheets API rate limited, retrying');
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}
```

---

## Error Handling

| Error | Action |
|---|---|
| 401 / 403 — Auth failure | Throw (critical — halts the cycle) |
| 404 — Sheet not found | Throw (critical — wrong spreadsheet ID or tab name) |
| 429 — Rate limited | Retry with exponential backoff (up to 3 times) |
| 500/503 — Server error | Retry once. If still failing, throw. |
| Row not found for update | Log warning, skip update |
| Empty sheet (no data rows) | Return empty array — not an error |

---

## Connection Verification

At application startup, verify Sheets access:

```typescript
async function verifyAccess(): Promise<boolean> {
  try {
    await sheets.spreadsheets.get({
      spreadsheetId: config.google.spreadsheetId,
    });
    logger.info({ module: 'sheets' }, 'Google Sheets connection verified');
    return true;
  } catch (err) {
    logger.error({ module: 'sheets', error: err.message }, 'Google Sheets access failed');
    return false;
  }
}
```
