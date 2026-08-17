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
