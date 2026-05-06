/**
 * Canonical company URL normalization (unit tests — no Sheets).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeCanonicalCompanyUrl } from './normalize-company-url.js';

describe('normalizeCanonicalCompanyUrl', () => {
  it('forces https and strips www', () => {
    assert.equal(normalizeCanonicalCompanyUrl('http://WWW.Example.COM/path/'), 'https://example.com/path');
  });

  it('adds https when scheme missing', () => {
    assert.equal(normalizeCanonicalCompanyUrl('acme.io'), 'https://acme.io');
  });

  it('drops trailing slash on non-root path', () => {
    assert.equal(normalizeCanonicalCompanyUrl('https://x.com/about/'), 'https://x.com/about');
  });

  it('returns empty for blank input', () => {
    assert.equal(normalizeCanonicalCompanyUrl('  '), '');
  });

  it('returns empty for unparseable URL (invalid host)', () => {
    assert.equal(normalizeCanonicalCompanyUrl('https://'), '');
    assert.equal(normalizeCanonicalCompanyUrl('not a url at all !!!'), '');
  });
});
