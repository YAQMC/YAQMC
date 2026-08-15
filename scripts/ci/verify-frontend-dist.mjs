import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repositoryRoot } from './repo.mjs';
import { currentGitSha, frontendBuildInfoPath } from './write-frontend-build-info.mjs';

export function verifyFrontendDist(distDir = path.join(repositoryRoot, 'dist')) {
  const index = path.join(distDir, 'index.html');
  if (!existsSync(index)) {
    throw new Error(`prebuilt frontend is missing ${index}`);
  }
  const sidecar = frontendBuildInfoPath(distDir);
  if (!existsSync(sidecar)) {
    throw new Error(`prebuilt frontend is missing provenance sidecar ${sidecar}`);
  }
  const info = JSON.parse(readFileSync(sidecar, 'utf8'));
  if (info.schemaVersion !== 1) {
    throw new Error(`unsupported frontend build schema ${info.schemaVersion}`);
  }
  const expected = currentGitSha().toLowerCase();
  const actual = String(info.gitSha || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(actual)) {
    throw new Error('frontend provenance sidecar is missing a git SHA');
  }
  if (actual !== expected) {
    throw new Error(`prebuilt frontend SHA ${actual} does not match current commit ${expected}`);
  }
  return info;
}
