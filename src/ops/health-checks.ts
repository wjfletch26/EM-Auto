/**
 * Layered /health: subsystems + deployment metadata (not a blind 200 OK).
 */

import { config } from '../config/index.js';
import { verifySpreadsheetReachable } from '../services/sheets.js';
import { verifySmtpReachableForHealth } from '../services/smtp.js';
import {
  loadDeployManifest,
  isDeployInProgressMarker,
  type DeploymentState,
} from './deploy-info.js';

/** Per-check result for operators and automation. */
export type CheckStatus = 'ok' | 'degraded' | 'fail' | 'skipped';

export interface HealthPayload {
  status: DeploymentState;
  appEnv: string;
  safeMode: boolean;
  dryRun: boolean;
  emailMode: string;
  deploy: {
    sha: string;
    branch: string;
    time: string;
    deployer: string;
    appEnv: string;
    deploymentStatus?: DeploymentState;
  };
  checks: Record<string, CheckStatus>;
}

function deployFromManifest(manifest: ReturnType<typeof loadDeployManifest>) {
  return {
    sha: manifest?.sha ?? '',
    branch: manifest?.branch ?? '',
    time: manifest?.time ?? '',
    deployer: manifest?.deployer ?? '',
    appEnv: manifest?.appEnv ?? config.app.appEnv,
    deploymentStatus: manifest?.deploymentStatus,
  };
}

/**
 * Runs quick probes (with internal timeouts where needed) and derives status.
 */
export async function buildHealthPayload(): Promise<HealthPayload> {
  const manifest = loadDeployManifest();
  const checks: Record<string, CheckStatus> = {
    webServer: 'ok',
  };

  const sheetsOk = await verifySpreadsheetReachable();
  checks.googleSheets = sheetsOk ? 'ok' : 'fail';

  if (config.app.emailMode === 'simulated_send') {
    checks.smtp = 'skipped';
  } else {
    const smtpOk = await verifySmtpReachableForHealth();
    checks.smtp = smtpOk ? 'ok' : 'fail';
  }

  if (config.app.safeMode) {
    checks.scheduler = 'skipped';
  } else if (!config.app.schedulerEnabled) {
    checks.scheduler = 'skipped';
  } else {
    checks.scheduler = 'ok';
  }

  let status: DeploymentState;
  if (isDeployInProgressMarker()) {
    status = 'deploying';
  } else if (manifest?.deploymentStatus === 'rollback') {
    status = 'rollback';
  } else if (checks.googleSheets === 'fail') {
    status = 'failed';
  } else if (checks.smtp === 'fail') {
    status =
      config.app.emailMode === 'production_live' ? 'failed' : 'degraded';
  } else if (config.app.safeMode) {
    status = 'safe_mode';
  } else if (Object.values(checks).some((c) => c === 'degraded')) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  return {
    status,
    appEnv: config.app.appEnv,
    safeMode: config.app.safeMode,
    dryRun: config.app.dryRun,
    emailMode: config.app.emailMode,
    deploy: deployFromManifest(manifest),
    checks,
  };
}

/** HTTP status: 503 when the app reports failed subsystem checks. */
export function healthHttpStatus(payload: HealthPayload): number {
  return payload.status === 'failed' ? 503 : 200;
}
