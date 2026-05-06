/**
 * Unit tests for canonical sheet audit helpers (no Sheets I/O).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findDuplicateCompanyProfileKeys, findIntelCanonicalDrift } from './canonical-sheet-audit.js';
import type { CompanyIntelligence, Contact, StoredCompanyProfile } from '../services/sheets-types.js';

const baseContact = (email: string, companyUrl: string, row: number): Contact => ({
  email,
  firstName: 'A',
  lastName: 'B',
  company: 'C',
  title: 'T',
  campaignId: '',
  status: 'active',
  lastStepSent: 0,
  lastSendDate: null,
  replyStatus: null,
  replyDate: null,
  replySnippet: '',
  unsubscribed: false,
  unsubscribeDate: null,
  unsubscribeSource: null,
  bounced: false,
  bounceType: null,
  bounceDate: null,
  softBounceCount: 0,
  custom1: '',
  custom2: '',
  notes: '',
  companyUrl,
  pipelineStatus: '',
  lastProfileVersionUsedForGeneration: '',
  _rowIndex: row,
});

const baseProfile = (canonical: string, row: number): StoredCompanyProfile => ({
  canonicalCompanyUrl: canonical,
  companyUrl: canonical,
  companyName: 'N',
  industry: '',
  productSummary: '',
  companySize: '',
  signals: '',
  signalSummary: '',
  deatonCapabilitiesMatched: '',
  caseStudiesSelected: '',
  alignmentRationale: '',
  confidenceScore: '',
  pipelineStatus: '',
  researchedDate: '',
  lastRefreshedAt: '',
  profileVersion: '',
  errorLog: '',
  _rowIndex: row,
});

describe('findDuplicateCompanyProfileKeys', () => {
  it('returns empty when all keys unique', () => {
    assert.deepEqual(
      findDuplicateCompanyProfileKeys([
        baseProfile('https://a.com', 2),
        baseProfile('https://b.com', 3),
      ]),
      [],
    );
  });

  it('groups row indices for duplicate column A', () => {
    const dups = findDuplicateCompanyProfileKeys([
      baseProfile('https://x.com', 2),
      baseProfile('https://x.com', 5),
      baseProfile('https://y.com', 3),
    ]);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].canonicalUrl, 'https://x.com');
    assert.deepEqual(dups[0].rowIndices, [2, 5]);
  });
});

describe('findIntelCanonicalDrift', () => {
  it('detects mismatch between intel B and resolved contact company_url', () => {
    const contacts: Contact[] = [baseContact('z@test.com', 'https://right.com', 2)];
    const intel: CompanyIntelligence[] = [
      {
        contactEmail: 'z@test.com',
        canonicalCompanyUrl: 'https://wrong.com',
        companyUrl: '',
        davidProjectNotes: '',
        executiveBrief: '',
        pipelineStatus: '',
        generatedDate: '',
        errorLog: '',
        _rowIndex: 3,
      },
    ];
    const drift = findIntelCanonicalDrift(contacts, intel);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].expectedFromContact, 'https://right.com');
  });
});
