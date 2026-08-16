import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function read(repositoryRoot, relativePath) {
  try {
    return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
  } catch (error) {
    throw new Error(`repository fact source is missing: ${relativePath}`, { cause: error });
  }
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolutePath));
    else files.push(absolutePath);
  }
  return files;
}

function workflowText(repositoryRoot) {
  const githubRoot = path.join(repositoryRoot, '.github');
  return walk(githubRoot)
    .filter((file) => /\.ya?ml$/i.test(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

function exactPins(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]);
}

function normalizeRustVersion(version) {
  return /^\d+\.\d+$/.test(version) ? `${version}.0` : version;
}

function workspacePackageValue(source, key) {
  const packageSection = /^\[workspace\.package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(
    source,
  )?.[1];
  return new RegExp(`(?:^|\\n)${key}\\s*=\\s*"([^"]+)"`).exec(packageSection ?? '')?.[1];
}

function collectToolchains(repositoryRoot) {
  const node = read(repositoryRoot, '.node-version').trim();
  const packageNode = JSON.parse(read(repositoryRoot, 'package.json')).engines?.node;
  const lockNode = JSON.parse(read(repositoryRoot, 'package-lock.json')).packages?.['']?.engines
    ?.node;
  const workflows = workflowText(repositoryRoot);
  const setupNodeCount = (workflows.match(/uses:\s*actions\/setup-node@[^\s#]+/g) ?? []).length;
  const setupNodePins = exactPins(
    workflows,
    /^\s*node-version:\s*['"]?([^\s'"#]+)['"]?\s*(?:#.*)?$/gm,
  );
  const nodePins = [packageNode, lockNode, ...setupNodePins];
  if (
    !node ||
    setupNodeCount === 0 ||
    setupNodePins.length !== setupNodeCount ||
    nodePins.some((pin) => pin !== node)
  ) {
    throw new Error(
      `Node requirement ${node || '(missing)'} disagrees with repository pins: ${nodePins.join(', ')}`,
    );
  }

  const workspaceCargoToml = read(repositoryRoot, 'Cargo.toml');
  const workspaceMsrv = workspacePackageValue(workspaceCargoToml, 'rust-version');
  const cargoToml = read(repositoryRoot, 'src-tauri/Cargo.toml');
  if (!/(?:^|\n)rust-version\.workspace\s*=\s*true\s*(?:\n|$)/.test(cargoToml)) {
    throw new Error('src-tauri Cargo MSRV must inherit the workspace requirement');
  }
  const normalizedMsrv = workspaceMsrv ? normalizeRustVersion(workspaceMsrv) : null;
  const rustActionCount = (workflows.match(/uses:\s*dtolnay\/rust-toolchain@[^\s#]+/g) ?? [])
    .length;
  const rustPins = exactPins(workflows, /^\s*toolchain:\s*['"]?([^\s'"#]+)['"]?\s*(?:#.*)?$/gm);
  if (
    !normalizedMsrv ||
    rustActionCount === 0 ||
    rustPins.length !== rustActionCount ||
    rustPins.some((pin) => pin !== normalizedMsrv)
  ) {
    throw new Error(
      `Rust requirement ${normalizedMsrv || '(missing)'} disagrees with repository pins: ${rustPins.join(', ')}`,
    );
  }

  return { node, npm: null, rustc: normalizedMsrv, cargo: normalizedMsrv };
}

function stringsIn(source) {
  return [...source.matchAll(/"([a-z][a-z0-9_-]+)"/g)].map((match) => match[1]);
}

function sameSet(left, right) {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function collectCommandCount(repositoryRoot) {
  const buildSource = read(repositoryRoot, 'src-tauri/build.rs');
  const appCommandsBlock = /const APP_COMMANDS:[\s\S]*?=\s*&\[([\s\S]*?)\];/.exec(buildSource)?.[1];
  const appCommands = appCommandsBlock ? stringsIn(appCommandsBlock) : [];

  const registrationSource = read(repositoryRoot, 'src-tauri/src/lib.rs');
  const handlerBlock = /\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/.exec(
    registrationSource,
  )?.[1];
  const registered = handlerBlock
    ? [...handlerBlock.matchAll(/(?:^|\s)(?:[a-z_]+::)*commands::([a-z][a-z0-9_]*)\s*,/g)].map(
        (match) => match[1],
      )
    : [];

  const inventory = [
    ...read(repositoryRoot, 'docs/migration/command-inventory.md').matchAll(
      /^\|\s*\d+\s*\|\s*`([a-z][a-z0-9_]*)`\s*\|/gm,
    ),
  ].map((match) => match[1]);

  if (
    appCommands.length === 0 ||
    registered.length === 0 ||
    inventory.length === 0 ||
    !sameSet(appCommands, registered) ||
    !sameSet(appCommands, inventory)
  ) {
    throw new Error(
      `command contract mismatch: APP_COMMANDS=${appCommands.length}, generate_handler=${registered.length}, command inventory=${inventory.length}`,
    );
  }
  return appCommands.length;
}

function collectRuntimeAndPaths(repositoryRoot) {
  const tauri = JSON.parse(read(repositoryRoot, 'src-tauri/tauri.conf.json'));
  const identifier = tauri.identifier;
  const main = tauri.app?.windows?.find((window) => window.label === 'main');
  if (
    typeof identifier !== 'string' ||
    !main ||
    ![main.width, main.height, main.minWidth, main.minHeight].every(
      (dimension) => Number.isFinite(dimension) && dimension > 0,
    )
  ) {
    throw new Error('Tauri identifier and main window dimensions must be defined');
  }
  const lib = read(repositoryRoot, 'src-tauri/src/lib.rs');
  for (const marker of [
    '.app_log_dir()',
    '.app_data_dir()',
    '.app_cache_dir()',
    '.app_config_dir()?.join("local-api.json")',
  ]) {
    if (!lib.includes(marker)) throw new Error(`Tauri path resolver contract is missing ${marker}`);
  }

  return {
    identifier,
    runtimeFacts: {
      registeredTauriCommands: collectCommandCount(repositoryRoot),
      mainWindow: `${main.width}×${main.height} (minimum ${main.minWidth}×${main.minHeight})`,
    },
    dataPaths: [
      {
        id: 'windows-app-data',
        platform: 'Windows',
        purpose: 'App data',
        path: `%APPDATA%\\${identifier}`,
        state: 'source-verified',
      },
      {
        id: 'windows-cache',
        platform: 'Windows',
        purpose: 'Cache',
        path: `%LOCALAPPDATA%\\${identifier}`,
        state: 'source-verified',
      },
      {
        id: 'windows-logs',
        platform: 'Windows',
        purpose: 'Logs',
        path: `%LOCALAPPDATA%\\${identifier}\\logs`,
        state: 'source-verified',
      },
      {
        id: 'windows-local-api-config',
        platform: 'Windows',
        purpose: 'Local API config',
        path: `%APPDATA%\\${identifier}\\local-api.json`,
        state: 'source-verified',
      },
      {
        id: 'linux-app-data',
        platform: 'Linux',
        purpose: 'App data',
        path: `$XDG_DATA_HOME/${identifier} (fallback ~/.local/share/${identifier})`,
        state: 'source-verified',
      },
      {
        id: 'linux-cache',
        platform: 'Linux',
        purpose: 'Cache',
        path: `$XDG_CACHE_HOME/${identifier} (fallback ~/.cache/${identifier})`,
        state: 'source-verified',
      },
      {
        id: 'linux-logs',
        platform: 'Linux',
        purpose: 'Logs',
        path: `$XDG_DATA_HOME/${identifier}/logs (fallback ~/.local/share/${identifier}/logs)`,
        state: 'source-verified',
      },
      {
        id: 'linux-local-api-config',
        platform: 'Linux',
        purpose: 'Local API config',
        path: `$XDG_CONFIG_HOME/${identifier}/local-api.json (fallback ~/.config/${identifier}/local-api.json)`,
        state: 'source-verified',
      },
    ],
  };
}

function constant(source, name) {
  const value = new RegExp(`(?:pub(?:\\([^)]*\\))?\\s+)?const\\s+${name}[^=]*=\\s*"([^"]+)"`).exec(
    source,
  )?.[1];
  if (!value) throw new Error(`repository constant ${name} is missing`);
  return value;
}

function collectPersistence(repositoryRoot) {
  const storage = read(repositoryRoot, 'crates/yaqmc-core/src/storage.rs');
  if (
    !storage.includes('data_root.join("library.sqlite3")') ||
    !/pragma_update\([^\n]*"journal_mode",\s*"WAL"\)/.test(storage)
  ) {
    throw new Error('SQLite library.sqlite3 WAL contract is missing');
  }
  for (const queueMarker of [
    'CREATE TABLE IF NOT EXISTS queue_state',
    'singleton INTEGER PRIMARY KEY CHECK(singleton = 1)',
    'value_json TEXT NOT NULL',
    'updated_at_ms INTEGER NOT NULL',
  ]) {
    if (!storage.includes(queueMarker))
      throw new Error(`queue_state contract is missing ${queueMarker}`);
  }

  const commands = read(repositoryRoot, 'src-tauri/src/commands.rs');
  const audioOutput = constant(commands, 'AUDIO_OUTPUT_SETTING');
  const loggingLevel = constant(
    read(repositoryRoot, 'crates/yaqmc-core/src/logging.rs'),
    'LOG_LEVEL_SETTING_KEY',
  );
  const qqmusic = read(repositoryRoot, 'src-tauri/src/qqmusic.rs');
  const qualityKeys = [...qqmusic.matchAll(/\.(?:get|set)_setting\(\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (qualityKeys.length === 0 || qualityKeys.some((key) => key !== 'preferred-quality')) {
    throw new Error(`preferred quality setting contract is invalid: ${qualityKeys.join(', ')}`);
  }
  const preferences = constant(
    read(repositoryRoot, 'crates/yaqmc-core/src/app_preferences.rs'),
    'PREFERENCES_KEY',
  );
  if (!storage.includes("VALUES ('preferences-schema-version', '2'")) {
    throw new Error('preferences-schema-version current migration value is missing');
  }
  const surface = read(repositoryRoot, 'src-tauri/src/lyrics_surface/mod.rs');
  const geometryPrefix = constant(surface, 'GEOMETRY_PREFIX');
  const surfaceValues = [...surface.matchAll(/Self::(?:Desktop|Island)\s*=>\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (!surfaceValues.includes('desktop') || !surfaceValues.includes('island')) {
    throw new Error('lyrics surface geometry setting contract is incomplete');
  }

  return [
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
      key: audioOutput,
      target: 'Keep exact key',
    },
    { id: 'logging-level', store: 'app_settings', key: loggingLevel, target: 'Keep exact key' },
    {
      id: 'preferred-quality',
      store: 'app_settings',
      key: qualityKeys[0],
      target: 'Keep exact key',
    },
    {
      id: 'preferences-schema-version',
      store: 'app_settings',
      key: 'preferences-schema-version',
      target: 'Keep exact key',
    },
    { id: 'ui-preferences', store: 'app_settings', key: preferences, target: 'Keep exact key' },
    {
      id: 'lyrics-geometry-desktop',
      store: 'app_settings',
      key: `${geometryPrefix}desktop`,
      target: 'Keep exact key',
    },
    {
      id: 'lyrics-geometry-island',
      store: 'app_settings',
      key: `${geometryPrefix}island`,
      target: 'Keep exact key',
    },
  ];
}

function collectKeyring(repositoryRoot) {
  const credentials = read(repositoryRoot, 'crates/yaqmc-core/src/credentials.rs');
  const auth = read(repositoryRoot, 'src-tauri/src/qqmusic/auth.rs');
  const localApi = read(repositoryRoot, 'crates/yaqmc-core/src/local_api.rs');
  return {
    service: constant(credentials, 'SERVICE_NAME'),
    legacyService: constant(credentials, 'LEGACY_SERVICE_NAME'),
    entries: [
      constant(auth, 'ACTIVE_SESSION'),
      constant(auth, 'STAGING_SESSION'),
      constant(localApi, 'LOCAL_API_TOKEN_ACCOUNT'),
    ],
  };
}

export function collectRepositoryFacts(repositoryRoot) {
  const { runtimeFacts, dataPaths } = collectRuntimeAndPaths(repositoryRoot);
  return {
    toolchains: collectToolchains(repositoryRoot),
    runtimeFacts,
    dataPaths,
    persistenceEntries: collectPersistence(repositoryRoot),
    keyring: collectKeyring(repositoryRoot),
  };
}
