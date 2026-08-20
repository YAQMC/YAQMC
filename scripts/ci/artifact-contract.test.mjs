import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { artifactContractEntries } from './artifact-contract.mjs';
import { repositoryRoot } from './repo.mjs';

test('artifact contract describes only current Electron packages and release metadata', () => {
  const entries = artifactContractEntries();
  assert.equal(entries.length, 10);
  assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);
  assert.ok(entries.every(({ id }) => id.startsWith('electron-')));
  assert.ok(
    entries.every(({ source, platform, kind, pattern }) => source && platform && kind && pattern),
  );

  const builder = readFileSync(
    path.join(repositoryRoot, 'apps/desktop/electron-builder.yml'),
    'utf8',
  );
  for (const target of ['nsis', 'portable', 'AppImage', 'deb', 'rpm', 'tar.gz']) {
    assert.match(builder, new RegExp(target.replace('.', '\\.')));
  }
  const workflow = readFileSync(
    path.join(repositoryRoot, '.github/workflows/electron-release.yml'),
    'utf8',
  );
  assert.match(workflow, /assemble-electron-release\.mjs/);
  assert.match(workflow, /gh release create/);
});
