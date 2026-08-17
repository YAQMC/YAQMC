import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { format as formatWithPrettier } from 'prettier';
import { captureToolchainObservations } from '../perf-baseline.mjs';
import { artifactContractEntries } from './artifact-contract.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const baselineScript = path.join(repositoryRoot, 'scripts', 'perf-baseline.mjs');
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
  'crates/yaqmc-core/src/storage.rs',
  'src-tauri/src/commands.rs',
  'crates/yaqmc-core/src/app_preferences.rs',
  'crates/yaqmc-core/src/logging.rs',
  'src-tauri/src/lyrics_surface/mod.rs',
  'crates/yaqmc-core/src/qqmusic.rs',
  'crates/yaqmc-core/src/credentials.rs',
  'crates/yaqmc-core/src/qqmusic/auth.rs',
  'crates/yaqmc-core/src/local_api.rs',
  'crates/yaqmc-core/src/system_media.rs',
  'crates/yaqmc-core/src/bootstrap.rs',
  'docs/migration/command-inventory.md',
];

const REQUIRED_METRICS = [
  'coldStartInteractiveMs',
  'warmStartInteractiveMs',
  'rssBootIdle60sMiB',
  'rssPlayback30mMiB',
  'cpuPausedPercent',
  'cpuPlayingPercent',
  'cpuSeekStormPercent',
  'seekRoundTripP95Ms',
  'installerSizeMiB',
  'installedSizeMiB',
];

function pendingMeasurements() {
  return Object.fromEntries(
    ['Windows', 'Linux'].flatMap((platform) =>
      REQUIRED_METRICS.map((metric) => [`${platform}:${metric}`, { state: 'pending' }]),
    ),
  );
}

function fixture() {
  return {
    schemaVersion: 2,
    capturedAt: '2026-08-16',
    toolchains: [
      { id: 'node', name: 'Node.js', required: '24.19.0' },
      { id: 'npm', name: 'npm', required: null },
      { id: 'rustc', name: 'rustc', required: '1.88.0' },
      { id: 'cargo', name: 'Cargo', required: '1.88.0' },
    ],
    releaseArtifacts: artifactContractEntries().map(({ id }) => ({ id })),
    dataPaths: [
      {
        id: 'windows-app-data',
        platform: 'Windows',
        purpose: 'App data',
        path: '%APPDATA%\\org.yaqmc.desktop',
        state: 'source-verified',
      },
      {
        id: 'windows-cache',
        platform: 'Windows',
        purpose: 'Cache',
        path: '%LOCALAPPDATA%\\org.yaqmc.desktop',
        state: 'source-verified',
      },
      {
        id: 'windows-logs',
        platform: 'Windows',
        purpose: 'Logs',
        path: '%LOCALAPPDATA%\\org.yaqmc.desktop\\logs',
        state: 'source-verified',
      },
      {
        id: 'windows-local-api-config',
        platform: 'Windows',
        purpose: 'Local API config',
        path: '%APPDATA%\\org.yaqmc.desktop\\local-api.json',
        state: 'source-verified',
      },
      {
        id: 'linux-app-data',
        platform: 'Linux',
        purpose: 'App data',
        path: '$XDG_DATA_HOME/org.yaqmc.desktop (fallback ~/.local/share/org.yaqmc.desktop)',
        state: 'source-verified',
      },
      {
        id: 'linux-cache',
        platform: 'Linux',
        purpose: 'Cache',
        path: '$XDG_CACHE_HOME/org.yaqmc.desktop (fallback ~/.cache/org.yaqmc.desktop)',
        state: 'source-verified',
      },
      {
        id: 'linux-logs',
        platform: 'Linux',
        purpose: 'Logs',
        path: '$XDG_DATA_HOME/org.yaqmc.desktop/logs (fallback ~/.local/share/org.yaqmc.desktop/logs)',
        state: 'source-verified',
      },
      {
        id: 'linux-local-api-config',
        platform: 'Linux',
        purpose: 'Local API config',
        path: '$XDG_CONFIG_HOME/org.yaqmc.desktop/local-api.json (fallback ~/.config/org.yaqmc.desktop/local-api.json)',
        state: 'source-verified',
      },
    ],
    persistenceEntries: [
      {
        id: 'sqlite-library',
        store: 'SQLite',
        key: 'library.sqlite3 (WAL)',
        target: 'Keep in place',
      },
      {
        id: 'queue-state',
        store: 'SQLite table',
        key: 'queue_state singleton row (value_json)',
        target: 'Keep in place',
      },
      {
        id: 'audio-output-device',
        store: 'app_settings',
        key: 'audio-output-device',
        target: 'Keep exact key',
      },
      {
        id: 'logging-level',
        store: 'app_settings',
        key: 'logging.level',
        target: 'Keep exact key',
      },
      {
        id: 'preferred-quality',
        store: 'app_settings',
        key: 'preferred-quality',
        target: 'Keep exact key',
      },
      {
        id: 'preferences-schema-version',
        store: 'app_settings',
        key: 'preferences-schema-version',
        target: 'Keep exact key',
      },
      {
        id: 'ui-preferences',
        store: 'app_settings',
        key: 'ui-preferences-v1',
        target: 'Keep exact key',
      },
      {
        id: 'lyrics-geometry-desktop',
        store: 'app_settings',
        key: 'lyrics-surface-geometry:desktop',
        target: 'Keep exact key',
      },
      {
        id: 'lyrics-geometry-island',
        store: 'app_settings',
        key: 'lyrics-surface-geometry:island',
        target: 'Keep exact key',
      },
    ],
    keyring: {
      service: 'org.yaqmc.desktop',
      legacyService: 'dev.music-client.desktop',
      entries: ['qqmusic-session', 'qqmusic-session-staging', 'local-api-bearer-token'],
    },
    runtimeFacts: { registeredTauriCommands: 117, mainWindow: '1280×800 (minimum 1000×680)' },
    measurements: pendingMeasurements(),
  };
}

function observations() {
  return {
    node: 'v24.18.0',
    npm: '11.11.0',
    rustc: 'rustc 1.90.0 (fixture)',
    cargo: 'cargo 1.88.0 (fixture)',
  };
}

test('collects Node npm rustc and cargo observations through an injectable command boundary', () => {
  const outputs = new Map([
    ['npm --version', 'npm-fixture'],
    ['rustc --version', 'rustc-fixture'],
    ['cargo --version', 'cargo-fixture'],
  ]);
  const calls = [];

  const observed = captureToolchainObservations({
    nodeVersion: 'node-fixture',
    runVersion: (command, args) => {
      calls.push([command, args]);
      return outputs.get(`${command} ${args.join(' ')}`);
    },
  });

  assert.deepEqual(observed, {
    node: 'node-fixture',
    npm: 'npm-fixture',
    rustc: 'rustc-fixture',
    cargo: 'cargo-fixture',
  });
  assert.deepEqual(calls, [
    ['npm', ['--version']],
    ['rustc', ['--version']],
    ['cargo', ['--version']],
  ]);
});

function spawnBaseline(args) {
  return spawnSync(process.execPath, [baselineScript, ...args], { encoding: 'utf8' });
}

function runBaseline(snapshot, observed = observations(), repositoryRootOverride = null) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-perf-baseline-'));
  const inputPath = path.join(directory, 'snapshot.json');
  const observationsPath = path.join(directory, 'observations.json');
  const outputPath = path.join(directory, 'perf-baseline.md');
  writeFileSync(inputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(observationsPath, `${JSON.stringify(observed, null, 2)}\n`);
  const args = [
    '--input',
    inputPath,
    '--output',
    outputPath,
    '--toolchain-observations',
    observationsPath,
  ];
  if (repositoryRootOverride) args.push('--repository-root', repositoryRootOverride);
  const result = spawnBaseline(args);
  return { ...result, outputPath };
}

function runLocalBaseline(snapshot) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-perf-local-baseline-'));
  const inputPath = path.join(directory, 'snapshot.json');
  const outputPath = path.join(directory, 'perf-baseline.md');
  writeFileSync(inputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  const result = spawnBaseline(['--input', inputPath, '--output', outputPath]);
  return { ...result, outputPath };
}

function copyFactRepository() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-perf-repository-'));
  for (const relativePath of FACT_FILES) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repositoryRoot, relativePath), destination);
  }
  return root;
}

function checkedInSnapshot() {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, 'scripts', 'perf-baseline.snapshot.json'), 'utf8'),
  );
}

function replaceFactSource(root, relativePath, currentValue, driftedValue) {
  const sourcePath = path.join(root, relativePath);
  const source = readFileSync(sourcePath, 'utf8');
  const drifted = source.replace(currentValue, driftedValue);
  assert.notEqual(drifted, source, `${relativePath} fixture mutation must change the source`);
  writeFileSync(sourcePath, drifted);
}

function mutateTauriConfig(root, mutate) {
  const configPath = path.join(root, 'src-tauri', 'tauri.conf.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  mutate(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

test('renders injected toolchain observations separately from project requirements', () => {
  const result = runBaseline(fixture());

  assert.equal(result.status, 0, result.stderr);
  const output = readFileSync(result.outputPath, 'utf8');
  assert.match(output, /Node\.js\s*\|\s*24\.19\.0\s*\|\s*v24\.18\.0\s*\|\s*MISMATCH/);
  assert.match(output, /npm\s*\|\s*NOT PINNED\s*\|\s*11\.11\.0\s*\|\s*RECORDED/);
  assert.match(output, /rustc\s*\|\s*1\.88\.0\s*\|\s*rustc 1\.90\.0 \(fixture\)\s*\|\s*MISMATCH/);
  assert.match(output, /Cargo\s*\|\s*1\.88\.0\s*\|\s*cargo 1\.88\.0 \(fixture\)\s*\|\s*MATCH/);
});

test('writes canonical formatted Markdown without a follow-up formatter', async () => {
  const result = runBaseline(fixture());

  assert.equal(result.status, 0, result.stderr);
  const output = readFileSync(result.outputPath, 'utf8');
  assert.equal(output, await formatWithPrettier(output, { parser: 'markdown' }));
});

test('renders every pending metric and complete continuity and artifact facts', () => {
  const result = runBaseline(fixture());

  assert.equal(result.status, 0, result.stderr);
  const output = readFileSync(result.outputPath, 'utf8');
  assert.match(
    output,
    /Cold start to interactive \(3 runs, median\).*PENDING — manual measurement required/,
  );
  assert.match(output, /Seek round-trip p95.*PENDING — manual measurement required/);
  assert.match(output, /Installer size.*PENDING — manual measurement required/);
  assert.match(output, /Local API config.*org\.yaqmc\.desktop.*local-api\.json/);
  assert.match(output, /queue_state singleton row \(value_json\)/);
  assert.match(output, /audio-output-device/);
  assert.match(output, /logging\.level/);
  assert.match(output, /preferred-quality/);
  assert.match(output, /preferences-schema-version/);
  assert.match(output, /dev\.music-client\.desktop/);
  assert.match(output, /YAQMC-\{version\}-windows-\{arch\}-\{shortSha\}-nsis-setup\.exe/);
  assert.match(output, /YAQMC-linux-\{arch\}-portable\.tar\.gz/);
  assert.match(output, /SHA256SUMS-windows-\{arch\}\.txt/);
  assert.match(output, /README-binary\.txt/);
  assert.match(
    output,
    /`\{arch\}`: Windows uses `x86_64`, `i686`, and `aarch64`; Linux uses `x86_64` and `aarch64`/,
  );
  assert.match(output, /P0 performance gate: NOT COMPLETE/);
});

test('checked-in baseline includes every production app_settings key', () => {
  const snapshot = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'scripts', 'perf-baseline.snapshot.json'), 'utf8'),
  );
  const result = runBaseline(snapshot);

  assert.equal(result.status, 0, result.stderr);
  const output = readFileSync(result.outputPath, 'utf8');
  assert.match(output, /audio-output-device/);
  assert.match(output, /logging\.level/);
  assert.match(output, /preferred-quality/);
});

test('labels observation provenance and normalizes every Markdown table cell', () => {
  const observed = observations();
  observed.node = 'v24.19.0\r\nspoof|next-cell';
  const result = runBaseline(fixture(), observed);

  assert.equal(result.status, 0, result.stderr);
  const output = readFileSync(result.outputPath, 'utf8');
  assert.match(output, /Observation provenance: `controlled-input`/);
  assert.match(output, /v24\.19\.0<br>spoof\\\|next-cell/);
  assert.equal(output.includes('\r'), false);
  assert.equal(output.includes('\nspoof|next-cell'), false);
});

test('labels default toolchain collection as local-command provenance', () => {
  const result = runLocalBaseline(fixture());

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(result.outputPath, 'utf8'), /Observation provenance: `local-command`/);
});

test('rejects snapshot drift against an injected unchanged repository', async (t) => {
  const factRoot = copyFactRepository();
  const cases = [
    [
      'Node=0',
      (snapshot) => {
        snapshot.toolchains.find(({ id }) => id === 'node').required = '0.0.0';
      },
      /toolchains node required.*repository fact/,
    ],
    [
      'command count=0',
      (snapshot) => {
        snapshot.runtimeFacts.registeredTauriCommands = 0;
      },
      /runtimeFacts registeredTauriCommands.*repository fact/,
    ],
    [
      'window=1x1',
      (snapshot) => {
        snapshot.runtimeFacts.mainWindow = '1×1 (minimum 1×1)';
      },
      /runtimeFacts mainWindow.*repository fact/,
    ],
    [
      'wrong path',
      (snapshot) => {
        snapshot.dataPaths.find(({ id }) => id === 'windows-app-data').path = 'C:\\wrong';
      },
      /dataPaths windows-app-data path.*repository fact/,
    ],
    [
      'wrong persistence key',
      (snapshot) => {
        snapshot.persistenceEntries.find(({ id }) => id === 'audio-output-device').key =
          'wrong-key';
      },
      /persistenceEntries audio-output-device key.*repository fact/,
    ],
    [
      'wrong keyring service',
      (snapshot) => {
        snapshot.keyring.service = 'wrong.service';
      },
      /keyring service.*repository fact/,
    ],
  ];

  for (const [name, mutateSnapshot, expectedError] of cases) {
    await t.test(name, () => {
      const snapshot = fixture();
      mutateSnapshot(snapshot);
      const result = runBaseline(snapshot, observations(), factRoot);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expectedError);
    });
  }
});

test('rejects production source drift in an injected repository with the canonical snapshot unchanged', async (t) => {
  const cases = [
    [
      'main window dimensions',
      (root) =>
        mutateTauriConfig(root, (config) => {
          const main = config.app.windows.find(({ label }) => label === 'main');
          Object.assign(main, { width: 1, height: 1, minWidth: 1, minHeight: 1 });
        }),
      /runtimeFacts mainWindow.*repository fact/,
    ],
    [
      'identifier-derived paths',
      (root) =>
        mutateTauriConfig(root, (config) => {
          config.identifier = 'org.yaqmc.drifted';
        }),
      /dataPaths windows-app-data path.*repository fact/,
    ],
    [
      'app_settings key constant',
      (root) =>
        replaceFactSource(
          root,
          'src-tauri/src/commands.rs',
          '"audio-output-device"',
          '"audio-output-device-drifted"',
        ),
      /persistenceEntries audio-output-device key.*repository fact/,
    ],
    [
      'keyring service constant',
      (root) =>
        replaceFactSource(
          root,
          'crates/yaqmc-core/src/credentials.rs',
          '"org.yaqmc.desktop"',
          '"org.yaqmc.drifted"',
        ),
      /keyring service.*repository fact/,
    ],
    [
      'keyring account constant',
      (root) =>
        replaceFactSource(
          root,
          'crates/yaqmc-core/src/local_api.rs',
          '"local-api-bearer-token"',
          '"local-api-bearer-token-drifted"',
        ),
      /keyring entries.*repository fact/,
    ],
  ];

  for (const [name, mutateSource, expectedError] of cases) {
    await t.test(name, () => {
      const factRoot = copyFactRepository();
      const snapshot = checkedInSnapshot();
      mutateSource(factRoot);

      const result = runBaseline(snapshot, observations(), factRoot);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expectedError);
    });
  }
});

test('keeps only artifact IDs in the snapshot and delegates names to the executable contract', () => {
  const snapshot = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'scripts', 'perf-baseline.snapshot.json'), 'utf8'),
  );
  assert.deepEqual(
    snapshot.releaseArtifacts,
    artifactContractEntries().map(({ id }) => ({ id })),
  );
});

test('rejects copied artifact metadata in the snapshot', () => {
  const snapshot = fixture();
  snapshot.releaseArtifacts[0].pattern = 'copied-pattern';
  const result = runBaseline(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /releaseArtifacts.*only id/);
});

test('rejects snapshots that omit a required measurement instead of substituting a value', () => {
  const snapshot = fixture();
  delete snapshot.measurements['Linux:seekRoundTripP95Ms'];
  const result = runBaseline(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Linux:seekRoundTripP95Ms/);
});

test('rejects missing required collection entries', async (t) => {
  const cases = [
    ['toolchains', 'cargo'],
    ['dataPaths', 'windows-local-api-config'],
    ['persistenceEntries', 'queue-state'],
    ['releaseArtifacts', 'ci-linux-readme'],
  ];
  for (const [collection, id] of cases) {
    await t.test(`${collection} requires ${id}`, () => {
      const snapshot = fixture();
      snapshot[collection] = snapshot[collection].filter((entry) => entry.id !== id);
      const result = runBaseline(snapshot);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(id));
    });
  }
  await t.test('keyring requires every persisted entry', () => {
    const snapshot = fixture();
    snapshot.keyring.entries = snapshot.keyring.entries.filter(
      (entry) => entry !== 'local-api-bearer-token',
    );
    const result = runBaseline(snapshot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local-api-bearer-token/);
  });
});

test('rejects empty required collections', async (t) => {
  for (const collection of ['toolchains', 'dataPaths', 'persistenceEntries', 'releaseArtifacts']) {
    await t.test(collection, () => {
      const snapshot = fixture();
      snapshot[collection] = [];
      const result = runBaseline(snapshot);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(collection));
    });
  }
  await t.test('keyring entries', () => {
    const snapshot = fixture();
    snapshot.keyring.entries = [];
    const result = runBaseline(snapshot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /keyring entries/);
  });
});

test('rejects negative measured values', () => {
  const snapshot = fixture();
  snapshot.measurements['Windows:seekRoundTripP95Ms'] = { state: 'measured', value: -0.1 };
  const result = runBaseline(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Windows:seekRoundTripP95Ms.*non-negative/);
});

test('--help prints usage and exits successfully', () => {
  const result = spawnBaseline(['--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/);
  assert.equal(result.stderr, '');
});

test('an option followed by another flag reports the missing value', () => {
  const result = spawnBaseline(['--input', '--output', 'unused.md']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing value for --input/);
});
