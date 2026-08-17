import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  forbiddenChromiumSwitches,
  lintPreloadSource,
  lintSwitchText,
  scanElectronSecurity,
} from './electron-security-lint.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const [disableWebSecurity, noSandbox] = forbiddenChromiumSwitches();

const CLEAN_PRELOAD = `import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('yaqmc', {
  invoke: (method, params) => ipcRenderer.invoke('yaqmc:invoke', { method, params }),
  on: (channel, cb) => {
    const listener = (_event, frame) => cb(frame);
    ipcRenderer.on('yaqmc:event', listener);
    return () => ipcRenderer.removeListener('yaqmc:event', listener);
  },
});
`;

test('seeded Chromium switch violations fail the switch linter', () => {
  assert.deepEqual(lintSwitchText(`electron . ${noSandbox}`, 'packaging.yml'), [
    `packaging.yml: forbidden Chromium switch ${noSandbox}`,
  ]);
  assert.deepEqual(
    lintSwitchText(`app.commandLine.appendSwitch('${disableWebSecurity.slice(2)}')`, 'main.ts'),
    [],
  );
  assert.match(
    lintSwitchText(`args: ['${disableWebSecurity}']`, 'ci.yml')[0],
    new RegExp(disableWebSecurity.replaceAll('-', '\\-')),
  );
  assert.deepEqual(lintSwitchText('sandbox: true', 'index.ts'), []);
});

test('seeded preload purity violations fail the preload linter', () => {
  assert.match(lintPreloadSource("const fs = require('fs');\n", 'preload/main.ts')[0], /require\(/);
  assert.match(
    lintPreloadSource('const token = process.env.SECRET;\n', 'preload/main.ts')[0],
    /process\.env/,
  );
  assert.match(
    lintPreloadSource("import { ipcMain } from 'electron';\n", 'preload/main.ts')[0],
    /ipcMain/,
  );
  assert.deepEqual(lintPreloadSource(CLEAN_PRELOAD, 'preload/main.ts'), []);
});

test('a temporary tree with seeded violations fails the repository scan', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-electron-sec-'));
  mkdirSync(path.join(root, 'apps', 'desktop', 'preload'), { recursive: true });
  mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    path.join(root, '.github', 'workflows', 'ci.yml'),
    `run: electron ${disableWebSecurity}\n`,
  );
  writeFileSync(
    path.join(root, 'apps', 'desktop', 'preload', 'evil.ts'),
    "import { shell } from 'electron';\nprocess.env.FOO;\nrequire('fs');\n",
  );
  const findings = scanElectronSecurity(root);
  assert.ok(findings.some((finding) => finding.includes(disableWebSecurity)));
  assert.ok(findings.some((finding) => finding.includes('shell')));
  assert.ok(findings.some((finding) => finding.includes('require(')));
  assert.ok(findings.some((finding) => finding.includes('process.env')));
});

test('the YAQMC repository packaging and source pass Electron security greps', () => {
  assert.deepEqual(scanElectronSecurity(repositoryRoot), []);
});
