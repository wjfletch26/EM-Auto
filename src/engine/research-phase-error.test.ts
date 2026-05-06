/**
 * Unit tests for research-phase error formatting and classification.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyResearchFailure,
  formatResearchPhaseErrorLog,
  parseLastResearchPhaseReasonCode,
} from './research-phase-error.js';

describe('research-phase-error', () => {
  it('formats and parses a stable code line', () => {
    const line = formatResearchPhaseErrorLog('INVALID_CANONICAL_URL', 'No usable company_url on contact row');
    assert.ok(line.includes('[RESEARCH_PHASE]'));
    assert.ok(line.includes('code=INVALID_CANONICAL_URL'));
    assert.equal(parseLastResearchPhaseReasonCode(`old\n${line}`), 'INVALID_CANONICAL_URL');
  });

  it('classifies research-time JSON errors', () => {
    const r = classifyResearchFailure(new Error('Company research returned invalid JSON: foo'), 'research');
    assert.equal(r.code, 'RESEARCH_RESPONSE_INVALID_JSON');
  });

  it('classifies alignment failures', () => {
    const r = classifyResearchFailure(new Error('Alignment model returned empty'), 'alignment');
    assert.equal(r.code, 'ALIGNMENT_EVALUATION_FAILED');
  });

  it('classifies sheet phase missing profile row', () => {
    const r = classifyResearchFailure(new Error('Company profile row missing after research write'), 'sheet');
    assert.equal(r.code, 'PROFILE_ROW_MISSING_AFTER_WRITE');
  });
});
