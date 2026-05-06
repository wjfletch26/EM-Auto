import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeParseConfig } from './schema.js';

/**
 * Minimal valid raw config for Zod (mirrors buildRawConfig output shape).
 * Tweak with overrides for each test case.
 */
function baseRaw(overrides: Record<string, unknown> = {}) {
  const base = {
    smtp: {
      host: 'smtp.example.com',
      port: '587',
      user: 'sender@example.com',
      pass: 'secret',
      secure: 'false',
      fromName: 'Test',
      replyForwardTo: 'review@example.com',
    },
    imap: {
      enabled: 'false',
    },
    google: {
      serviceAccountPath: './credentials/service-account.json',
      spreadsheetId: 'prodSheetId12345',
      productionSpreadsheetId: 'prodSheetId12345',
    },
    unsub: {
      secret: 'a'.repeat(32),
      baseUrl: 'https://unsub.example.com',
    },
    schedule: {},
    logging: {},
    app: {
      appEnv: 'production',
      nodeEnv: 'production',
      physicalAddress: '123 Test St',
      dryRun: 'false',
      testRecipient: '',
    },
    admin: {},
    pipeline: {},
    generationGate: {},
    lineage: {},
    perplexity: {},
    llm: {},
    // Matches buildRawConfig shape — dashboard is required on configSchemaBase.
    dashboard: {},
  };
  return deepMerge(base, overrides) as typeof base;
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const bv = b[k];
    const av = a[k];
    if (
      bv &&
      typeof bv === 'object' &&
      !Array.isArray(bv) &&
      av &&
      typeof av === 'object' &&
      !Array.isArray(av)
    ) {
      out[k] = deepMerge(av as Record<string, unknown>, bv as Record<string, unknown>);
    } else {
      out[k] = bv;
    }
  }
  return out;
}

describe('configSchema safety rules', () => {
  it('accepts valid production config', () => {
    const r = safeParseConfig(baseRaw());
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.app.appEnv, 'production');
      assert.equal(r.data.app.emailMode, 'production_live');
      assert.equal(r.data.app.schedulerEnabled, true);
    }
  });

  it('rejects production when sheet ID does not match production canonical ID', () => {
    const r = safeParseConfig(
      baseRaw({
        google: {
          serviceAccountPath: './credentials/service-account.json',
          spreadsheetId: 'wrongSheet',
          productionSpreadsheetId: 'prodSheetId12345',
        },
      }),
    );
    assert.equal(r.success, false);
  });

  it('rejects production with DRY_RUN=true', () => {
    const r = safeParseConfig(
      baseRaw({
        app: {
          appEnv: 'production',
          nodeEnv: 'production',
          physicalAddress: '123 Test St',
          dryRun: 'true',
          testRecipient: '',
        },
      }),
    );
    assert.equal(r.success, false);
  });

  it('rejects production with TEST_RECIPIENT set', () => {
    const r = safeParseConfig(
      baseRaw({
        app: {
          appEnv: 'production',
          nodeEnv: 'production',
          physicalAddress: '123 Test St',
          dryRun: 'false',
          testRecipient: 'lab@example.com',
        },
      }),
    );
    assert.equal(r.success, false);
  });

  it('rejects local when GOOGLE_SPREADSHEET_ID equals production sheet', () => {
    const r = safeParseConfig(
      baseRaw({
        google: {
          serviceAccountPath: './credentials/service-account.json',
          spreadsheetId: 'prodSheetId12345',
          productionSpreadsheetId: 'prodSheetId12345',
        },
        app: {
          appEnv: 'local',
          nodeEnv: 'development',
          physicalAddress: '123 Test St',
          dryRun: 'true',
          testRecipient: '',
        },
      }),
    );
    assert.equal(r.success, false);
  });

  it('rejects local when neither simulated send nor test recipient is configured', () => {
    const r = safeParseConfig(
      baseRaw({
        google: {
          serviceAccountPath: './credentials/service-account.json',
          spreadsheetId: 'localOnlySheet999',
          productionSpreadsheetId: 'prodSheetId12345',
        },
        app: {
          appEnv: 'local',
          nodeEnv: 'development',
          physicalAddress: '123 Test St',
          dryRun: 'false',
          testRecipient: '',
        },
      }),
    );
    assert.equal(r.success, false);
  });

  it('accepts local with simulated send (DRY_RUN=true) and non-production sheet', () => {
    const r = safeParseConfig(
      baseRaw({
        google: {
          serviceAccountPath: './credentials/service-account.json',
          spreadsheetId: 'localOnlySheet999',
          productionSpreadsheetId: 'prodSheetId12345',
        },
        app: {
          appEnv: 'local',
          nodeEnv: 'development',
          physicalAddress: '123 Test St',
          dryRun: 'true',
          testRecipient: '',
        },
      }),
    );
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.app.emailMode, 'simulated_send');
      assert.equal(r.data.app.schedulerEnabled, false);
    }
  });

  it('accepts local with test recipient mode', () => {
    const r = safeParseConfig(
      baseRaw({
        google: {
          serviceAccountPath: './credentials/service-account.json',
          spreadsheetId: 'localOnlySheet999',
          productionSpreadsheetId: 'prodSheetId12345',
        },
        app: {
          appEnv: 'local',
          nodeEnv: 'development',
          physicalAddress: '123 Test St',
          dryRun: 'false',
          testRecipient: 'lab@example.com',
        },
      }),
    );
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.app.emailMode, 'test_recipient');
    }
  });

  it('staging mirrors local sheet and email rules', () => {
    const r = safeParseConfig(
      baseRaw({
        google: {
          serviceAccountPath: './credentials/service-account.json',
          spreadsheetId: 'stagingSheet888',
          productionSpreadsheetId: 'prodSheetId12345',
        },
        app: {
          appEnv: 'staging',
          nodeEnv: 'production',
          physicalAddress: '123 Test St',
          dryRun: 'true',
          testRecipient: '',
        },
      }),
    );
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.app.schedulerEnabled, false);
    }
  });

  it('honors explicit SCHEDULER_ENABLED=true for local', () => {
    const r = safeParseConfig(
      baseRaw({
        google: {
          serviceAccountPath: './credentials/service-account.json',
          spreadsheetId: 'localOnlySheet999',
          productionSpreadsheetId: 'prodSheetId12345',
        },
        app: {
          appEnv: 'local',
          nodeEnv: 'development',
          physicalAddress: '123 Test St',
          dryRun: 'true',
          testRecipient: '',
          schedulerEnabled: 'true',
        },
      }),
    );
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.app.schedulerEnabled, true);
    }
  });

  it('SAFE_MODE forces scheduler off for production', () => {
    const r = safeParseConfig(
      baseRaw({
        app: {
          appEnv: 'production',
          safeMode: 'true',
        },
      }),
    );
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.app.safeMode, true);
      assert.equal(r.data.app.schedulerEnabled, false);
    }
  });

  it('SAFE_MODE overrides explicit SCHEDULER_ENABLED=true', () => {
    const r = safeParseConfig(
      baseRaw({
        google: {
          serviceAccountPath: './credentials/service-account.json',
          spreadsheetId: 'localOnlySheet999',
          productionSpreadsheetId: 'prodSheetId12345',
        },
        app: {
          appEnv: 'local',
          nodeEnv: 'development',
          physicalAddress: '123 Test St',
          dryRun: 'true',
          testRecipient: '',
          schedulerEnabled: 'true',
          safeMode: 'true',
        },
      }),
    );
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.app.schedulerEnabled, false);
    }
  });
});
