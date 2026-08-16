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
  '.github/workflows/build.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/pages.yml',
  'src-tauri/Cargo.toml',
  'src-tauri/tauri.conf.json',
  'src-tauri/build.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/src/storage.rs',
  'src-tauri/src/commands.rs',
  'crates/yaqmc-core/src/app_preferences.rs',
  'crates/yaqmc-core/src/logging.rs',
  'src-tauri/src/lyrics_surface/mod.rs',
  'src-tauri/src/qqmusic.rs',
  'src-tauri/src/credentials.rs',
  'src-tauri/src/qqmusic/auth.rs',
  'src-tauri/src/local_api.rs',
  'docs/migration/command-inventory.md',
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
    registeredTauriCommands: 117,
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

test('rejects a temporary repository whose workspace MSRV disagrees with Rust toolchain pins', () => {
  const root = copyFactRepository();
  const manifestPath = path.join(root, 'Cargo.toml');
  const manifest = readFileSync(manifestPath, 'utf8').replace(
    'rust-version = "1.88"',
    'rust-version = "1.89"',
  );
  writeFileSync(manifestPath, manifest);

  assert.throws(() => collectRepositoryFacts(root), /Rust requirement.*1\.89\.0.*1\.88\.0/);
});

test('rejects a member manifest that no longer inherits the workspace MSRV', () => {
  const root = copyFactRepository();
  const manifestPath = path.join(root, 'src-tauri', 'Cargo.toml');
  const manifest = readFileSync(manifestPath, 'utf8').replace(
    'rust-version.workspace = true',
    '# rust-version inheritance removed',
  );
  writeFileSync(manifestPath, manifest);

  assert.throws(
    () => collectRepositoryFacts(root),
    /src-tauri Cargo MSRV must inherit the workspace requirement/,
  );
});

test('rejects a temporary repository whose command sources disagree', () => {
  const root = copyFactRepository();
  const buildPath = path.join(root, 'src-tauri', 'build.rs');
  const source = readFileSync(buildPath, 'utf8').replace(/ {4}"platform_diagnostics",\r?\n/, '');
  writeFileSync(buildPath, source);

  assert.throws(
    () => collectRepositoryFacts(root),
    /command contract.*APP_COMMANDS.*generate_handler/,
  );
});

test('collects migrated persistence keys from their Core-owned canonical sources', () => {
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
