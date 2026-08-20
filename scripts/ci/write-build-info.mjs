import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './repo.mjs';
import { currentGitSha } from './write-frontend-build-info.mjs';

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function writeBuildInfo(options) {
  const { outputPath, target, arch, os, profile, lto, codegenUnits, bundles, files } = options;
  const desktopPackage = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'apps/desktop/package.json'), 'utf8'),
  );
  const info = {
    schemaVersion: 1,
    appName: 'YAQMC',
    version: desktopPackage.version,
    gitSha: currentGitSha(),
    gitRef: process.env.GITHUB_REF || commandOutput('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    builtAt: new Date().toISOString(),
    os,
    target,
    architecture: arch,
    rustc: commandOutput('rustc', ['--version']),
    node: process.version,
    electron: desktopPackage.devDependencies.electron,
    profile,
    lto,
    codegenUnits,
    bundles,
    files,
  };
  writeFileSync(outputPath, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function writeSha256Sums(directory, files, outputName) {
  const lines = files.map((name) => `${sha256File(path.join(directory, name))}  ${name}`);
  const outputPath = path.join(directory, outputName);
  writeFileSync(outputPath, `${lines.join('\n')}\n`);
  verifySha256Sums(outputPath);
  return outputPath;
}

export function verifySha256Sums(filePath) {
  const directory = path.dirname(filePath);
  const lines = readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error(`${filePath} does not list any checksums`);
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`invalid checksum line: ${line}`);
    const actual = sha256File(path.join(directory, match[2]));
    if (actual !== match[1]) {
      throw new Error(`checksum mismatch for ${match[2]}`);
    }
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  writeBuildInfo({
    outputPath: process.argv[2] || 'build-info.json',
    target: process.env.YAQMC_TARGET || 'unknown',
    arch: process.env.YAQMC_ARCH || 'unknown',
    os: process.env.YAQMC_OS || process.platform,
    profile: process.env.YAQMC_BUILD_PROFILE || 'ci-release',
    lto: process.env.CARGO_PROFILE_RELEASE_LTO || 'thin',
    codegenUnits: Number(process.env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS || 8),
    bundles: (process.env.YAQMC_BUNDLES || '').split(',').filter(Boolean),
    files: [],
  });
}
