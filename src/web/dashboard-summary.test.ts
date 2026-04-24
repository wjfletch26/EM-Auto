/**
 * Unit tests for dashboard summary aggregation (no network / Sheets).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDashboardSummary } from './dashboard-summary.js';

describe('buildDashboardSummary', () => {
  it('counts contacts and pipeline statuses', () => {
    const summary = buildDashboardSummary(
      [
        {
          email: 'a@x.com',
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
          _rowIndex: 2,
        },
        {
          email: 'b@x.com',
          firstName: 'B',
          lastName: 'C',
          company: 'D',
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
          companyUrl: '',
          pipelineStatus: 'queued',
          _rowIndex: 3,
        },
      ],
      [],
      [],
    );
    assert.equal(summary.contacts.total, 2);
    assert.equal(summary.contacts.withCompanyUrl, 1);
    assert.equal(summary.contacts.pipelineStatus.queued, 2);
  });

  it('collects intelligence errors with previews', () => {
    const summary = buildDashboardSummary(
      [],
      [
        {
          contactEmail: 'c@x.com',
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
          davidProjectNotes: '',
          executiveBrief: '',
          pipelineStatus: '',
          researchedDate: '',
          generatedDate: '',
          errorLog: 'boom',
          _rowIndex: 2,
        },
      ],
      [],
    );
    assert.equal(summary.companyIntelligence.errorCount, 1);
    assert.equal(summary.companyIntelligence.errors.length, 1);
    assert.equal(summary.companyIntelligence.errors[0].preview, 'boom');
  });
});
