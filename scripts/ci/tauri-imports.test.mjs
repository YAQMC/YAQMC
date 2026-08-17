import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  forbiddenTauriImportNeedle,
  lintTauriImportText,
  scanTauriImports,
} from './tauri-imports.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const needle = forbiddenTauriImportNeedle();

test('seeded @tauri-apps comments outside the bridge fail the linter', () => {
  assert.deepEqual(lintTauriImportText(`// leftover ${needle} import\n`, 'src/main.tsx'), [
    `src/main.tsx: forbidden ${needle} reference`,
  ]);
  assert.deepEqual(lintTauriImportText('export const kind = "electron";\n', 'src/main.tsx'), []);
});

test('a temporary tree with a seeded src/ comment fails the repository scan', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-tauri-imports-'));
  mkdirSync(path.join(root, 'src', 'application'), { recursive: true });
  writeFileSync(
    path.join(root, 'src', 'application', 'tauri-host-bridge.ts'),
    `import { invoke } from '${needle}/api/core';\n`,
  );
  writeFileSync(
    path.join(root, 'src', 'application', 'tauri-host-bridge.test.ts'),
    `vi.mock('${needle}/api/core', () => ({}));\n`,
  );
  writeFileSync(path.join(root, 'src', 'main.tsx'), `// leftover ${needle} import\n`);
  const findings = scanTauriImports(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0], `src/main.tsx: forbidden ${needle} reference`);
});

test('the YAQMC src/ tree has no @tauri-apps references outside TauriHostBridge', () => {
  assert.deepEqual(scanTauriImports(repositoryRoot), []);
});
