/**
 * Contact spreadsheet import (CSV / TSV pasted or uploaded via admin API).
 *
 * Header-based column mapping only (aliases); reasonable normalization; duplicates
 * and invalid rows are skipped per MVP policy while valid rows continue in file order.
 *
 * Limits: IMPORT_MAX_TEXT_BYTES, IMPORT_MAX_DATA_ROWS — apply before/alongside parse.
 */

import Papa from 'papaparse';
import type { ContactAppendPayload } from './sheets-types.js';

/** Stricter admin import cap than Express global JSON limit. */
export const IMPORT_MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** Max parsed data rows per request (excluding header; empty lines stripped by Papa). */
export const IMPORT_MAX_DATA_ROWS = 10_000;

/** Max row-level diagnostics returned so responses stay bounded. */
const MAX_ERRORS_RETURNED = 100;

/** Sample size for Preview (would-import rows). */
const PREVIEW_ROW_CAP = 5;

/** Delimiter option from API (auto guesses from first line). */
export type ImportDelimiterOption = 'auto' | 'tab' | 'comma';

export type ImportErrorCode =
  | 'INVALID_EMAIL'
  | 'MISSING_EMAIL'
  | 'MISSING_FIRST_NAME'
  | 'INVALID_COMPANY_URL'
  | 'INVALID_ROW'
  | 'DUPLICATE_IN_FILE'
  | 'DUPLICATE_IN_SHEET'
  | 'SHEETS_APPEND_FAILED';

/** One row diagnostic (1-based index into parsed data rows, not worksheet line). */
export type ContactImportIssue = { row: number; code: ImportErrorCode; message: string };

export type ContactImportApiResult = {
  totalRows: number;
  /** Present only after a successful dry-run classification. Rows that would append. */
  wouldImport?: number;
  /** Present only after commit (successful appends only). Omit on dry-run. */
  imported?: number;
  duplicateInFile: number;
  duplicateInSheet: number;
  invalidRows: number;
  /** Rows that threw during Sheets append after validation (partial success path). */
  appendFailed?: number;
  preview?: Array<{ row: number; mapped: ContactAppendPayload }>;
  errors: ContactImportIssue[];
};

/**
 * Normalize a header cell for alias lookup only.
 * Mirrors sheet tab normalization style: NFKC, collapse whitespace, lowercase-style compare.
 */
export function normalizeHeaderLabel(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Alias table: normalized header label → canonical payload field name.
 * First matching column wins when multiple headers compete (handled in map build).
 *
 * Prefer longer / more-specific aliases first by declaring them uniquely in RAW_ALIASES.
 */
const RAW_ALIASES: Record<string, keyof ContactAppendPayload> = {
  // Email
  email: 'email',
  'work email': 'email',
  'e-mail': 'email',
  mail: 'email',
  // Name
  firstname: 'firstName',
  'first name': 'firstName',
  'given name': 'firstName',
  lastname: 'lastName',
  'last name': 'lastName',
  'family name': 'lastName',
  surname: 'lastName',
  // Org / role
  company: 'company',
  'company name': 'company',
  organization: 'company',
  employer: 'company',
  title: 'title',
  'job title': 'title',
  position: 'title',
  role: 'title',
  // URL (generic "url" mapped to company site)
  website: 'companyUrl',
  'website url': 'companyUrl',
  'company url': 'companyUrl',
  url: 'companyUrl',
  campaign: 'campaignId',
  'campaign id': 'campaignId',
  campaignid: 'campaignId',
  companyurl: 'companyUrl',
  custom1: 'custom1',
  custom2: 'custom2',
  notes: 'notes',
  pipelinestatus: 'pipelineStatus',
  'pipeline status': 'pipelineStatus',
  pipeline_status: 'pipelineStatus',
};

function canonicalFieldFromHeader(normalizedHeader: string): keyof ContactAppendPayload | undefined {
  return RAW_ALIASES[normalizedHeader];
}

/** First column wins when two headers alias to same field (left-to-right). */
export function buildHeaderToFieldMap(headersInOrder: string[]): Map<string, keyof ContactAppendPayload> {
  const out = new Map<string, keyof ContactAppendPayload>();
  const consumedFields = new Set<keyof ContactAppendPayload>();
  for (const h of headersInOrder) {
    const field = canonicalFieldFromHeader(normalizeHeaderLabel(h));
    if (!field || consumedFields.has(field)) continue;
    consumedFields.add(field);
    out.set(h, field); // Papa keeps original header string keys on rows
  }
  return out;
}

export function stripUtf8Bom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}

export function inferDelimiter(option: ImportDelimiterOption, text: string): string {
  if (option === 'tab') return '\t';
  if (option === 'comma') return ',';
  const firstLineBreak = /\r\n|\r|\n/.exec(text);
  const head = firstLineBreak ? text.slice(0, firstLineBreak.index) : text;
  return head.includes('\t') ? '\t' : ',';
}

export type ParsedSpreadsheet = {
  rows: Record<string, string | undefined>[];
  headerTitles: string[];
};

/**
 * Parse CSV or TSV (header row, greedy empty skip). Rows are plain string records.
 *
 * Throws on empty text or missing usable header (request-level faults for route to map to 400).
 */
export function parseContactsSpreadsheet(
  spreadsheetText: string,
  delimiterOption: ImportDelimiterOption,
): ParsedSpreadsheet {
  const delim = inferDelimiter(delimiterOption, spreadsheetText);
  const res = Papa.parse<Record<string, string | undefined>>(spreadsheetText, {
    header: true,
    delimiter: delim,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h,
  });

  if (res.errors?.length && res.errors.some((e) => e.type === 'Quotes' || e.type === 'Delimiter')) {
    throw new Error(`CSV parse failed: ${res.errors.map((e) => e.message || e.code).join('; ')}`);
  }

  const rows = res.data ?? [];
  const titles = Array.isArray(res.meta?.fields)
    ? (res.meta.fields as string[])
    : [];

  const headerTitles =
    titles.length > 0
      ? titles
      : rows[0]
        ? Object.keys(rows[0])
        : [];

  if (headerTitles.length === 0 && rows.length === 0) {
    throw new Error('CSV parse produced no header or data rows');
  }

  return { rows, headerTitles };
}

/**
 * Light URL normalization for company URLs: trim; default https://; strip trailing slashes;
 * rejects values that fail `new URL` after normalization (invalid row).

 */
export function normalizeCompanyUrlForImport(raw: string): {
  ok: true;
  value: string;
} | {
  ok: false;
  message: string;
} {
  let s = raw.trim();
  if (!s) return { ok: true, value: '' };
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  try {
    new URL(s);
    return { ok: true, value: s };
  } catch {
    return { ok: false, message: 'companyUrl is not a valid URL after normalization' };
  }
}

/**
 * Build ContactAppendPayload from a parsed row plus header→field map.
 * Applies trim / email lower-case / optional URL normalization and omits empties.

 */
export function recordToAppendPayload(
  record: Record<string, string | undefined>,
  headerToField: Map<string, keyof ContactAppendPayload>,
): { payload: Partial<ContactAppendPayload>; urlIssue?: string } {
  const out: Partial<ContactAppendPayload> = {};
  for (const [header, field] of headerToField) {
    const cell = record[header];
    if (cell === undefined || cell === null) continue;
    const str = String(cell).trim();
    if (!str && field !== 'email' && field !== 'firstName') continue;

    if (field === 'email') out.email = str.toLowerCase();
    else if (field === 'companyUrl') {
      const nv = normalizeCompanyUrlForImport(str);
      if (!nv.ok) return { payload: out, urlIssue: nv.message };
      if (nv.value) out.companyUrl = nv.value;
    } else {
      (out as Record<string, string>)[field] = str;
    }
  }
  return { payload: out };
}

export type PayloadValidationIssue = { code: ImportErrorCode; message: string };

export function validateContactAppendPayload(payload: Partial<ContactAppendPayload>): PayloadValidationIssue | null {
  const email = payload.email?.trim().toLowerCase() ?? '';
  if (!email) return { code: 'MISSING_EMAIL', message: 'email is required' };
  if (!email.includes('@')) return { code: 'INVALID_EMAIL', message: 'email must contain @' };

  const firstName = payload.firstName?.trim() ?? '';
  if (!firstName) return { code: 'MISSING_FIRST_NAME', message: 'firstName is required' };

  return null;
}

/** Turn a partial spreadsheet row into API-ready ContactAppendPayload (narrow type). */

export function narrowAppendPayload(payload: Partial<ContactAppendPayload>): ContactAppendPayload {
  return {
    email: payload.email ?? '',
    firstName: payload.firstName ?? '',
    lastName: payload.lastName?.trim() || undefined,
    company: payload.company?.trim() || undefined,
    title: payload.title?.trim() || undefined,
    campaignId: payload.campaignId?.trim() || undefined,
    custom1: payload.custom1?.trim() || undefined,
    custom2: payload.custom2?.trim() || undefined,
    notes: payload.notes?.trim() || undefined,
    companyUrl: payload.companyUrl?.trim() || undefined,
    pipelineStatus: payload.pipelineStatus?.trim() || undefined,
  };
}

/**
 * Classifies parsed spreadsheet rows against existing sheet emails. Returns payloads to append
 * in stable file order and summary counters aligned with ADMIN_API totals.

 *
 * Duplicate policy: first VALID row wins for an email (invalid rows do not reserve it).
 * After the first valid row for an email — whether appended or skipped as duplicate_in_sheet —
 * later VALID rows become duplicate_in_file.

 */
export function classifyContactImportRows(
  records: Record<string, string | undefined>[],
  headerToField: Map<string, keyof ContactAppendPayload>,
  existingEmailsOnSheetLower: ReadonlySet<string>,
): Pick<
  ContactImportApiResult,
  | 'totalRows'
  | 'duplicateInFile'
  | 'duplicateInSheet'
  | 'invalidRows'
  | 'errors'
  | 'preview'
> & {
  toAppend: Array<{ row: number; mapped: ContactAppendPayload }>;
  wouldAppendCount: number;
} {
  const totalRows = records.length;
  const errors: ContactImportIssue[] = [];
  const pushIssue = (row: number, code: ImportErrorCode, message: string) => {
    if (errors.length < MAX_ERRORS_RETURNED) errors.push({ row, code, message });
  };

  let duplicateInFile = 0;
  let duplicateInSheet = 0;
  let invalidRows = 0;

  const preview: ContactImportApiResult['preview'] = [];
  /** Emails that already had a VALID row processed (ordering lock for duplicate_file). */

  const seenValidEmail = new Set<string>();

  /** Emails known on-sheet or queued in this paste (updates as we classify in file order). */

  const sheetOrQueued = new Set(existingEmailsOnSheetLower);

  /** Rows queued for Sheets append — file order preserved; row = 1-based data row index for errors. */

  const toAppend: Array<{ row: number; mapped: ContactAppendPayload }> = [];

  records.forEach((record, idx) => {
    const rowNumber = idx + 1;

    const { payload: partial, urlIssue } = recordToAppendPayload(record, headerToField);
    if (urlIssue) {
      invalidRows++;
      pushIssue(rowNumber, 'INVALID_COMPANY_URL', urlIssue);
      return;
    }

    const valErr = validateContactAppendPayload(partial);
    if (valErr) {
      invalidRows++;
      pushIssue(rowNumber, valErr.code, valErr.message);
      return;
    }

    const full = narrowAppendPayload(partial);
    const emailNorm = full.email.trim().toLowerCase();

    if (seenValidEmail.has(emailNorm)) {
      duplicateInFile++;
      pushIssue(rowNumber, 'DUPLICATE_IN_FILE', `duplicate email ${emailNorm} later in file`);
      return;
    }
    seenValidEmail.add(emailNorm);

    if (sheetOrQueued.has(emailNorm)) {
      duplicateInSheet++;
      pushIssue(rowNumber, 'DUPLICATE_IN_SHEET', `contact already exists: ${emailNorm}`);
      return;
    }

    sheetOrQueued.add(emailNorm);

    if (preview.length < PREVIEW_ROW_CAP) {
      preview.push({ row: rowNumber, mapped: { ...full } });
    }

    toAppend.push({ row: rowNumber, mapped: full });
  });

  const wouldAppendCount = toAppend.length;

  return {
    totalRows,
    duplicateInFile,
    duplicateInSheet,
    invalidRows,
    errors,
    preview,
    toAppend,
    wouldAppendCount,
  };
}

/**
 * Classify legacy JSON `{ rows }` payloads (camelCase Contact fields).
 * Non-objects become empty records and fail validation row-by-row.
 */
export function classifyJsonRows(
  rows: unknown[],
  existingEmailsOnSheetLower: ReadonlySet<string>,
): Pick<
  ContactImportApiResult,
  'totalRows' | 'duplicateInFile' | 'duplicateInSheet' | 'invalidRows' | 'errors' | 'preview'
> & {
  toAppend: Array<{ row: number; mapped: ContactAppendPayload }>;
  wouldAppendCount: number;
} {
  const pseudoHeaderMap = buildHeaderToFieldMap([
    'email',
    'firstName',
    'lastName',
    'company',
    'title',
    'campaignId',
    'custom1',
    'custom2',
    'notes',
    'companyUrl',
    'pipelineStatus',
  ]);

  const records = rows.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return {};
    }
    const o: Record<string, string | undefined> = {};
    for (const k of Object.keys(r)) {
      const v = (r as Record<string, unknown>)[k];
      if (v === undefined || v === null) continue;
      o[k] = String(v);
    }
    return o;
  });

  return classifyContactImportRows(records, pseudoHeaderMap, existingEmailsOnSheetLower);
}

/**
 * Validates byte size for pasted / uploaded spreadsheet text (request-level).
 */
export function assertImportPayloadUnderByteLimit(span: string, label: string): void {
  const n = Buffer.byteLength(span, 'utf8');
  if (n > IMPORT_MAX_TEXT_BYTES) {
    throw new Error(`PAYLOAD_TOO_LARGE: ${label} exceeds ${IMPORT_MAX_TEXT_BYTES} bytes`);
  }
}

/**
 * Validates JSON-or-array row count ceiling (spreadsheet parsed rows length).
 */
export function assertRowLimit(totalRows: number): void {
  if (totalRows > IMPORT_MAX_DATA_ROWS) {
    throw new Error(`ROW_LIMIT_EXCEEDED: maximum ${IMPORT_MAX_DATA_ROWS} data rows`);
  }
}
