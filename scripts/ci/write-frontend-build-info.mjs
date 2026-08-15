import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitSha, repositoryRoot } from './repo.mjs';

const SCHEMA_VERSION = 1;
const sidecarName = '.yaqmc-frontend-build.json';

export function frontendBuildInfoPath(distDir = path.join(repositoryRoot, 'dist')) {
  return path.join(distDir, sidecarName);
}

export function currentGitSha() {
  const fromEnv = gitSha();
  if (/^[a-f0-9]{40}$/i.test(fromEnv)) return fromEnv.toLowerCase();
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function writeFrontendBuildInfo(distDir = path.join(repositoryRoot, 'dist')) {
  const commit = currentGitSha();
  if (!/^[a-f0-9]{40}$/i.test(commit)) {
    throw new Error('frontend build requires a 40-character git SHA');
  }
  mkdirSync(distDir, { recursive: true });
  const info = {
    schemaVersion: SCHEMA_VERSION,
    gitSha: commit.toLowerCase(),
    builtAt: new Date().toISOString(),
  };
  writeFileSync(frontendBuildInfoPath(distDir), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const info = writeFrontendBuildInfo();
  process.stdout.write(`Wrote frontend build info for ${info.gitSha}\n`);
}
