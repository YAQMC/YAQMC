import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Electron package matrix (CI-02). Additive to the Tauri PACKAGE_TARGETS.
 * Drops Windows i686 (R-13). Windows arm64 is a cross-compile on windows-2025.
 * Linux arm64 stays on the FACT ubuntu-22.04-arm runner (CI-03's ubuntu-24.04-arm
 * remains hardware pending).
 */
export const ELECTRON_PACKAGE_TARGETS = [
  {
    os: 'windows',
    arch: 'x64',
    runner: 'windows-2025',
    target: 'x86_64-pc-windows-msvc',
    cross: false,
    smoke: true,
  },
  {
    os: 'windows',
    arch: 'arm64',
    runner: 'windows-2025',
    target: 'aarch64-pc-windows-msvc',
    cross: true,
    smoke: false,
  },
  {
    os: 'linux',
    arch: 'x64',
    runner: 'ubuntu-22.04',
    target: 'x86_64-unknown-linux-gnu',
    cross: false,
    smoke: true,
  },
  {
    os: 'linux',
    arch: 'arm64',
    runner: 'ubuntu-22.04-arm',
    target: 'aarch64-unknown-linux-gnu',
    cross: false,
    smoke: false,
  },
];

export function selectElectronPackageMatrix({ eventName, targets } = {}) {
  const requested = targets || 'all';
  if (eventName === 'pull_request') {
    return ELECTRON_PACKAGE_TARGETS.filter((row) => row.smoke);
  }
  if (eventName === 'workflow_dispatch' && requested !== 'all') {
    return ELECTRON_PACKAGE_TARGETS.filter((row) => row.os === requested);
  }
  return ELECTRON_PACKAGE_TARGETS;
}

function writeGithubOutput(include) {
  const json = JSON.stringify(include);
  if (!process.env.GITHUB_OUTPUT) {
    process.stdout.write(`${json}\n`);
    return;
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `include<<EOF\n${json}\nEOF\n`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const include = selectElectronPackageMatrix({
    eventName: process.env.YAQMC_EVENT_NAME || process.env.GITHUB_EVENT_NAME,
    targets: process.env.YAQMC_TARGETS,
  });
  if (include.length === 0) {
    throw new Error('electron package matrix is empty');
  }
  writeGithubOutput(include);
}
