import test from 'node:test';
import assert from 'node:assert/strict';
import { runHardEmailQC, mergeHardQCIntoReview } from './email-hard-qc.js';
import type { QualityReview } from '../skills/quality-reviewer.js';
import { clearCaseStudyMetadataCache } from '../skills/case-study-metadata.js';

test('runHardEmailQC passes clean email without dashes or forbidden studies', () => {
  clearCaseStudyMetadataCache();
  const r = runHardEmailQC({
    emails: [{ step: 1, subject: 'Hello there', body: 'Short note about your facility in Austin.' }],
    allowlistedCaseStudyIds: [],
    davidProjectNotes: '',
  });
  assert.equal(r.pass, true);
  assert.equal(r.globalFlags.length, 0);
});

test('runHardEmailQC flags em dash', () => {
  const r = runHardEmailQC({
    emails: [{ step: 1, subject: 'Hi', body: `We build systems\u2014fast.` }],
    allowlistedCaseStudyIds: [],
    davidProjectNotes: '',
  });
  assert.equal(r.pass, false);
  assert.ok((r.issuesByStep.get(1) ?? []).some((m) => m.includes('U+2014')));
});

test('runHardEmailQC flags horizontal bar (U+2015)', () => {
  const r = runHardEmailQC({
    emails: [{ step: 1, subject: 'Hi', body: `We build systems\u2015fast.` }],
    allowlistedCaseStudyIds: [],
    davidProjectNotes: '',
  });
  assert.equal(r.pass, false);
  assert.ok((r.issuesByStep.get(1) ?? []).some((m) => m.includes('U+2015')));
});

test('runHardEmailQC allows en dash inside numeric range only', () => {
  const r = runHardEmailQC({
    emails: [{ step: 1, subject: 'Range', body: 'We tested 12\u201334 units overnight.' }],
    allowlistedCaseStudyIds: [],
    davidProjectNotes: '',
  });
  assert.equal(r.pass, true);
});

test('runHardEmailQC flags en dash outside numeric range', () => {
  const r = runHardEmailQC({
    emails: [{ step: 1, subject: 'Hi', body: 'Partnership\u2013first mindset.' }],
    allowlistedCaseStudyIds: [],
    davidProjectNotes: '',
  });
  assert.equal(r.pass, false);
});

test('runHardEmailQC requires David notes anchor when notes are long enough', () => {
  const notes = 'Customer asked for a stainless washdown conveyor by March.';
  const rFail = runHardEmailQC({
    emails: [{ step: 1, subject: 'Hi', body: 'Generic outreach without the anchor phrase.' }],
    allowlistedCaseStudyIds: [],
    davidProjectNotes: notes,
  });
  assert.equal(rFail.pass, false);
  assert.ok(rFail.globalFlags.some((f) => f.includes('David project notes')));

  const rOk = runHardEmailQC({
    emails: [{ step: 1, subject: 'Hi', body: `Following up: ${notes}` }],
    allowlistedCaseStudyIds: [],
    davidProjectNotes: notes,
  });
  assert.equal(rOk.pass, true);
});

test('runHardEmailQC flags on-site engineer promises when HQ outside Texas Triangle', () => {
  const r = runHardEmailQC({
    emails: [
      {
        step: 9,
        subject: 'Geo',
        body: 'Central Texas logistics lets us support you whether sending engineers for on-site commissioning or shipments.',
      },
    ],
    allowlistedCaseStudyIds: [],
    davidProjectNotes: '',
    headquarters: 'San Francisco, CA',
  });
  assert.equal(r.pass, false);
  assert.ok((r.issuesByStep.get(9) ?? []).some((m) => m.includes('Texas Triangle')));
});

test('runHardEmailQC allows same copy when HQ is Texas Triangle–proximal', () => {
  const r = runHardEmailQC({
    emails: [
      {
        step: 9,
        subject: 'Geo',
        body: 'We can send engineers for on-site commissioning when helpful.',
      },
    ],
    allowlistedCaseStudyIds: [],
    davidProjectNotes: '',
    headquarters: 'Austin, TX',
  });
  assert.equal(r.pass, true);
});

test('mergeHardQCIntoReview merges step issues and flags', () => {
  const qc: QualityReview = {
    overall_pass: true,
    overall_score: 'high',
    overall_notes: 'ok',
    email_reviews: [{ step: 1, pass: true, issues: [], suggestion: null }],
    flags: [],
  };
  const hard = {
    pass: false,
    issuesByStep: new Map<number, string[]>([[1, ['Dash problem']]]),
    globalFlags: ['David notes missing'],
  };
  const merged = mergeHardQCIntoReview(qc, hard);
  assert.equal(merged.overall_pass, false);
  assert.equal(merged.flags.length, 1);
  assert.equal(merged.email_reviews[0].pass, false);
  assert.ok(merged.email_reviews[0].issues.some((i) => i.includes('Hard QC')));
});
