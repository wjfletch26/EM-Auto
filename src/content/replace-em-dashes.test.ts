import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { replaceEmDashesWithPlainHyphen } from './replace-em-dashes.js';

describe('replaceEmDashesWithPlainHyphen', () => {
  it('replaces em dash with spaced hyphen', () => {
    assert.equal(
      replaceEmDashesWithPlainHyphen('Alpha — beta'),
      'Alpha - beta',
    );
  });

  it('handles multiple em dashes', () => {
    assert.equal(
      replaceEmDashesWithPlainHyphen('A — B — C'),
      'A - B - C',
    );
  });

  it('leaves normal hyphens and text unchanged', () => {
    assert.equal(replaceEmDashesWithPlainHyphen('co-op'), 'co-op');
  });
});
