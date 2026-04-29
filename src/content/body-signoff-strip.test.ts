import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripTrailingInformalSignoff } from './body-signoff-strip.js';

describe('stripTrailingInformalSignoff', () => {
  it('removes Best / placeholder / company tail', () => {
    const body = 'Hello Jason,\n\nHere is the pitch.\n\nBest,\n[Your Name]\nDeaton Engineering';
    assert.equal(stripTrailingInformalSignoff(body), 'Hello Jason,\n\nHere is the pitch.');
  });

  it('does not strip when Deaton Engineering is part of a real sentence', () => {
    const body = 'We partner with teams at Deaton Engineering clients often.';
    assert.equal(stripTrailingInformalSignoff(body), body);
  });

  it('handles only sign-off block', () => {
    assert.equal(stripTrailingInformalSignoff('Best,\n\n[Your Name]\nDeaton Engineering'), '');
  });
});
