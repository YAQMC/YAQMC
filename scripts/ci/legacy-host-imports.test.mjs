import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  forbiddenLegacyHostImportNeedle,
  lintLegacyHostImportText,
  scanLegacyHostImports,
} from './legacy-host-imports.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const needle = forbiddenLegacyHostImportNeedle();

test('seeded legacy host package references fail the linter', () => {
  assert.deepEqual(lintLegacyHostImportText(`// leftover ${needle} import\n`, 'src/main.tsx'), [
    'src/main.tsx: forbidden legacy host package reference',
  ]);
  assert.deepEqual(
    lintLegacyHostImportText('export const kind = "electron";\n', 'src/main.tsx'),
    [],
  );
});

test('a temporary tree with a seeded src reference fails the repository scan', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-legacy-host-imports-'));
  mkdirSync(path.join(root, 'src', 'application'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'main.tsx'), `// leftover ${needle} import\n`);
  const findings = scanLegacyHostImports(root);
  assert.deepEqual(findings, ['src/main.tsx: forbidden legacy host package reference']);
});

test('the YAQMC src tree has no legacy host package references', () => {
  assert.deepEqual(scanLegacyHostImports(repositoryRoot), []);
});
