import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collapseHorizontalWhitespaceInPlainText,
  normalizeHtmlBodyHyphens,
  normalizePlainBodyHyphens,
} from './body-hyphen-normalize.js';

describe('normalizePlainBodyHyphens', () => {
  it('removes spaced hyphens used as pauses', () => {
    assert.equal(
      normalizePlainBodyHyphens('Speed matters - especially in NPI.'),
      'Speed matters especially in NPI.',
    );
  });

  it('keeps tight hyphenated compounds', () => {
    assert.equal(
      normalizePlainBodyHyphens('A well-known co-op in Austin-based tooling.'),
      'A well-known co-op in Austin-based tooling.',
    );
  });

  it('keeps hyphenated digit groups and strips pause hyphens nearby', () => {
    assert.equal(
      normalizePlainBodyHyphens('We ran 12-34 builds overnight - all passed.'),
      'We ran 12-34 builds overnight all passed.',
    );
  });

  it('does not mutate URLs that contain hyphens', () => {
    const u = 'https://example.com/foo-bar/doc';
    assert.equal(
      normalizePlainBodyHyphens(`See ${u} for detail - thanks.`),
      `See ${u} for detail thanks.`,
    );
  });

  it('does not mutate email addresses with hyphens', () => {
    assert.equal(
      normalizePlainBodyHyphens('Write team-lead@mail-example.com any time - urgent.'),
      'Write team-lead@mail-example.com any time urgent.',
    );
  });

  it('is a no-op when there is no hyphen', () => {
    assert.equal(normalizePlainBodyHyphens('Hello there.'), 'Hello there.');
  });
});

describe('normalizeHtmlBodyHyphens', () => {
  it('normalizes visible text but leaves tags and href paths intact', () => {
    const html =
      '<p>Plan A - Plan B</p><a href="https://x.com/foo-bar">linky</a><p>end - ok</p>';
    const out = normalizeHtmlBodyHyphens(html);
    assert.ok(out.includes('Plan A Plan B'));
    assert.ok(out.includes('href="https://x.com/foo-bar"'));
    assert.ok(out.includes('end ok'));
  });
});

describe('collapseHorizontalWhitespaceInPlainText', () => {
  it('collapses runs of spaces on a line', () => {
    assert.equal(
      collapseHorizontalWhitespaceInPlainText('a   b'),
      'a b',
    );
  });
});
