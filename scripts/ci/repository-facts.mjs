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
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

function workflowText(repositoryRoot) {
  return walk(path.join(repositoryRoot, '.github'))
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

  const workspaceMsrv = workspacePackageValue(read(repositoryRoot, 'Cargo.toml'), 'rust-version');
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

function collectRuntimeAndPaths(repositoryRoot) {
  const builder = read(repositoryRoot, 'apps/desktop/electron-builder.yml');
  const identifier = /^appId:\s*([^\s#]+)\s*$/m.exec(builder)?.[1];
  const paths = read(repositoryRoot, 'apps/desktop/main/core/paths.ts');
  const pathIdentifier = /APP_IDENTIFIER\s*=\s*'([^']+)'/.exec(paths)?.[1];
  if (!identifier || identifier !== pathIdentifier) {
    throw new Error('Electron appId and Core path identifier must match');
  }

  const main = read(repositoryRoot, 'apps/desktop/main/index.ts');
  const dimension = (name) => Number(new RegExp(`\\b${name}:\\s*(\\d+)`).exec(main)?.[1]);
  const [width, height, minWidth, minHeight] = [
    dimension('width'),
    dimension('height'),
    dimension('minWidth'),
    dimension('minHeight'),
  ];
  if (![width, height, minWidth, minHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Electron main window dimensions must be defined');
  }

  const registeredProtocolMethods = JSON.parse(
    read(repositoryRoot, 'packages/yaqmc-client/fixtures/methods.json'),
  ).length;

  return {
    runtimeFacts: {
      registeredProtocolMethods,
      mainWindow: `${width}×${height} (minimum ${minWidth}×${minHeight})`,
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
  const match = new RegExp(
    `(?:export\\s+)?(?:pub(?:\\([^)]*\\))?\\s+)?const\\s+${name}[^=]*=\\s*(["'])([^"']+)\\1`,
  ).exec(source);
  const value = match?.[2];
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
  for (const marker of [
    'CREATE TABLE IF NOT EXISTS queue_state',
    'singleton INTEGER PRIMARY KEY CHECK(singleton = 1)',
    'value_json TEXT NOT NULL',
    'updated_at_ms INTEGER NOT NULL',
  ]) {
    if (!storage.includes(marker)) throw new Error(`queue_state contract is missing ${marker}`);
  }

  const audioOutput = constant(
    read(repositoryRoot, 'crates/yaqmc-core/src/audio.rs'),
    'AUDIO_OUTPUT_DEVICE_SETTING',
  );
  const loggingLevel = constant(
    read(repositoryRoot, 'crates/yaqmc-core/src/logging.rs'),
    'LOG_LEVEL_SETTING_KEY',
  );
  const qqmusic = read(repositoryRoot, 'crates/yaqmc-core/src/qqmusic.rs');
  if (!qqmusic.includes('"preferred-quality"')) {
    throw new Error('preferred quality setting contract is missing');
  }
  const preferences = constant(
    read(repositoryRoot, 'crates/yaqmc-core/src/app_preferences.rs'),
    'PREFERENCES_KEY',
  );
  if (!storage.includes("VALUES ('preferences-schema-version', '2'")) {
    throw new Error('preferences-schema-version current migration value is missing');
  }
  const geometryPrefix = constant(
    read(repositoryRoot, 'apps/desktop/main/windows/lyrics-surfaces.ts'),
    'LYRICS_SURFACE_GEOMETRY_PREFIX',
  );

  return [
    { id: 'sqlite-library', store: 'SQLite', key: 'library.sqlite3 (WAL)', target: 'Keep in place' },
    {
      id: 'queue-state',
      store: 'SQLite table',
      key: 'queue_state singleton row (value_json)',
      target: 'Keep in place',
    },
    { id: 'audio-output-device', store: 'app_settings', key: audioOutput, target: 'Keep exact key' },
    { id: 'logging-level', store: 'app_settings', key: loggingLevel, target: 'Keep exact key' },
    { id: 'preferred-quality', store: 'app_settings', key: 'preferred-quality', target: 'Keep exact key' },
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
  const auth = read(repositoryRoot, 'crates/yaqmc-core/src/qqmusic/auth.rs');
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

function assertSystemMediaCoreOwnership(repositoryRoot) {
  const core = read(repositoryRoot, 'crates/yaqmc-core/src/system_media.rs');
  const coreBootstrap = read(repositoryRoot, 'crates/yaqmc-core/src/bootstrap.rs');
  const electronMain = read(repositoryRoot, 'apps/desktop/main/index.ts');
  for (const marker of [
    'pub struct SystemMediaStartConfig',
    'pub windows_hwnd: Option<isize>',
    'pub windows_start_error: Option<String>',
    'pub runtime: tokio::runtime::Handle',
    'pub host_commands: HostCommandPublisher',
    'HostCommand::RaiseMainWindow',
    'HostCommand::Quit',
  ]) {
    if (!core.includes(marker)) {
      throw new Error(`Core system-media ownership contract is missing ${marker}`);
    }
  }
  if (/\bAppHandle\b|\bWebviewWindow\b|\braw_window_handle\b/.test(core)) {
    throw new Error('Core system-media source must not depend on a renderer host type');
  }
  if (!coreBootstrap.includes('SystemMediaIntegration::start(')) {
    throw new Error('Core bootstrap must start native system media');
  }
  if (!electronMain.includes('subscribeHostCommands(instance.client')) {
    throw new Error('Electron Main must subscribe to Core host commands');
  }
}

export function collectRepositoryFacts(repositoryRoot) {
  const { runtimeFacts, dataPaths } = collectRuntimeAndPaths(repositoryRoot);
  assertSystemMediaCoreOwnership(repositoryRoot);
  return {
    toolchains: collectToolchains(repositoryRoot),
    runtimeFacts,
    dataPaths,
    persistenceEntries: collectPersistence(repositoryRoot),
    keyring: collectKeyring(repositoryRoot),
  };
}
