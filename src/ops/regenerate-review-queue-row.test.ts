import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUserDirectedInputSources,
  deriveUserDirectedRegenMode,
} from './regenerate-review-queue-row.js';

test('deriveUserDirectedRegenMode returns expected values', () => {
  assert.equal(deriveUserDirectedRegenMode('note', 'dave'), 'mixed_manual');
  assert.equal(deriveUserDirectedRegenMode('note', ''), 'user_notes');
  assert.equal(deriveUserDirectedRegenMode('', 'dave'), 'david_notes');
});

test('buildUserDirectedInputSources includes mandatory history and context', () => {
  const parsed = JSON.parse(buildUserDirectedInputSources('user', 'dave')) as string[];
  assert.deepEqual(parsed, [
    'user_notes',
    'david_project_notes',
    'qc_remediation_history',
    'sequence_context',
  ]);
});
