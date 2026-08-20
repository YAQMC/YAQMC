import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectRepositoryFacts } from './repository-facts.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const FACT_FILES = [
  '.node-version',
  'package.json',
  'package-lock.json',
  'Cargo.toml',
  '.github/actions/setup-packaging/action.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/electron-release.yml',
  '.github/workflows/pages.yml',
  'apps/desktop/electron-builder.yml',
  'apps/desktop/main/index.ts',
  'apps/desktop/main/core/paths.ts',
  'apps/desktop/main/windows/lyrics-surfaces.ts',
  'packages/yaqmc-client/fixtures/methods.json',
  'crates/yaqmc-core/src/storage.rs',
  'crates/yaqmc-core/src/audio.rs',
  'crates/yaqmc-core/src/app_preferences.rs',
  'crates/yaqmc-core/src/logging.rs',
  'crates/yaqmc-provider-qqmusic/src/qqmusic.rs',
  'crates/yaqmc-core/src/credentials.rs',
  'crates/yaqmc-provider-qqmusic/src/qqmusic/auth.rs',
  'crates/yaqmc-core/src/local_api.rs',
  'crates/yaqmc-core/src/system_media.rs',
  'crates/yaqmc-core/src/bootstrap.rs',
];

function copyFactRepository() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-repository-facts-'));
  for (const relativePath of FACT_FILES) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repositoryRoot, relativePath), destination);
  }
  return root;
}

test('collects canonical requirements and continuity facts from production repository sources', () => {
  const facts = collectRepositoryFacts(repositoryRoot);
  assert.deepEqual(facts.toolchains, {
    node: '24.19.0',
    npm: null,
    rustc: '1.88.0',
    cargo: '1.88.0',
  });
  assert.deepEqual(facts.runtimeFacts, {
    registeredProtocolMethods: 126,
    mainWindow: '1280×800 (minimum 1000×680)',
  });
  assert.deepEqual(
    facts.persistenceEntries.map(({ id, key }) => [id, key]),
    [
      ['sqlite-library', 'library.sqlite3 (WAL)'],
      ['queue-state', 'queue_state singleton row (value_json)'],
      ['audio-output-device', 'audio-output-device'],
      ['logging-level', 'logging.level'],
      ['preferred-quality', 'preferred-quality'],
      ['preferences-schema-version', 'preferences-schema-version'],
      ['ui-preferences', 'ui-preferences-v1'],
      ['lyrics-geometry-desktop', 'lyrics-surface-geometry:desktop'],
      ['lyrics-geometry-island', 'lyrics-surface-geometry:island'],
    ],
  );
  assert.deepEqual(facts.keyring, {
    service: 'org.yaqmc.desktop',
    legacyService: 'dev.music-client.desktop',
    entries: ['qqmusic-session', 'qqmusic-session-staging', 'local-api-bearer-token'],
  });
});

test('rejects a temporary repository whose Node pins disagree', () => {
  const root = copyFactRepository();
  writeFileSync(path.join(root, '.node-version'), '0.0.0\n');
  assert.throws(() => collectRepositoryFacts(root), /Node requirement.*0\.0\.0.*24\.19\.0/);
});

test('rejects a temporary repository whose workspace MSRV disagrees with workflow pins', () => {
  const root = copyFactRepository();
  const manifestPath = path.join(root, 'Cargo.toml');
  writeFileSync(
    manifestPath,
    readFileSync(manifestPath, 'utf8').replace('rust-version = "1.88"', 'rust-version = "1.89"'),
  );
  assert.throws(() => collectRepositoryFacts(root), /Rust requirement.*1\.89\.0.*1\.88\.0/);
});

test('rejects app identity drift between packaging and Core paths', () => {
  const root = copyFactRepository();
  const builderPath = path.join(root, 'apps', 'desktop', 'electron-builder.yml');
  writeFileSync(
    builderPath,
    readFileSync(builderPath, 'utf8').replace('appId: org.yaqmc.desktop', 'appId: drifted.id'),
  );
  assert.throws(() => collectRepositoryFacts(root), /appId and Core path identifier must match/);
});

test('collects persistence keys from Core and Electron-owned canonical sources', () => {
  const root = copyFactRepository();
  const loggingPath = path.join(root, 'crates', 'yaqmc-core', 'src', 'logging.rs');
  writeFileSync(
    loggingPath,
    readFileSync(loggingPath, 'utf8').replace('"logging.level"', '"logging.level.drifted"'),
  );
  const facts = collectRepositoryFacts(root);
  assert.equal(
    facts.persistenceEntries.find(({ id }) => id === 'logging-level')?.key,
    'logging.level.drifted',
  );
});

test('rejects storage and host-command boundary drift', () => {
  const storageRoot = copyFactRepository();
  const storagePath = path.join(storageRoot, 'crates', 'yaqmc-core', 'src', 'storage.rs');
  writeFileSync(
    storagePath,
    readFileSync(storagePath, 'utf8').replaceAll('library.sqlite3', 'drifted.sqlite3'),
  );
  assert.throws(
    () => collectRepositoryFacts(storageRoot),
    /SQLite library\.sqlite3 WAL contract is missing/,
  );

  const hostRoot = copyFactRepository();
  const mainPath = path.join(hostRoot, 'apps', 'desktop', 'main', 'index.ts');
  writeFileSync(
    mainPath,
    readFileSync(mainPath, 'utf8').replace('subscribeHostCommands(instance.client', 'removed('),
  );
  assert.throws(() => collectRepositoryFacts(hostRoot), /must subscribe to Core host commands/);
});
