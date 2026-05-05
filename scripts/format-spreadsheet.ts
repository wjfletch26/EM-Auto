/**
 * Applies readability formatting to Google Sheets tabs used by this project:
 * - Freeze row 1
 * - Bold header row, wrap text, taller header row, high-contrast header colors
 * - Auto-resize column widths (helps header text fit)
 * - Turn on a filter on row 1 across the tab’s column span
 * - Light highlight on columns humans usually edit (automation columns stay neutral)
 *
 * Run (uses .env for GOOGLE_SERVICE_ACCOUNT_PATH and GOOGLE_SPREADSHEET_ID):
 *   npx tsx scripts/format-spreadsheet.ts
 *   By default this formats every tab whose name matches this project (Contacts, Campaigns, …).
 *
 * Target one tab by URL gid (the number after #gid=):
 *   npx tsx scripts/format-spreadsheet.ts --gid 867043218
 *
 * Override spreadsheet ID (e.g. if different from .env):
 *   npx tsx scripts/format-spreadsheet.ts --spreadsheet-id <id> --gid 867043218
 *
 * Format every tab we know about (by exact title):
 *   npx tsx scripts/format-spreadsheet.ts --all-known-tabs
 */

import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './credentials/service-account.json';

/** Default spreadsheet from env; override with --spreadsheet-id */
let spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID || '';

/** How far down to paint “user column” fills and filter range (large but bounded). */
const DATA_ROW_END = 10000;

/**
 * Per-tab layout: total columns (A=1 → count) and 0-based column indices for body rows
 * that operators typically edit. Log tabs are usually view-only — no extra tint.
 *
 * Contacts: identity + campaign (A–F), custom/notes/url (T–W), pipeline (X) is often set by humans to start flows.
 * Campaigns: entire row is configured by humans.
 * Company Intelligence: email/url often sourced manually; david notes + pipeline are common human edits.
 * Review Queue: approval workflow touches status, reviewer notes, approved date, campaign id.
 */
const SHEET_LAYOUTS: Record<
  string,
  { colCount: number; userBodyColumnIndices: number[] }
> = {
  Contacts: {
    colCount: 24,
    userBodyColumnIndices: [0, 1, 2, 3, 4, 5, 19, 20, 21, 22, 23],
  },
  Campaigns: {
    colCount: 41,
    userBodyColumnIndices: Array.from({ length: 41 }, (_, i) => i),
  },
  'Send Log': { colCount: 8, userBodyColumnIndices: [] },
  'Reply Log': { colCount: 6, userBodyColumnIndices: [] },
  'Company Profiles': {
    colCount: 17,
    userBodyColumnIndices: [1, 15, 16],
  },
  'Company Intelligence': {
    colCount: 8,
    userBodyColumnIndices: [0, 1, 2, 3, 5],
  },
  'Review Queue': {
    colCount: 16,
    userBodyColumnIndices: [6, 7, 9, 10, 11, 12, 13, 14, 15],
  },
  'QC Regen Audit': { colCount: 13, userBodyColumnIndices: [] },
};

/** Header row: dark blue background, white bold text, wrapped and centered. */
const HEADER_FORMAT = {
  backgroundColor: { red: 0.12, green: 0.31, blue: 0.48 },
  horizontalAlignment: 'CENTER' as const,
  verticalAlignment: 'MIDDLE' as const,
  wrapStrategy: 'WRAP' as const,
  textFormat: {
    bold: true,
    foregroundColor: { red: 1, green: 1, blue: 1 },
    fontSize: 10,
  },
};

/** Body cells in “human edit” columns: soft yellow so they stand out from automation columns. */
const USER_BODY_FILL = {
  backgroundColor: { red: 1, green: 0.97, blue: 0.85 },
};

function parseArgs(): { gid?: number; allKnown: boolean } {
  const argv = process.argv.slice(2);
  let gid: number | undefined;
  // When no --gid is passed, format all tabs we know by name (Deaton outreach model).
  let allKnown = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gid' && argv[i + 1]) {
      const n = parseInt(argv[i + 1], 10);
      if (Number.isNaN(n)) {
        console.error(`Invalid --gid value: ${argv[i + 1]}`);
        process.exit(1);
      }
      gid = n;
      i++;
    } else if (argv[i] === '--spreadsheet-id' && argv[i + 1]) {
      spreadsheetId = argv[i + 1];
      i++;
    } else if (argv[i] === '--all-known-tabs') {
      allKnown = true;
    } else if (argv[i] === '--first-sheet-only') {
      allKnown = false;
    }
  }
  if (gid !== undefined && !Number.isNaN(gid)) {
    allKnown = false;
  }
  return { gid, allKnown };
}

/** Resolve column count for a sheet: prefer our layout table, else grid metadata. */
function columnCountForSheet(
  title: string,
  gridColumnCount?: number | null,
): number {
  const known = SHEET_LAYOUTS[title];
  if (known) return known.colCount;
  if (gridColumnCount && gridColumnCount > 0) return gridColumnCount;
  return 26;
}

function userColumnsForSheet(title: string): number[] {
  return SHEET_LAYOUTS[title]?.userBodyColumnIndices ?? [];
}

async function main() {
  const { gid, allKnown } = parseArgs();

  if (!spreadsheetId) {
    console.error('Missing GOOGLE_SPREADSHEET_ID (or pass --spreadsheet-id).');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetList = meta.data.sheets || [];

  const targets = sheetList.filter((s) => {
    const sid = s.properties?.sheetId;
    const title = s.properties?.title || '';
    if (gid !== undefined && !Number.isNaN(gid)) {
      return sid === gid;
    }
    if (allKnown) {
      return Object.prototype.hasOwnProperty.call(SHEET_LAYOUTS, title);
    }
    // Explicit opt-in: format only the first sheet in document order.
    return sheetList.indexOf(s) === 0;
  });

  if (targets.length === 0) {
    console.error(
      gid !== undefined
        ? `No sheet found with sheetId (gid) ${gid}. Check the URL #gid= value.`
        : 'No sheets to format.',
    );
    process.exit(1);
  }

  for (const sheet of targets) {
    const sheetId = sheet.properties?.sheetId;
    const title = sheet.properties?.title || 'Sheet';
    if (sheetId === undefined || sheetId === null) continue;

    const colCount = columnCountForSheet(
      title,
      sheet.properties?.gridProperties?.columnCount,
    );
    const userCols = userColumnsForSheet(title);

    const requests: object[] = [];

    // Freeze the header row so labels stay visible while scrolling.
    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 1 },
        },
        fields: 'gridProperties.frozenRowCount',
      },
    });

    // Give the header row enough height so wrapped labels are readable.
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: 0,
          endIndex: 1,
        },
        properties: { pixelSize: 72 },
        fields: 'pixelSize',
      },
    });

    // Style the entire header row (wrap + contrast).
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        cell: { userEnteredFormat: HEADER_FORMAT },
        fields:
          'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)',
      },
    });

    // Highlight operator-edited columns from data row 2 downward (row index 1+).
    for (const c of userCols) {
      if (c < 0 || c >= colCount) continue;
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: DATA_ROW_END,
            startColumnIndex: c,
            endColumnIndex: c + 1,
          },
          cell: { userEnteredFormat: USER_BODY_FILL },
          fields: 'userEnteredFormat.backgroundColor',
        },
      });
    }

    // Filter dropdowns on row 1 across all modeled columns.
    requests.push({
      setBasicFilter: {
        filter: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: DATA_ROW_END,
            startColumnIndex: 0,
            endColumnIndex: colCount,
          },
        },
      },
    });

    // Widen columns from header/content so text fits better than default.
    requests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: colCount,
        },
      },
    });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });

    console.log(`Formatted sheet "${title}" (sheetId=${sheetId}, columns=${colCount}).`);
  }

  console.log('\nDone. Open the spreadsheet to review.');
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
}

main().catch((err: Error) => {
  console.error('format-spreadsheet failed:', err.message);
  process.exit(1);
});
