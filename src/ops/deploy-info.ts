/**
 * Deployment manifest (written on the VPS by deploy scripts) and optional
 * ".deploying" marker so layered /health can surface deployment state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (works from src/ops and dist/ops). */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** Top-level operational state returned by /health (see RUN_AND_DEPLOY.md). */
export type DeploymentState =
  | 'healthy'
  | 'deploying'
  | 'safe_mode'
  | 'degraded'
  | 'failed'
  | 'rollback';

/** Shape of deploy-manifest.json on the server (optional file). */
export interface DeployManifest {
  sha?: string;
  branch?: string;
  time?: string;
  deployer?: string;
  appEnv?: string;
  deploymentStatus?: DeploymentState;
}

/** Resolve manifest path: override with DEPLOY_MANIFEST_PATH or default at repo root. */
export function getDeployManifestPath(): string {
  const override = process.env.DEPLOY_MANIFEST_PATH?.trim();
  if (override && override.length > 0) {
    return path.isAbsolute(override)
      ? override
      : path.join(PROJECT_ROOT, override);
  }
  return path.join(PROJECT_ROOT, 'deploy-manifest.json');
}

/** Read manifest if present; invalid JSON yields null. */
export function loadDeployManifest(): DeployManifest | null {
  const p = getDeployManifestPath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as DeployManifest;
  } catch {
    return null;
  }
}

/**
 * When the deploy script creates this file before mutating the tree, /health
 * reports status "deploying". The script should remove it after pm2 reload.
 */
export function isDeployInProgressMarker(): boolean {
  const marker = path.join(PROJECT_ROOT, '.deploying');
  return fs.existsSync(marker);
}
