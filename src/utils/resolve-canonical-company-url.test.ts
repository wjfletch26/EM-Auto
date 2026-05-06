/**
 * resolveCanonicalCompanyUrl — alias allowlist + normalization (unit tests).
 */

import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  resolveCanonicalCompanyUrl,
  __resetCanonicalAliasCacheForTests,
  __setCanonicalAliasMapForTests,
} from './resolve-canonical-company-url.js';

describe('resolveCanonicalCompanyUrl', () => {
  afterEach(() => {
    __resetCanonicalAliasCacheForTests();
  });

  it('matches normalize when no alias applies', () => {
    assert.equal(resolveCanonicalCompanyUrl('https://EXAMPLE.COM/'), 'https://example.com');
  });

  it('applies injected allowlisted alias', () => {
    __setCanonicalAliasMapForTests(
      new Map([['https://alias-from.example'.toLowerCase(), 'https://alias-to.example/path']]),
    );
    assert.equal(resolveCanonicalCompanyUrl('http://www.alias-from.example'), 'https://alias-to.example/path');
  });
});
