import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { artifactContractEntries } from './artifact-contract.mjs';
import { repositoryRoot } from './repo.mjs';

test('artifact contract describes current desktop, Android, and release metadata', () => {
  const entries = artifactContractEntries();
  assert.equal(entries.length, 20);
  assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);
  assert.ok(
    entries.every(
      ({ id }) => id.startsWith('electron-') || id.startsWith('android-') || id === 'release-notes',
    ),
  );
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
  assert.match(workflow, /assemble-release\.mjs/);
  assert.match(workflow, /node scripts\/build-android\.mjs/);
  assert.match(workflow, /\.\/\.github\/actions\/setup-android/);
  assert.match(workflow, /secrets\.ANDROID_RELEASE_KEYSTORE_BASE64/);
  assert.match(workflow, /secrets\.ANDROID_RELEASE_CERT_SHA256/);
  assert.match(workflow, /verify --verbose --print-certs/);
  assert.match(workflow, /YAQMC-android-arm64-v8a-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /--notes-file assembled\/RELEASE-NOTES\.md/);
  assert.match(workflow, /corresponding-source\.mjs/);
  assert.match(workflow, /repository: YAQMC\/qm-api-rs/);
  assert.match(workflow, /stage-linux-tester\.mjs/);
  assert.match(workflow, /YAQMC-linux-x64-tester-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /gh release create/);
});
