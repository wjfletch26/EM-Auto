/**
 * Unit tests for dashboard summary aggregation (no network / Sheets).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDashboardSummary } from './dashboard-summary.js';

const minimalContact = {
  firstName: 'A',
  lastName: 'B',
  company: 'C',
  title: 'T',
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
  companyUrl: 'https://x.com',
  pipelineStatus: 'queued',
  lastProfileVersionUsedForGeneration: '',
};

describe('buildDashboardSummary', () => {
  it('counts contacts and pipeline statuses', () => {
    const summary = buildDashboardSummary(
      [
        {
          ...minimalContact,
          email: 'a@x.com',
          pipelineStatus: 'queued',
          _rowIndex: 2,
        },
        {
          ...minimalContact,
          email: 'b@x.com',
          companyUrl: '',
          pipelineStatus: 'queued',
          _rowIndex: 3,
        },
      ],
      [],
      [],
      [],
    );
    assert.equal(summary.contacts.total, 2);
    assert.equal(summary.contacts.withCompanyUrl, 1);
    assert.equal(summary.contacts.pipelineStatus.queued, 2);
    assert.equal(summary.companyProfiles.total, 0);
    assert.equal(summary.canonicalAudit.duplicateProfileKeys.length, 0);
    assert.equal(summary.canonicalAudit.intelDrift.length, 0);
    assert.equal(summary.canonicalAudit.intelDriftTruncated, false);
  });

  it('collects intelligence errors with previews', () => {
    const summary = buildDashboardSummary(
      [],
      [
        {
          contactEmail: 'c@x.com',
          canonicalCompanyUrl: 'https://x.com',
          companyUrl: 'https://x.com',
          davidProjectNotes: '',
          executiveBrief: '',
          pipelineStatus: '',
          generatedDate: '',
          errorLog: 'boom',
          _rowIndex: 2,
        },
      ],
      [],
      [],
    );
    assert.equal(summary.companyIntelligence.errorCount, 1);
    assert.equal(summary.companyIntelligence.errors.length, 1);
    assert.equal(summary.companyIntelligence.errors[0].preview, 'boom');
    assert.equal(summary.canonicalAudit.duplicateProfileKeys.length, 0);
    assert.equal(summary.canonicalAudit.intelDrift.length, 0);
    assert.equal(summary.canonicalAudit.intelDriftTruncated, false);
  });

  it('counts company profile pipeline statuses', () => {
    const summary = buildDashboardSummary(
      [],
      [],
      [],
      [
        {
          canonicalCompanyUrl: 'https://co.com',
          companyUrl: 'https://co.com',
          companyName: 'Co',
          industry: '',
          productSummary: '',
          companySize: '',
          signals: '',
          signalSummary: '',
          deatonCapabilitiesMatched: '',
          caseStudiesSelected: '',
          alignmentRationale: '',
          confidenceScore: '',
          pipelineStatus: 'alignment_complete',
          researchedDate: '',
          lastRefreshedAt: '',
          profileVersion: '1',
          errorLog: '',
          _rowIndex: 2,
        },
      ],
    );
    assert.equal(summary.companyProfiles.total, 1);
    assert.equal(summary.companyProfiles.pipelineStatus['alignment_complete'], 1);
    assert.equal(summary.companyProfiles.errorCount, 0);
    assert.equal(summary.companyProfiles.errors.length, 0);
    assert.equal(summary.canonicalAudit.duplicateProfileKeys.length, 0);
    assert.equal(summary.canonicalAudit.intelDrift.length, 0);
    assert.equal(summary.canonicalAudit.intelDriftTruncated, false);
  });

  it('collects company profile errors with previews', () => {
    const summary = buildDashboardSummary(
      [],
      [],
      [],
      [
        {
          canonicalCompanyUrl: 'https://oops.com/',
          companyUrl: 'https://oops.com',
          companyName: 'Oops Co',
          industry: '',
          productSummary: '',
          companySize: '',
          signals: '',
          signalSummary: '',
          deatonCapabilitiesMatched: '',
          caseStudiesSelected: '',
          alignmentRationale: '',
          confidenceScore: '',
          pipelineStatus: 'research_failed',
          researchedDate: '',
          lastRefreshedAt: '',
          profileVersion: '',
          errorLog: 'Unable to parse range',
          _rowIndex: 2,
        },
      ],
    );
    assert.equal(summary.companyProfiles.errorCount, 1);
    assert.equal(summary.companyProfiles.errors.length, 1);
    assert.equal(summary.companyProfiles.errors[0].canonicalUrl, 'https://oops.com/');
    assert.equal(summary.companyProfiles.errors[0].preview, 'Unable to parse range');
    assert.equal(summary.canonicalAudit.duplicateProfileKeys.length, 0);
    assert.equal(summary.canonicalAudit.intelDrift.length, 0);
    assert.equal(summary.canonicalAudit.intelDriftTruncated, false);
  });

  it('reports duplicate company profile keys and intel drift', () => {
    const summary = buildDashboardSummary(
      [
        {
          ...minimalContact,
          email: 'u@v.com',
          companyUrl: 'https://vendor.com',
          _rowIndex: 2,
        },
      ],
      [
        {
          contactEmail: 'u@v.com',
          canonicalCompanyUrl: 'https://old.com',
          companyUrl: 'https://vendor.com',
          davidProjectNotes: '',
          executiveBrief: '',
          pipelineStatus: '',
          generatedDate: '',
          errorLog: '',
          _rowIndex: 3,
        },
      ],
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
          _rowIndex: 10,
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
          _rowIndex: 11,
        },
      ],
    );
    assert.equal(summary.canonicalAudit.duplicateProfileKeys.length, 1);
    assert.deepEqual(summary.canonicalAudit.duplicateProfileKeys[0].rowIndices, [10, 11]);
    assert.equal(summary.canonicalAudit.intelDrift.length, 1);
    assert.equal(summary.canonicalAudit.intelDrift[0].intelCanonical, 'https://old.com');
  });
});
