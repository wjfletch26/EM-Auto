/**
 * Phase 1 Integration Test
 *
 * Validates that all foundation modules work together:
 *   1. Config loads and validates successfully
 *   2. Logger writes structured JSON to data/logs/
 *   3. Local state store reads/writes JSON files atomically
 *   4. Google Sheets service connects and reads data
 *
 * Run: npm run test:integration
 */

import { config, getRedactedConfig } from '../src/config/index.js';
import { logger, cleanOldLogs } from '../src/logging/logger.js';
import { readState, writeState, deleteState } from '../src/state/local-store.js';
import { verifyAccess, getContacts, getCampaigns } from '../src/services/sheets.js';
import fs from 'node:fs';
import path from 'node:path';

// Track pass/fail for a summary at the end
let passed = 0;
let failed = 0;

function ok(label: string) {
  passed++;
  console.log(`  ✅ ${label}`);
}

function fail(label: string, err: unknown) {
  failed++;
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`  ❌ ${label}: ${msg}`);
}

// ─── Test 1: Config ──────────────────────────────────────────────────────────

console.log('\n=== Test 1: Config Validation ===');

try {
  // If we got here, the config already loaded (imported above).
  // Verify a few key fields to be sure.
  if (!config.smtp.host) throw new Error('smtp.host is empty');
  if (!config.smtp.user.includes('@')) throw new Error('smtp.user is not an email');
  if (!config.google.spreadsheetId) throw new Error('spreadsheetId is empty');
  if (config.unsub.secret.length < 32) throw new Error('UNSUB_SECRET too short');

  console.log('  Redacted config:', JSON.stringify(getRedactedConfig(), null, 2));
  ok('Config loaded and validated');
} catch (err) {
  fail('Config validation', err);
}

// ─── Test 2: Logger ──────────────────────────────────────────────────────────

console.log('\n=== Test 2: Logger ===');

try {
  // Write a test log entry
  logger.info({ module: 'integration-test', phase: 1 }, 'Integration test log entry');
  logger.warn({ module: 'integration-test' }, 'Test warning');

  // Verify the log directory and today's file exist
  const logDir = path.resolve(config.logging.dir);
  const date = new Date().toISOString().slice(0, 10);
  const logFile = path.join(logDir, `app-${date}.log`);

  // Give pino a moment to flush the transport
  await new Promise((resolve) => setTimeout(resolve, 500));

  if (!fs.existsSync(logDir)) throw new Error(`Log directory not found: ${logDir}`);
  ok('Log directory exists');

  if (!fs.existsSync(logFile)) throw new Error(`Today's log file not found: ${logFile}`);
  ok('Today\'s log file created');

  // Run log cleanup (should not delete today's file)
  cleanOldLogs();
  ok('Log cleanup ran without errors');
} catch (err) {
  fail('Logger', err);
}

// ─── Test 3: Local State Store ───────────────────────────────────────────────

console.log('\n=== Test 3: Local State Store ===');

const TEST_FILE = '__integration-test.json';

try {
  // Write state
  const testData = { timestamp: new Date().toISOString(), status: 'testing', count: 42 };
  writeState(TEST_FILE, testData);
  ok('State file written');

  // Read it back
  const loaded = readState(TEST_FILE, null);
  if (!loaded || loaded.count !== 42) throw new Error('Read-back mismatch');
  ok('State file read back correctly');

  // Delete it
  deleteState(TEST_FILE);
  const afterDelete = readState(TEST_FILE, null);
  if (afterDelete !== null) throw new Error('File still exists after delete');
  ok('State file deleted');

  // Test default value on missing file
  const missing = readState('__nonexistent.json', { fallback: true });
  if (!missing.fallback) throw new Error('Default value not returned');
  ok('Default value returned for missing file');
} catch (err) {
  fail('Local state store', err);
  // Clean up on failure
  try { deleteState(TEST_FILE); } catch { /* ignore */ }
}

// ─── Test 4: Google Sheets ───────────────────────────────────────────────────

console.log('\n=== Test 4: Google Sheets ===');

try {
  const hasAccess = await verifyAccess();
  if (!hasAccess) throw new Error('verifyAccess returned false');
  ok('Sheets connection verified');
} catch (err) {
  fail('Sheets connection', err);
}

try {
  const contacts = await getContacts();
  console.log(`  Found ${contacts.length} contacts`);
  if (contacts.length > 0) {
    console.log(`  First contact: ${contacts[0].email} (${contacts[0].firstName})`);
  }
  ok('getContacts() works');
} catch (err) {
  fail('getContacts()', err);
}

try {
  const campaigns = await getCampaigns();
  console.log(`  Found ${campaigns.length} campaigns`);
  if (campaigns.length > 0) {
    console.log(`  First campaign: ${campaigns[0].campaignId} (${campaigns[0].totalSteps} steps)`);
  }
  ok('getCampaigns() works');
} catch (err) {
  fail('getCampaigns()', err);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n========================================');
console.log(`  Phase 1 Integration Test: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) process.exit(1);
