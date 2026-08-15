import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_TARGETS = [
  {
    os: 'windows',
    arch: 'x86_64',
    runner: 'windows-2025',
    target: 'x86_64-pc-windows-msvc',
    bundles: 'nsis,msi',
    smoke: true,
  },
  {
    os: 'windows',
    arch: 'i686',
    runner: 'windows-2025',
    target: 'i686-pc-windows-msvc',
    bundles: 'nsis,msi',
    smoke: false,
  },
  {
    os: 'windows',
    arch: 'aarch64',
    runner: 'windows-11-arm',
    target: 'aarch64-pc-windows-msvc',
    bundles: 'nsis,msi',
    smoke: false,
  },
  {
    os: 'linux',
    arch: 'x86_64',
    runner: 'ubuntu-22.04',
    target: 'x86_64-unknown-linux-gnu',
    bundles: 'appimage,deb,rpm',
    smoke: true,
  },
  {
    os: 'linux',
    arch: 'aarch64',
    runner: 'ubuntu-22.04-arm',
    target: 'aarch64-unknown-linux-gnu',
    bundles: 'appimage,deb,rpm',
    smoke: false,
  },
];

export function selectPackageMatrix({ eventName, targets } = {}) {
  const requested = targets || 'all';
  if (eventName === 'pull_request') {
    return PACKAGE_TARGETS.filter((row) => row.smoke);
  }
  if (eventName === 'workflow_dispatch' && requested !== 'all') {
    return PACKAGE_TARGETS.filter((row) => row.os === requested);
  }
  return PACKAGE_TARGETS;
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
  const include = selectPackageMatrix({
    eventName: process.env.YAQMC_EVENT_NAME || process.env.GITHUB_EVENT_NAME,
    targets: process.env.YAQMC_TARGETS,
  });
  if (include.length === 0) {
    throw new Error('package matrix is empty');
  }
  writeGithubOutput(include);
}
