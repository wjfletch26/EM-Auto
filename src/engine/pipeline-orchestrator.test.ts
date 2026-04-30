import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasExistingUnloadedSequence,
  normalizeGreetingBody,
  normalizeGeneratedSubject,
} from './pipeline-orchestrator.js';
import type { ReviewQueueEntry } from '../services/sheets-types.js';

function makeQueueRow(step: number, overrides: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry {
  return {
    contactEmail: 'person@example.com',
    companyName: 'Acme',
    stepNumber: step,
    emailPurpose: `Purpose ${step}`,
    subject: `Subject ${step}`,
    body: `Body ${step}`,
    status: 'pending_review',
    reviewerNotes: '',
    generatedDate: '2026-01-01T00:00:00.000Z',
    approvedDate: '',
    campaignId: '',
    _rowIndex: step + 1,
    ...overrides,
  };
}

describe('hasExistingUnloadedSequence', () => {
  it('returns true when all 12 unsent steps exist', () => {
    const queue = Array.from({ length: 12 }, (_v, i) => makeQueueRow(i + 1));
    assert.equal(hasExistingUnloadedSequence('person@example.com', queue), true);
  });

  it('returns false when step set is incomplete', () => {
    const queue = Array.from({ length: 11 }, (_v, i) => makeQueueRow(i + 1));
    assert.equal(hasExistingUnloadedSequence('person@example.com', queue), false);
  });

  it('ignores superseded and already-assigned rows', () => {
    const queue = Array.from({ length: 12 }, (_v, i) => makeQueueRow(i + 1, { status: 'superseded' }));
    assert.equal(hasExistingUnloadedSequence('person@example.com', queue), false);

    const assigned = Array.from({ length: 12 }, (_v, i) => makeQueueRow(i + 1, { campaignId: 'ai_x' }));
    assert.equal(hasExistingUnloadedSequence('person@example.com', assigned), false);
  });
});

describe('normalizeGeneratedSubject', () => {
  it('keeps non-empty subject', () => {
    assert.equal(
      normalizeGeneratedSubject('Real subject', 'Intro', 1, 'Acme'),
      'Real subject',
    );
  });

  it('replaces blank subject with purpose/company fallback', () => {
    const out = normalizeGeneratedSubject('   ', 'Introduction', 1, 'Acme');
    assert.match(out, /Introduction - Acme/);
  });

  it('replaces "(no subject)" placeholder with generated fallback', () => {
    const out = normalizeGeneratedSubject('(no subject)', '', 4, 'Acme');
    assert.match(out, /Quick question about Acme/);
  });
});

describe('normalizeGreetingBody', () => {
  it('splits exact first-name greeting onto its own line', () => {
    const out = normalizeGreetingBody(
      'Simon, scaling Nimble\'s AI robots to a national network.',
      'Simon',
    );
    assert.equal(out, 'Simon,\n\nscaling Nimble\'s AI robots to a national network.');
  });

  it('splits generic greeting even when first name differs', () => {
    const out = normalizeGreetingBody(
      'Jkndra, transitioning wind tunnel prototypes to production.',
      'Thomas',
    );
    assert.equal(out, 'Jkndra,\n\ntransitioning wind tunnel prototypes to production.');
  });
});
