/**
 * Unit tests for upstream gate dashboard rollups (no Sheets).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildUpstreamHealthSnapshot } from './dashboard-upstream-health.js';

const baseIntel = {
  davidProjectNotes: '',
  executiveBrief: '',
  pipelineStatus: '',
  generatedDate: '',
};

describe('buildUpstreamHealthSnapshot', () => {
  it('aggregates blocked contacts by reason and canonical', () => {
    const snap = buildUpstreamHealthSnapshot(
      [
        {
          firstName: 'A',
          lastName: 'B',
          company: 'C',
          title: 'T',
          email: 'u1@co.com',
          campaignId: '1',
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
          companyUrl: 'https://co.com',
          pipelineStatus: 'company_intelligence_blocked',
          lastProfileVersionUsedForGeneration: '',
          _rowIndex: 2,
        },
        {
          firstName: 'A',
          lastName: 'B',
          company: 'C',
          title: 'T',
          email: 'u2@co.com',
          campaignId: '1',
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
          companyUrl: 'https://co.com',
          pipelineStatus: 'company_intelligence_blocked',
          lastProfileVersionUsedForGeneration: '',
          _rowIndex: 3,
        },
      ],
      [
        {
          contactEmail: 'u1@co.com',
          canonicalCompanyUrl: 'https://co.com',
          companyUrl: 'https://co.com',
          ...baseIntel,
          errorLog: '[UPSTREAM_GATE] code=LOW_ALIGNMENT_CONFIDENCE medium score',
          _rowIndex: 10,
        },
        {
          contactEmail: 'u2@co.com',
          canonicalCompanyUrl: 'https://co.com',
          companyUrl: 'https://co.com',
          ...baseIntel,
          errorLog: '[UPSTREAM_GATE] code=DUPLICATE_COMPANY_PROFILE_KEY merge rows',
          _rowIndex: 11,
        },
      ],
      [
        {
          canonicalCompanyUrl: 'https://co.com',
          companyUrl: 'https://co.com',
          companyName: 'Co',
          industry: '',
          productSummary: 'p',
          companySize: '',
          signals: '[]',
          signalSummary: 's',
          deatonCapabilitiesMatched: '',
          caseStudiesSelected: 'cs',
          alignmentRationale: '',
          confidenceScore: 'medium',
          pipelineStatus: 'alignment_complete',
          researchedDate: '',
          lastRefreshedAt: '2026-05-01T12:00:00Z',
          profileVersion: '3',
          errorLog: '',
          _rowIndex: 20,
        },
      ],
    );

    assert.equal(snap.blockedContactCount, 2);
    assert.equal(snap.blockedByReason.LOW_ALIGNMENT_CONFIDENCE, 1);
    assert.equal(snap.blockedByReason.DUPLICATE_COMPANY_PROFILE_KEY, 1);

    const coRow = snap.companyRows.find((r) => r.canonicalUrl.includes('co.com'));
    assert.ok(coRow);
    assert.equal(coRow.blockedContactsTotal, 2);
    assert.equal(coRow.profile?.profileVersion, '3');
    assert.equal(coRow.duplicateProfileKey, false);
    assert.equal(coRow.blockedByReason.LOW_ALIGNMENT_CONFIDENCE, 1);
    assert.equal(coRow.blockedByReason.DUPLICATE_COMPANY_PROFILE_KEY, 1);
  });

  it('marks duplicate profile key on health row when two sheet rows share column A', () => {
    const snap = buildUpstreamHealthSnapshot(
      [],
      [],
      [
        {
          canonicalCompanyUrl: 'https://dup.com',
          companyUrl: '',
          companyName: '',
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
          _rowIndex: 1,
        },
        {
          canonicalCompanyUrl: 'https://dup.com',
          companyUrl: '',
          companyName: '',
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
          _rowIndex: 2,
        },
      ],
    );
    const row = snap.companyRows.find((r) => r.canonicalUrl.includes('dup.com'));
    assert.ok(row);
    assert.equal(row.duplicateProfileKey, true);
    assert.equal(row.blockedContactsTotal, 0);
  });
});
