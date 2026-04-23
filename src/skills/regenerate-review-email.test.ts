import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQcRemediation, validateRegenParams } from './regenerate-review-email.js';

test('buildQcRemediation caps issues and preserves one suggestion', () => {
  const issues = Array.from({ length: 10 }, (_, i) => `Issue ${i + 1}`);
  const out = buildQcRemediation(issues, 'Fix with concise proof and preserve CTA');
  assert.match(out, /Issues:/);
  assert.match(out, /1\. Issue 1/);
  assert.doesNotMatch(out, /Issue 7/);
  assert.match(out, /Suggested direction:/);
});

test('validateRegenParams rejects user notes in auto_qc mode', () => {
  assert.throws(
    () => validateRegenParams({
      regenMode: 'auto_qc',
      companyProfile: {} as never,
      alignment: {} as never,
      contact: {} as never,
      personaTitle: 'VP',
      stepNumber: 1,
      stepPurpose: 'Intro',
      originalEmail: { subject: 'a', body: 'b' },
      otherEmails: [],
      davidProjectNotes: '',
      qcRemediation: 'fix',
      userNotes: 'forbidden',
    } as never),
    /cannot accept user notes/,
  );
});
