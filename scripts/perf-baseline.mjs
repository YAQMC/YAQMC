import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format as formatWithPrettier } from 'prettier';
import { artifactContractEntries } from './ci/artifact-contract.mjs';
import { collectRepositoryFacts } from './ci/repository-facts.mjs';
import { repositoryRoot as defaultRepositoryRoot } from './ci/repo.mjs';

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
const ARTIFACT_CONTRACT = artifactContractEntries();
const ARTIFACT_CONTRACT_BY_ID = new Map(ARTIFACT_CONTRACT.map((entry) => [entry.id, entry]));
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
    'audio-output-device',
    'logging-level',
    'preferred-quality',
    'preferences-schema-version',
    'ui-preferences',
    'lyrics-geometry-desktop',
    'lyrics-geometry-island',
  ],
  releaseArtifacts: ARTIFACT_CONTRACT.map(({ id }) => id),
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
    '  --repository-root <repository>  Validate facts from an injected repository root',
    '  --help',
  ].join('\n');
}

function options(argv) {
  const result = {
    input: 'scripts/perf-baseline.snapshot.json',
    output: 'docs/migration/perf-baseline.md',
    toolchainObservations: null,
    repositoryRoot: defaultRepositoryRoot,
    help: false,
  };
  const valueOptions = new Map([
    ['--input', 'input'],
    ['--output', 'output'],
    ['--toolchain-observations', 'toolchainObservations'],
    ['--repository-root', 'repositoryRoot'],
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

function requireRepositoryValue(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} must match repository fact ${JSON.stringify(expected)} (received ${JSON.stringify(actual)})`,
    );
  }
}

function requireRepositoryCollection(collection, facts, name, fields) {
  if (collection.length !== facts.length) {
    throw new Error(`${name} must contain exactly ${facts.length} repository fact entries`);
  }
  const factsById = new Map(facts.map((entry) => [entry.id, entry]));
  for (const entry of collection) {
    const fact = factsById.get(entry.id);
    if (!fact) throw new Error(`${name} ${entry.id} is not a repository fact`);
    for (const field of fields) {
      requireRepositoryValue(entry[field], fact[field], `${name} ${entry.id} ${field}`);
    }
  }
}

function validateSnapshot(snapshot, repositoryFacts) {
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
  if (toolchains.length !== Object.keys(repositoryFacts.toolchains).length) {
    throw new Error('toolchains must contain exactly the repository fact entries');
  }
  for (const toolchain of toolchains) {
    requireString(toolchain.name, `toolchains ${toolchain.id} name`);
    if (toolchain.required !== null)
      requireString(toolchain.required, `toolchains ${toolchain.id} required`);
    if (!Object.hasOwn(repositoryFacts.toolchains, toolchain.id)) {
      throw new Error(`toolchains ${toolchain.id} is not a repository fact`);
    }
    requireRepositoryValue(
      toolchain.required,
      repositoryFacts.toolchains[toolchain.id],
      `toolchains ${toolchain.id} required`,
    );
  }

  const dataPaths = requireCollection(snapshot, 'dataPaths');
  for (const dataPath of dataPaths) {
    requireString(dataPath.platform, `dataPaths ${dataPath.id} platform`);
    requireString(dataPath.purpose, `dataPaths ${dataPath.id} purpose`);
    requireString(dataPath.path, `dataPaths ${dataPath.id} path`);
    requireString(dataPath.state, `dataPaths ${dataPath.id} state`);
  }
  requireRepositoryCollection(dataPaths, repositoryFacts.dataPaths, 'dataPaths', [
    'platform',
    'purpose',
    'path',
    'state',
  ]);

  const persistenceEntries = requireCollection(snapshot, 'persistenceEntries');
  for (const entry of persistenceEntries) {
    requireString(entry.store, `persistenceEntries ${entry.id} store`);
    requireString(entry.key, `persistenceEntries ${entry.id} key`);
    requireString(entry.target, `persistenceEntries ${entry.id} target`);
  }
  requireRepositoryCollection(
    persistenceEntries,
    repositoryFacts.persistenceEntries,
    'persistenceEntries',
    ['store', 'key', 'target'],
  );

  const releaseArtifacts = requireCollection(snapshot, 'releaseArtifacts');
  if (releaseArtifacts.length !== ARTIFACT_CONTRACT.length) {
    throw new Error(
      `releaseArtifacts must contain exactly ${ARTIFACT_CONTRACT.length} artifact contract entries`,
    );
  }
  for (const artifact of releaseArtifacts) {
    if (!ARTIFACT_CONTRACT_BY_ID.has(artifact.id)) {
      throw new Error(`releaseArtifacts ${artifact.id} is not in artifact contract`);
    }
    if (Object.keys(artifact).length !== 1) {
      throw new Error(`releaseArtifacts ${artifact.id} must contain only id`);
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
  requireRepositoryValue(
    snapshot.keyring.service,
    repositoryFacts.keyring.service,
    'keyring service',
  );
  requireRepositoryValue(
    snapshot.keyring.legacyService,
    repositoryFacts.keyring.legacyService,
    'keyring legacyService',
  );
  if (
    snapshot.keyring.entries.length !== repositoryFacts.keyring.entries.length ||
    !snapshot.keyring.entries.every((entry) => repositoryFacts.keyring.entries.includes(entry))
  ) {
    throw new Error('keyring entries must match repository fact entries');
  }

  if (
    !Number.isInteger(snapshot.runtimeFacts?.registeredTauriCommands) ||
    snapshot.runtimeFacts.registeredTauriCommands < 0
  ) {
    throw new Error('runtimeFacts registeredTauriCommands must be a non-negative integer');
  }
  requireString(snapshot.runtimeFacts.mainWindow, 'runtimeFacts mainWindow');
  requireRepositoryValue(
    snapshot.runtimeFacts.registeredTauriCommands,
    repositoryFacts.runtimeFacts.registeredTauriCommands,
    'runtimeFacts registeredTauriCommands',
  );
  requireRepositoryValue(
    snapshot.runtimeFacts.mainWindow,
    repositoryFacts.runtimeFacts.mainWindow,
    'runtimeFacts mainWindow',
  );
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

function markdownCell(value) {
  return String(value).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>').replace(/\|/g, '\\|');
}

function table(rows) {
  return rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`).join('\n');
}

export function renderBaseline(
  snapshot,
  observations,
  {
    repositoryFacts = collectRepositoryFacts(defaultRepositoryRoot),
    observationProvenance = 'controlled-input',
  } = {},
) {
  validateSnapshot(snapshot, repositoryFacts);
  validateObservations(snapshot.toolchains, observations);
  const lines = [
    '# Performance and artifact baseline',
    '',
    `Baseline facts captured: ${snapshot.capturedAt}. This document is generated by \`npm run perf:baseline\` from \`scripts/perf-baseline.snapshot.json\`. Toolchain observations are supplied at generation time with their provenance labeled below; they are not stored as source facts in the snapshot.`,
    '',
    '**P0 performance gate: NOT COMPLETE.** Windows and Linux live performance, installed-size, and diagnostics measurements remain pending.',
    '',
    'No pending item is an estimate or zero. It requires the documented manual protocol on a current Tauri build.',
    '',
    '## Toolchain requirements and capture observations',
    '',
    `Observation provenance: \`${observationProvenance}\`. \`local-command\` means this generator executed version commands on the current host; \`controlled-input\` means the caller supplied an isolated observations JSON file.`,
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
      ARTIFACT_CONTRACT.map((artifact) => [
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
      const repositoryFacts = collectRepositoryFacts(path.resolve(parsed.repositoryRoot));
      writeFileSync(
        parsed.output,
        await formatWithPrettier(
          renderBaseline(snapshot, observations, {
            repositoryFacts,
            observationProvenance: parsed.toolchainObservations
              ? 'controlled-input'
              : 'local-command',
          }),
          { parser: 'markdown' },
        ),
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
