import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { replaceGreetingLineBreak, validateAndNormalizeAIDraft } from './send-engine.js';

describe('validateAndNormalizeAIDraft', () => {
  it('uses queue subject/body when present', () => {
    const result = validateAndNormalizeAIDraft(
      'Queue Subject',
      'Line 1\n\nLine 2',
      'Fallback Subject',
      'Thomas',
    );
    assert.equal(result.ok, true);
    assert.equal(result.subject, 'Queue Subject');
    assert.equal(result.bodyPlain, 'Line 1\n\nLine 2');
  });

  it('normalizes em dash in subject and strips punctuation hyphens in body', () => {
    const result = validateAndNormalizeAIDraft(
      `Hello\u2014there`,
      `Body\u2015text`,
      'Fallback',
      'Thomas',
    );
    assert.equal(result.ok, true);
    assert.equal(result.subject, 'Hello - there');
    // Long dash becomes spaced hyphen, then body cleanup drops pause hyphens (not word links).
    assert.equal(result.bodyPlain, 'Body text');
  });

  it('falls back to campaign step subject when queue subject is blank', () => {
    const result = validateAndNormalizeAIDraft(
      '  ',
      'Body text',
      'Step Subject',
      'Thomas',
    );
    assert.equal(result.ok, true);
    assert.equal(result.subject, 'Step Subject');
  });

  it('rejects when both queue and fallback subjects are blank', () => {
    const result = validateAndNormalizeAIDraft(
      '   ',
      'Body text',
      '   ',
      'Thomas',
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'blank_subject');
  });

  it('rejects when body becomes empty after signoff cleanup', () => {
    const result = validateAndNormalizeAIDraft(
      'Subject',
      'Best,\n[Your Name]\nDeaton Engineering',
      'Fallback Subject',
      'Thomas',
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'blank_body');
  });
});

describe('replaceGreetingLineBreak', () => {
  it('puts greeting name on its own line', () => {
    const out = replaceGreetingLineBreak(
      'Thomas, Boom\'s Superfactory targets 66 aircraft/year.',
      'Thomas',
    );
    assert.equal(out, 'Thomas,\n\nBoom\'s Superfactory targets 66 aircraft/year.');
  });

  it('leaves non-matching greeting unchanged', () => {
    const out = replaceGreetingLineBreak('Hi there team, quick note.', 'Thomas');
    assert.equal(out, 'Hi there team, quick note.');
  });

  it('falls back to generic name greeting when firstName does not match', () => {
    const out = replaceGreetingLineBreak(
      'Simon, Deaton Engineering helps robotics firms.',
      'Thomas',
    );
    assert.equal(out, 'Simon,\n\nDeaton Engineering helps robotics firms.');
  });

  it('keeps multiple paragraphs after the greeting when splitting', () => {
    const out = replaceGreetingLineBreak(
      'Jason, Boom momentum intro.\n\nRole tie-in.\n\nDeaton proof.\n\nHappy to share more.',
      'Jason',
    );
    assert.equal(
      out,
      'Jason,\n\nBoom momentum intro.\n\nRole tie-in.\n\nDeaton proof.\n\nHappy to share more.',
    );
  });
});
