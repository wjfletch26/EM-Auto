/**
 * Dashboard rollups for research phase failures.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatResearchPhaseErrorLog } from '../engine/research-phase-error.js';
import { buildResearchPhaseDashboard } from './dashboard-research-phase.js';

const baseContact = {
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
  lastProfileVersionUsedForGeneration: '',
};

describe('buildResearchPhaseDashboard', () => {
  it('aggregates contact research_failed with parsed reason', () => {
    const line = formatResearchPhaseErrorLog(
      'RESEARCH_RESPONSE_SCHEMA_INVALID',
      'validation failed',
    );
    const dash = buildResearchPhaseDashboard(
      [
        {
          ...baseContact,
          email: 'a@x.com',
          pipelineStatus: 'research_failed',
          _rowIndex: 2,
        },
      ],
      [
        {
          contactEmail: 'a@x.com',
          canonicalCompanyUrl: 'https://x.com',
          companyUrl: 'https://x.com',
          davidProjectNotes: '',
          executiveBrief: '',
          pipelineStatus: '',
          generatedDate: '',
          errorLog: line,
          _rowIndex: 3,
        },
      ],
      [],
    );
    assert.equal(dash.contactsResearchFailed, 1);
    assert.equal(dash.contactFailuresByReason.RESEARCH_RESPONSE_SCHEMA_INVALID, 1);
    assert.equal(dash.contactSamples[0].reasonCode, 'RESEARCH_RESPONSE_SCHEMA_INVALID');
  });

  it('counts profile research_failed and refresh_failed', () => {
    const dash = buildResearchPhaseDashboard(
      [],
      [],
      [
        {
          canonicalCompanyUrl: 'https://a.com',
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
          pipelineStatus: 'refresh_failed',
          researchedDate: '',
          lastRefreshedAt: '',
          profileVersion: '',
          errorLog: formatResearchPhaseErrorLog('ALIGNMENT_EVALUATION_FAILED', 'timeout'),
          _rowIndex: 5,
        },
      ],
    );
    assert.equal(dash.profilesResearchOrRefreshFailed, 1);
    assert.equal(dash.profileFailuresByReason.ALIGNMENT_EVALUATION_FAILED, 1);
  });
});
