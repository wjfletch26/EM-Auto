/**
 * Unit tests for spreadsheet contact import (pure logic; no Google Sheets).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertImportPayloadUnderByteLimit,
  assertRowLimit,
  buildHeaderToFieldMap,
  classifyContactImportRows,
  classifyJsonRows,
  inferDelimiter,
  normalizeHeaderLabel,
  parseContactsSpreadsheet,
  stripUtf8Bom,
  IMPORT_MAX_DATA_ROWS,
  IMPORT_MAX_TEXT_BYTES,
} from './contact-sheet-import.js';

describe('normalizeHeaderLabel', () => {
  it('NFKC trim and lowercases with collapsed spaces', () => {
    assert.equal(normalizeHeaderLabel('  Work\u00a0 Email '), 'work email');
    assert.equal(normalizeHeaderLabel('First  Name'), 'first name');
  });
});

describe('inferDelimiter', () => {
  it('uses tab when header line contains tab', () => {
    assert.equal(inferDelimiter('auto', 'Email\tName'), '\t');
    assert.equal(inferDelimiter('auto', 'a,b\nc,d'), ',');
  });
  it('respects explicit delimiter', () => {
    assert.equal(inferDelimiter('tab', 'a,b'), '\t');
    assert.equal(inferDelimiter('comma', 'a\tb'), ',');
  });
});

describe('parseContactsSpreadsheet', () => {
  it('parses CSV headers with aliases and trims rows', () => {
    const csv = 'Work Email, First Name, Company\n  A@EXAMPLE.COM , Ann , Acme ';
    const { rows, headerTitles } = parseContactsSpreadsheet(csv, 'comma');
    assert.equal(headerTitles[0], 'Work Email');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['Work Email'], '  A@EXAMPLE.COM ');
  });

  it('parses tab-separated values', () => {
    const tsv = 'email\tfirstName\nx@y.com\tXu';
    const { rows } = parseContactsSpreadsheet(tsv, 'tab');
    assert.equal(rows.length, 1);
  });

  it('strips BOM when caller passes stripped text (router strips before parse)', () => {
    const raw = stripUtf8Bom('\ufeffEmail,firstName\nz@z.com,Zed');
    const { rows } = parseContactsSpreadsheet(raw, 'comma');
    assert.equal(rows.length, 1);
  });
});

describe('buildHeaderToFieldMap', () => {
  it('first alias column wins for duplicates', () => {
    const map = buildHeaderToFieldMap(['Mail', 'Email', 'Company']);
    assert.equal(map.get('Mail'), 'email');
    assert.equal(map.get('Email'), undefined);
  });
});

describe('classifyContactImportRows', () => {
  it('imports first valid row when an earlier row for same email was invalid', () => {
    const headers = buildHeaderToFieldMap(['email', 'firstName']);
    const records = [
      { email: 'john@x.com', firstName: '' },
      { email: 'john@x.com', firstName: 'John' },
    ];
    const sheet = new Set<string>();
    const r = classifyContactImportRows(records, headers, sheet);
    assert.equal(r.totalRows, 2);
    assert.equal(r.invalidRows, 1);
    assert.equal(r.duplicateInFile, 0);
    assert.equal(r.wouldAppendCount, 1);
    assert.equal(r.toAppend[0]?.mapped.firstName, 'John');
  });

  it('marks second valid duplicate email in file', () => {
    const headers = buildHeaderToFieldMap(['email', 'firstName']);
    const records = [
      { email: 'a@b.com', firstName: 'A' },
      { email: 'a@b.com', firstName: 'B' },
    ];
    const r = classifyContactImportRows(records, headers, new Set());
    assert.equal(r.wouldAppendCount, 1);
    assert.equal(r.duplicateInFile, 1);
  });

  it('skips when email already on sheet', () => {
    const headers = buildHeaderToFieldMap(['email', 'firstName']);
    const records = [{ email: 'n@n.com', firstName: 'N' }];
    const r = classifyContactImportRows(records, headers, new Set(['n@n.com']));
    assert.equal(r.duplicateInSheet, 1);
    assert.equal(r.wouldAppendCount, 0);
  });
});

describe('classifyJsonRows', () => {
  it('handles camelCase keys like API rows', () => {
    const rows = [{ email: 'j@j.com', firstName: 'Jay' }];
    const r = classifyJsonRows(rows, new Set());
    assert.equal(r.wouldAppendCount, 1);
    assert.equal(r.toAppend[0]?.mapped.email, 'j@j.com');
  });
});

describe('import limits', () => {
  it('throws ROW_LIMIT_EXCEEDED', () => {
    assert.throws(() => assertRowLimit(IMPORT_MAX_DATA_ROWS + 1), /ROW_LIMIT_EXCEEDED/);
  });

  it('throws PAYLOAD_TOO_LARGE', () => {
    const buf = 'x'.repeat(IMPORT_MAX_TEXT_BYTES + 2);
    assert.throws(() => assertImportPayloadUnderByteLimit(buf, 'test'), /PAYLOAD_TOO_LARGE/);
  });
});
