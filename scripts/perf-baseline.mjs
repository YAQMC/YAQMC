import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format as formatWithPrettier } from 'prettier';

const REQUIRED_METRICS = [
  ['coldStartInteractiveMs', 'Cold start to interactive (3 runs, median)', 'ms'],
  ['warmStartInteractiveMs', 'Warm start to interactive', 'ms'],
  ['rssBootIdle60sMiB', 'RSS after boot idle (60 s)', 'MiB'],
  ['rssPlayback30mMiB', 'RSS after 30 min playback', 'MiB'],
  ['cpuPausedPercent', 'CPU while paused', '%'],
  ['cpuPlayingPercent', 'CPU while playing (idle UI)', '%'],
  ['cpuSeekStormPercent', 'CPU during rapid-seek storm', '%'],
  ['seekRoundTripP95Ms', 'Seek round-trip p95', 'ms'],
  ['installerSizeMiB', 'Installer size', 'MiB'],
  ['installedSizeMiB', 'Installed size', 'MiB'],
];

const PLATFORMS = ['Windows', 'Linux'];
const REQUIRED_ARTIFACT_PATTERNS = {
  'ci-windows-nsis': 'YAQMC-{version}-windows-{arch}-{shortSha}-nsis-setup.exe',
  'ci-windows-msi': 'YAQMC-{version}-windows-{arch}-{shortSha}-msi.msi',
  'ci-windows-portable': 'YAQMC-{version}-windows-{arch}-{shortSha}-portable.zip',
  'ci-linux-appimage': 'YAQMC-{version}-linux-{arch}-{shortSha}.AppImage',
  'ci-linux-deb': 'YAQMC-{version}-linux-{arch}-{shortSha}.deb',
  'ci-linux-rpm': 'YAQMC-{version}-linux-{arch}-{shortSha}.rpm',
  'ci-linux-binary': 'YAQMC-{version}-linux-{arch}-{shortSha}-binary.tar.gz',
  'ci-linux-readme': 'README-binary.txt',
  'ci-build-info': 'build-info.json',
  'ci-checksum': 'SHA256SUMS-{os}-{arch}.txt',
  'release-windows-nsis': 'YAQMC-windows-{arch}-{tauri-bundle-filename}',
  'release-windows-msi': 'YAQMC-windows-{arch}-{tauri-bundle-filename}',
  'release-windows-portable': 'YAQMC-windows-{arch}-portable.zip',
  'release-windows-checksum': 'SHA256SUMS-windows-{arch}.txt',
  'release-linux-appimage': '{tauri-bundle-filename}',
  'release-linux-deb': '{tauri-bundle-filename}',
  'release-linux-rpm': '{tauri-bundle-filename}',
  'release-linux-portable': 'YAQMC-linux-{arch}-portable.tar.gz',
  'release-linux-tester': 'YAQMC-linux-x86_64-tester.tar.gz',
  'release-linux-checksum': 'SHA256SUMS-linux-{arch}.txt',
};
const REQUIRED_IDS = {
  toolchains: ['node', 'npm', 'rustc', 'cargo'],
  dataPaths: [
    'windows-app-data',
    'windows-cache',
    'windows-logs',
    'windows-local-api-config',
    'linux-app-data',
    'linux-cache',
    'linux-logs',
    'linux-local-api-config',
  ],
  persistenceEntries: [
    'sqlite-library',
    'queue-state',
    'preferences-schema-version',
    'ui-preferences',
    'lyrics-geometry-desktop',
    'lyrics-geometry-island',
  ],
  releaseArtifacts: Object.keys(REQUIRED_ARTIFACT_PATTERNS),
};
const REQUIRED_KEYRING_ENTRIES = [
  'qqmusic-session',
  'qqmusic-session-staging',
  'local-api-bearer-token',
];

function usage() {
  return [
    'Usage: node scripts/perf-baseline.mjs [options]',
    '',
    'Options:',
    '  --input <snapshot.json>',
    '  --output <perf-baseline.md>',
    '  --toolchain-observations <observations.json>  Use controlled observations instead of local commands',
    '  --help',
  ].join('\n');
}

function options(argv) {
  const result = {
    input: 'scripts/perf-baseline.snapshot.json',
    output: 'docs/migration/perf-baseline.md',
    toolchainObservations: null,
    help: false,
  };
  const valueOptions = new Map([
    ['--input', 'input'],
    ['--output', 'output'],
    ['--toolchain-observations', 'toolchainObservations'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      result.help = true;
      continue;
    }
    const property = valueOptions.get(argument);
    if (!property) throw new Error(`unknown argument: ${argument}\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
    result[property] = value;
    index += 1;
  }
  return result;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${label} must be a non-empty string`);
}

function requireCollection(snapshot, name) {
  const collection = snapshot[name];
  if (!Array.isArray(collection) || collection.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  const ids = new Set();
  for (const entry of collection) {
    requireString(entry?.id, `${name} entry id`);
    if (ids.has(entry.id)) throw new Error(`${name} contains duplicate id ${entry.id}`);
    ids.add(entry.id);
  }
  for (const id of REQUIRED_IDS[name]) {
    if (!ids.has(id)) throw new Error(`${name} is missing required entry ${id}`);
  }
  return collection;
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 2) {
    throw new Error('snapshot must use schemaVersion 2');
  }
  requireString(snapshot.capturedAt, 'capturedAt');

  for (const [metric] of REQUIRED_METRICS) {
    for (const platform of PLATFORMS) {
      const key = `${platform}:${metric}`;
      const measurement = snapshot.measurements?.[key];
      if (!measurement) throw new Error(`snapshot is missing required measurement ${key}`);
      if (measurement.state === 'pending') continue;
      if (
        measurement.state === 'measured' &&
        Number.isFinite(measurement.value) &&
        measurement.value >= 0
      ) {
        continue;
      }
      throw new Error(
        `${key} must be pending or measured with a finite non-negative numeric value`,
      );
    }
  }

  const toolchains = requireCollection(snapshot, 'toolchains');
  for (const toolchain of toolchains) {
    requireString(toolchain.name, `toolchains ${toolchain.id} name`);
    if (toolchain.required !== null)
      requireString(toolchain.required, `toolchains ${toolchain.id} required`);
  }

  const dataPaths = requireCollection(snapshot, 'dataPaths');
  for (const dataPath of dataPaths) {
    requireString(dataPath.platform, `dataPaths ${dataPath.id} platform`);
    requireString(dataPath.purpose, `dataPaths ${dataPath.id} purpose`);
    requireString(dataPath.path, `dataPaths ${dataPath.id} path`);
    requireString(dataPath.state, `dataPaths ${dataPath.id} state`);
  }

  const persistenceEntries = requireCollection(snapshot, 'persistenceEntries');
  for (const entry of persistenceEntries) {
    requireString(entry.store, `persistenceEntries ${entry.id} store`);
    requireString(entry.key, `persistenceEntries ${entry.id} key`);
    requireString(entry.target, `persistenceEntries ${entry.id} target`);
  }

  const releaseArtifacts = requireCollection(snapshot, 'releaseArtifacts');
  for (const artifact of releaseArtifacts) {
    requireString(artifact.source, `releaseArtifacts ${artifact.id} source`);
    requireString(artifact.platform, `releaseArtifacts ${artifact.id} platform`);
    requireString(artifact.kind, `releaseArtifacts ${artifact.id} kind`);
    requireString(artifact.pattern, `releaseArtifacts ${artifact.id} pattern`);
    if (artifact.pattern !== REQUIRED_ARTIFACT_PATTERNS[artifact.id]) {
      throw new Error(
        `releaseArtifacts ${artifact.id} pattern must be ${REQUIRED_ARTIFACT_PATTERNS[artifact.id]}`,
      );
    }
  }

  if (
    !snapshot.keyring ||
    !Array.isArray(snapshot.keyring.entries) ||
    snapshot.keyring.entries.length === 0
  ) {
    throw new Error('keyring entries must be a non-empty array');
  }
  requireString(snapshot.keyring.service, 'keyring service');
  requireString(snapshot.keyring.legacyService, 'keyring legacyService');
  for (const entry of REQUIRED_KEYRING_ENTRIES) {
    if (!snapshot.keyring.entries.includes(entry)) {
      throw new Error(`keyring entries is missing required entry ${entry}`);
    }
  }
  for (const entry of snapshot.keyring.entries) requireString(entry, 'keyring entry');

  if (
    !Number.isInteger(snapshot.runtimeFacts?.registeredTauriCommands) ||
    snapshot.runtimeFacts.registeredTauriCommands < 0
  ) {
    throw new Error('runtimeFacts registeredTauriCommands must be a non-negative integer');
  }
  requireString(snapshot.runtimeFacts.mainWindow, 'runtimeFacts mainWindow');
}

function commandOutput(command, args) {
  try {
    const executable = process.platform === 'win32' && command === 'npm' ? 'cmd.exe' : command;
    const commandArgs =
      process.platform === 'win32' && command === 'npm'
        ? ['/d', '/s', '/c', 'npm --version']
        : args;
    return execFileSync(executable, commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'UNAVAILABLE';
  }
}

export function captureToolchainObservations({
  nodeVersion = process.version,
  runVersion = commandOutput,
} = {}) {
  return {
    node: nodeVersion,
    npm: runVersion('npm', ['--version']),
    rustc: runVersion('rustc', ['--version']),
    cargo: runVersion('cargo', ['--version']),
  };
}

function validateObservations(toolchains, observations) {
  if (!observations || typeof observations !== 'object' || Array.isArray(observations)) {
    throw new Error('toolchain observations must be an object');
  }
  for (const toolchain of toolchains) {
    requireString(observations[toolchain.id], `toolchain observation ${toolchain.id}`);
  }
}

function observedVersion(value) {
  return /(?:^|\s|v)(\d+\.\d+\.\d+)(?:\s|$)/.exec(value)?.[1] ?? null;
}

function toolchainState(toolchain, observed) {
  if (observed === 'UNAVAILABLE') return 'UNAVAILABLE';
  if (toolchain.required === null) return 'RECORDED';
  return observedVersion(observed) === toolchain.required ? 'MATCH' : 'MISMATCH';
}

function formatMeasurement(measurement, unit) {
  if (measurement.state === 'pending') return 'PENDING — manual measurement required';
  return `${measurement.value} ${unit}`;
}

function table(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderBaseline(snapshot, observations) {
  validateSnapshot(snapshot);
  validateObservations(snapshot.toolchains, observations);
  const lines = [
    '# Performance and artifact baseline',
    '',
    `Baseline facts captured: ${snapshot.capturedAt}. This document is generated by \`npm run perf:baseline\` from \`scripts/perf-baseline.snapshot.json\`. Toolchain observations are captured when the command runs; they are not stored as source facts in the snapshot.`,
    '',
    '**P0 performance gate: NOT COMPLETE.** Windows and Linux live performance, installed-size, and diagnostics measurements remain pending.',
    '',
    'No pending item is an estimate or zero. It requires the documented manual protocol on a current Tauri build.',
    '',
    '## Toolchain requirements and capture observations',
    '',
    '| Toolchain | Project required | Observed by this capture | State |',
    '|---|---|---|---|',
    table(
      snapshot.toolchains.map((toolchain) => [
        toolchain.name,
        toolchain.required ?? 'NOT PINNED',
        observations[toolchain.id],
        toolchainState(toolchain, observations[toolchain.id]),
      ]),
    ),
    '',
    '| Runtime fact | Value |',
    '|---|---|',
    table([
      ['Registered Tauri commands', String(snapshot.runtimeFacts.registeredTauriCommands)],
      ['Main window target', snapshot.runtimeFacts.mainWindow],
    ]),
    '',
    '## Manual performance and size measurements',
    '',
    'Protocol: use three clean cold starts and report their median; measure warm start separately; sum the host processes for RSS and CPU. Collect all rows on the Windows and Linux primary development machines before treating this baseline as a release gate.',
    '',
    '| Metric | Windows | Linux |',
    '|---|---|---|',
    table(
      REQUIRED_METRICS.map(([metric, label, unit]) => [
        label,
        formatMeasurement(snapshot.measurements[`Windows:${metric}`], unit),
        formatMeasurement(snapshot.measurements[`Linux:${metric}`], unit),
      ]),
    ),
    '',
    '## Current Tauri release artifact name patterns',
    '',
    '| Source | Platform | Artifact | Checked-in name/pattern |',
    '|---|---|---|---|',
    table(
      snapshot.releaseArtifacts.map((artifact) => [
        `\`${artifact.source}\``,
        artifact.platform,
        artifact.kind,
        `\`${artifact.pattern}\``,
      ]),
    ),
    '',
    'Placeholders are literal pattern variables from the staging workflow. `{arch}`: Windows uses `x86_64`, `i686`, and `aarch64`; Linux uses `x86_64` and `aarch64`. `{os}` is `windows` or `linux`; `{shortSha}` is the first seven Git commit characters; `{version}` is the Tauri app version. Tauri-produced bundle filename placeholders intentionally preserve the upstream basename. No Electron artifact is introduced here.',
    '',
    '## Data continuity facts',
    '',
    '| Platform | Purpose | Current/target path | Evidence state | Live diagnostics |',
    '|---|---|---|---|---|',
    table(
      snapshot.dataPaths.map((dataPath) => [
        dataPath.platform,
        dataPath.purpose,
        `\`${dataPath.path}\``,
        dataPath.state.toUpperCase(),
        'PENDING — manual measurement required',
      ]),
    ),
    '',
    '## Persistence schema and keys',
    '',
    '| Store | Current entry | Target rule |',
    '|---|---|---|',
    table(
      snapshot.persistenceEntries.map((entry) => [entry.store, `\`${entry.key}\``, entry.target]),
    ),
    '',
    `Keyring service: \`${snapshot.keyring.service}\`; legacy read-migration service: \`${snapshot.keyring.legacyService}\`.`,
    '',
    `Persisted keyring entries: ${snapshot.keyring.entries.map((entry) => `\`${entry}\``).join(', ')}.`,
    '',
    'The path values above are source-verified expectations. Export and attach a live Tauri diagnostics snapshot on Windows and Linux to promote each platform/path row to live-verified.',
    '',
  ];
  return lines.join('\n');
}

function invokedDirectly() {
  return (
    Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (invokedDirectly()) {
  try {
    const parsed = options(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      const snapshot = JSON.parse(readFileSync(parsed.input, 'utf8'));
      const observations = parsed.toolchainObservations
        ? JSON.parse(readFileSync(parsed.toolchainObservations, 'utf8'))
        : captureToolchainObservations();
      writeFileSync(
        parsed.output,
        await formatWithPrettier(renderBaseline(snapshot, observations), { parser: 'markdown' }),
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
