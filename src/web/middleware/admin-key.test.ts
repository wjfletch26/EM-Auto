/**
 * Unit tests for admin API key header parsing.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { IncomingHttpHeaders } from 'node:http';
import { extractAdminKeyFromHeaders } from './admin-key.js';

describe('extractAdminKeyFromHeaders', () => {
  it('returns Bearer token when Authorization is Bearer', () => {
    const headers: IncomingHttpHeaders = { authorization: 'Bearer my-secret-token' };
    assert.strictEqual(extractAdminKeyFromHeaders(headers), 'my-secret-token');
  });

  it('is case-insensitive for Bearer prefix', () => {
    const headers: IncomingHttpHeaders = { authorization: 'bearer abc' };
    assert.strictEqual(extractAdminKeyFromHeaders(headers), 'abc');
  });

  it('falls back to X-Admin-Key when no Bearer token', () => {
    const headers: IncomingHttpHeaders = { 'x-admin-key': 'fallback-key' };
    assert.strictEqual(extractAdminKeyFromHeaders(headers), 'fallback-key');
  });

  it('prefers Bearer over X-Admin-Key when both present', () => {
    const headers: IncomingHttpHeaders = {
      authorization: 'Bearer from-bearer',
      'x-admin-key': 'from-header',
    };
    assert.strictEqual(extractAdminKeyFromHeaders(headers), 'from-bearer');
  });

  it('returns empty string when missing', () => {
    assert.strictEqual(extractAdminKeyFromHeaders({}), '');
  });
});
