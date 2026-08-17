import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');

test('CI runs an Electron build-only job on Ubuntu and Windows', () => {
  assert.match(workflow, /^ {2}electron-build:/m);
  assert.match(workflow, /os: \[ubuntu-22\.04, windows-2025\]/);
  assert.match(workflow, /npm run build -w @yaqmc\/desktop/);
  assert.match(
    workflow,
    /needs: \[frontend-quality, frontend-build, rust-quality, secret-scan, package-matrix, package, electron-build\]/,
  );
});

test('rust-quality stays independent of the Electron build job', () => {
  const rustJob = workflow.split(/^ {2}rust-quality:/m)[1]?.split(/^ {2}[a-z]/m)[0] ?? '';
  assert.match(rustJob, /cargo clippy --workspace --all-targets --locked/);
  assert.doesNotMatch(rustJob, /electron-build/);
  assert.doesNotMatch(rustJob, /@yaqmc\/desktop/);
});

test('frontend-quality runs desktop tests and Electron security greps', () => {
  const frontendJob = workflow.split(/^ {2}frontend-quality:/m)[1]?.split(/^ {2}[a-z]/m)[0] ?? '';
  assert.match(frontendJob, /npm run test -w @yaqmc\/client/);
  assert.match(frontendJob, /npm run test -w @yaqmc\/desktop/);
  assert.match(frontendJob, /node scripts\/ci\/tauri-imports\.mjs/);
  assert.match(frontendJob, /node scripts\/ci\/electron-security-lint\.mjs/);
  assert.match(frontendJob, /npm run typecheck(?! -w)/);
  assert.match(frontendJob, /npm run format:check/);
  assert.match(frontendJob, /npm run ci:test-scripts/);
  assert.doesNotMatch(frontendJob, /npm run typecheck -w @yaqmc/);
  assert.doesNotMatch(frontendJob, /command-inventory\.mjs/);
  assert.doesNotMatch(frontendJob, /playwright/i);
});
