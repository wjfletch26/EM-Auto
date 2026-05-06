// Writes deploy-manifest.json at the repo root from environment variables.
// Invoked by scripts/vps-deploy.sh after `npm run build`.
//
// Typical VPS / CI env:
//   GIT_SHA, GIT_REF, DEPLOYER — set by the deploy host or GitHub Actions.
//   MANIFEST_APP_ENV — defaults to production when unset.
//   MANIFEST_DEPLOYMENT_STATUS — "healthy" or "rollback" (default healthy).
//   DEPLOY_MANIFEST_NAME — output filename (default deploy-manifest.json; path is always repo root).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.env.DEPLOY_MANIFEST_NAME || 'deploy-manifest.json';

const statusRaw = (process.env.MANIFEST_DEPLOYMENT_STATUS || 'healthy').toLowerCase();
const deploymentStatus =
  statusRaw === 'rollback' ? 'rollback' : 'healthy';

const manifest = {
  sha: process.env.GIT_SHA || '',
  branch: process.env.GIT_REF || '',
  time: new Date().toISOString(),
  deployer: process.env.DEPLOYER || 'unknown',
  appEnv: process.env.MANIFEST_APP_ENV || 'production',
  deploymentStatus,
};

fs.writeFileSync(
  path.join(root, name),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
