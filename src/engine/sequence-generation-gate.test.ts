/**
 * Upstream sequence generation gate (unit tests — no Sheets).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateSequenceGenerationGate } from './sequence-generation-gate.js';
import type { Contact, StoredCompanyProfile } from '../services/sheets-types.js';

const baseContact = (url: string): Contact => ({
  email: 'a@b.com',
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
  companyUrl: url,
  pipelineStatus: 'alignment_complete',
  lastProfileVersionUsedForGeneration: '',
  _rowIndex: 2,
});

const baseStored = (over: Partial<StoredCompanyProfile> = {}): StoredCompanyProfile => ({
  canonicalCompanyUrl: 'https://co.com',
  companyUrl: 'https://co.com',
  companyName: 'Co',
  industry: 'i',
  productSummary: 'p',
  companySize: '',
  signals: '[]',
  signalSummary: 'sig',
  deatonCapabilitiesMatched: 'cap',
  caseStudiesSelected: 'cs1',
  alignmentRationale: '',
  confidenceScore: 'high',
  pipelineStatus: 'alignment_complete',
  researchedDate: '',
  lastRefreshedAt: '',
  profileVersion: '1',
  errorLog: '',
  _rowIndex: 3,
  ...over,
});

const gateDefaults = {
  minAlignmentConfidence: 'medium' as const,
  blockOnEmptyCaseStudies: true,
  requireProductSummary: false,
  requireSignalSummary: false,
  requireParsableSignalsJson: false,
};

describe('evaluateSequenceGenerationGate', () => {
  it('passes when profile is alignment_complete and meets confidence', () => {
    const r = evaluateSequenceGenerationGate(
      baseContact('https://co.com'),
      baseStored(),
      'https://co.com',
      new Set(),
      gateDefaults,
    );
    assert.equal(r.ok, true);
  });

  it('fails DUPLICATE_COMPANY_PROFILE_KEY when canonical in duplicate set', () => {
    const r = evaluateSequenceGenerationGate(
      baseContact('https://co.com'),
      baseStored(),
      'https://co.com',
      new Set(['https://co.com']),
      gateDefaults,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reasonCode, 'DUPLICATE_COMPANY_PROFILE_KEY');
  });

  it('fails LOW_ALIGNMENT_CONFIDENCE when below minimum', () => {
    const r = evaluateSequenceGenerationGate(
      baseContact('https://co.com'),
      baseStored({ confidenceScore: 'low' }),
      'https://co.com',
      new Set(),
      gateDefaults,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reasonCode, 'LOW_ALIGNMENT_CONFIDENCE');
  });

  it('fails MISSING_CASE_STUDY_SELECTION when case studies empty and block enabled', () => {
    const r = evaluateSequenceGenerationGate(
      baseContact('https://co.com'),
      baseStored({ caseStudiesSelected: '' }),
      'https://co.com',
      new Set(),
      gateDefaults,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reasonCode, 'MISSING_CASE_STUDY_SELECTION');
  });

  it('fails INVALID_CANONICAL_URL when contact company_url empty', () => {
    const r = evaluateSequenceGenerationGate(
      baseContact(''),
      baseStored(),
      'https://co.com',
      new Set(),
      { ...gateDefaults, blockOnEmptyCaseStudies: false },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reasonCode, 'INVALID_CANONICAL_URL');
  });

  it('fails NO_FIT when company profile is no_fit', () => {
    const r = evaluateSequenceGenerationGate(
      baseContact('https://co.com'),
      baseStored({ pipelineStatus: 'no_fit' }),
      'https://co.com',
      new Set(),
      { ...gateDefaults, blockOnEmptyCaseStudies: false },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reasonCode, 'NO_FIT');
  });

  it('fails COMPANY_PROFILE_NOT_READY when pipeline researched only', () => {
    const r = evaluateSequenceGenerationGate(
      baseContact('https://co.com'),
      baseStored({ pipelineStatus: 'researched' }),
      'https://co.com',
      new Set(),
      { ...gateDefaults, blockOnEmptyCaseStudies: false },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reasonCode, 'COMPANY_PROFILE_NOT_READY');
  });
});
