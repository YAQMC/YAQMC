import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const workflow = readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'package-artifacts.yml'),
  'utf8',
);

test('manual artifact builds expose and verify macOS packages', () => {
  const targetInput = workflow.split(/^\s{6}targets:/m)[1]?.split(/^\s{6}optimization:/m)[0] ?? '';
  assert.match(targetInput, /^\s{8}options:/m);
  assert.match(targetInput, /^\s{10}- macos$/m);
  assert.match(workflow, /YAQMC_TARGETS: \$\{\{ inputs\.targets \}\}/);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(workflow, /matrix\.os == 'macos'/);
  assert.match(workflow, /node scripts\/ci\/verify-macos-package\.mjs/);
  assert.match(workflow, /YAQMC-electron-macos-\$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /--signed false/);
});

test('CI secret scanning covers the macOS runner', () => {
  const ci = readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /os:\s+\[ubuntu-22\.04,\s+windows-2025,\s+macos-15\]/);
  assert.match(ci, /runner\.os == 'Linux' \|\| runner\.os == 'macOS'/);
  assert.match(ci, /shell: bash/);
});
