/**
 * Runs automated pieces of the VPS deploy PR checklist:
 *   - Node listen(port) reachable on 127.0.0.1 (Express-compatible)
 *   - flock lock behavior: native bash, WSL on Windows, or Docker
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Docker Desktop on Windows: /e/... bind from a Win32 path. */
function dockerMountSource(localPath) {
  if (process.platform !== 'win32') return localPath;
  const posix = localPath.replace(/\\/g, '/');
  const m = posix.match(/^([A-Za-z]):(.*)$/);
  if (!m) return posix;
  return `/${m[1].toLowerCase()}${m[2]}`;
}

function runNode(script) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** Docker engine reachable (not just the CLI). */
function dockerDaemonAvailable() {
  const r = spawnSync('docker', ['info'], { stdio: 'pipe' });
  return r.status === 0;
}

function dockerCliPresent() {
  const r = spawnSync('docker', ['version', '--format', '{{.Client.Version}}'], {
    stdio: 'pipe',
  });
  return r.status === 0;
}

function runFlockViaDocker() {
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${dockerMountSource(root)}:/app`,
      '-w',
      '/app',
      'ubuntu:22.04',
      'bash',
      '-lc',
      'apt-get update -qq && apt-get install -y -qq util-linux >/dev/null && bash scripts/verify-vps-deploy-checklist.sh',
    ],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function runFlockViaBash() {
  const r = spawnSync('bash', ['scripts/verify-vps-deploy-checklist.sh'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function flockInPath() {
  const r = spawnSync('bash', ['-lc', 'command -v flock'], {
    stdio: 'pipe',
  });
  return r.status === 0 && (r.stdout?.length ?? 0) > 0;
}

/** Absolute path to verify script inside the default WSL distro (Windows only). */
function wslVerifyScriptPath() {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('wsl', ['wslpath', '-u', root], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const base = r.stdout.trim();
  if (!base) return null;
  return `${base}/scripts/verify-vps-deploy-checklist.sh`;
}

function runFlockViaWsl(scriptPosix) {
  const r = spawnSync('wsl', ['bash', scriptPosix], {
    stdio: 'inherit',
    env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log('==> verify-listen-localhost.mjs');
runNode('verify-listen-localhost.mjs');

console.log('==> flock concurrent deploy (verify-vps-deploy-checklist.sh)');
if (flockInPath()) {
  runFlockViaBash();
} else {
  const wslScript = wslVerifyScriptPath();
  if (wslScript) {
    console.log('    (using WSL: util-linux flock not in this shell PATH)');
    runFlockViaWsl(wslScript);
  } else if (dockerDaemonAvailable()) {
    console.log('    (using Docker container with util-linux)');
    runFlockViaDocker();
  } else {
    let msg =
      'FAIL: need `flock` (Linux/WSL), WSL + wslpath for this Windows repo, or Docker with a **running** daemon.';
    if (dockerCliPresent()) {
      msg +=
        '\n    Docker CLI is present but `docker info` failed — start Docker Desktop (or the Linux engine), then retry.';
    }
    console.error(msg);
    process.exit(1);
  }
}

console.log(
  '\nDeploy checklist automation finished. Manual still: full vps-deploy.sh on a staging VPS with pm2 + credentials.',
);
