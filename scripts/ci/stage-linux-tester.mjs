import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './repo.mjs';
import { sha256File } from './write-build-info.mjs';

const immutableRevision = /^[0-9a-f]{40}$/u;
const decimal = /^\d+$/u;

export const LINUX_TESTER_STATIC_FILES = Object.freeze([
  'ACCEPTANCE.md',
  'BUILD-IDENTITY.json',
  'SHA256SUMS',
  'TESTING.md',
  'collect-linux-diagnostics.sh',
  'verify-lyrics-acceptance.mjs',
]);

export function parseLinuxTesterArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }
    options[arg.slice(2)] = value;
    index += 1;
  }
  return options;
}

function defaultRunGit(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function requireMatch(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

function onlyAppImage(packageDir) {
  const candidates = readdirSync(packageDir, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.AppImage'),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Linux tester source must contain exactly one AppImage, found ${candidates.length}`,
    );
  }
  return candidates[0].name;
}

function requireEmptyDestination(destination) {
  if (existsSync(destination) && readdirSync(destination).length > 0) {
    throw new Error(`refusing to overwrite non-empty Linux tester directory ${destination}`);
  }
}

export function stageLinuxTesterBundle(options = {}) {
  const root = path.resolve(options.repositoryRoot ?? repositoryRoot);
  const packageDir = path.resolve(options.packageDir);
  const destination = path.resolve(options.destination);
  if (!existsSync(packageDir) || !statSync(packageDir).isDirectory()) {
    throw new Error(`Linux package directory is missing: ${packageDir}`);
  }
  requireEmptyDestination(destination);

  const runGit = options.runGit ?? defaultRunGit;
  const actualCommit = requireMatch(
    runGit(root, ['rev-parse', 'HEAD']),
    immutableRevision,
    'Git commit',
  );
  const requestedCommit = requireMatch(
    options.gitCommit ?? process.env.GITHUB_SHA ?? actualCommit,
    immutableRevision,
    'requested Git commit',
  );
  if (requestedCommit !== actualCommit) {
    throw new Error(
      `Linux tester commit ${requestedCommit} does not match checkout ${actualCommit}`,
    );
  }
  const gitTree = requireMatch(
    runGit(root, ['rev-parse', 'HEAD^{tree}']),
    immutableRevision,
    'Git tree',
  );
  const workflowRunId = requireMatch(
    options.workflowRunId ?? process.env.GITHUB_RUN_ID,
    decimal,
    'workflow run ID',
  );
  const workflowRunAttempt = requireMatch(
    options.workflowRunAttempt ?? process.env.GITHUB_RUN_ATTEMPT,
    decimal,
    'workflow run attempt',
  );
  const desktopPackage = JSON.parse(
    readFileSync(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
  );
  const appVersion = requireMatch(
    desktopPackage.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    'application version',
  );
  const appImageName = onlyAppImage(packageDir);
  const appImageSource = path.join(packageDir, appImageName);

  mkdirSync(destination, { recursive: true });
  const copies = [
    [appImageSource, appImageName],
    [path.join(root, 'scripts', 'collect-linux-diagnostics.sh'), 'collect-linux-diagnostics.sh'],
    [path.join(root, 'scripts', 'verify-lyrics-acceptance.mjs'), 'verify-lyrics-acceptance.mjs'],
    [path.join(root, 'docs', 'linux.md'), 'TESTING.md'],
    [path.join(root, 'docs', 'linux-acceptance.md'), 'ACCEPTANCE.md'],
  ];
  for (const [source, name] of copies) {
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new Error(`Linux tester input is missing: ${source}`);
    }
    copyFileSync(source, path.join(destination, name));
  }
  chmodSync(path.join(destination, appImageName), 0o755);
  chmodSync(path.join(destination, 'collect-linux-diagnostics.sh'), 0o755);

  const identity = {
    schemaVersion: 1,
    gitCommit: actualCommit,
    gitTree,
    workflowRunId,
    workflowRunAttempt,
    appVersion,
    appImage: {
      fileName: appImageName,
      sha256: sha256File(path.join(destination, appImageName)),
    },
  };
  writeFileSync(
    path.join(destination, 'BUILD-IDENTITY.json'),
    `${JSON.stringify(identity, null, 2)}\n`,
  );

  const checksumNames = readdirSync(destination).sort();
  const checksums = checksumNames
    .map((name) => `${sha256File(path.join(destination, name))}  ${name}`)
    .join('\n');
  writeFileSync(path.join(destination, 'SHA256SUMS'), `${checksums}\n`);

  const finalFiles = readdirSync(destination).sort();
  const expectedFiles = [...LINUX_TESTER_STATIC_FILES, appImageName].sort();
  if (JSON.stringify(finalFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('Linux tester output does not match the flat bundle contract');
  }
  return { destination, identity, files: finalFiles };
}

function main() {
  const args = parseLinuxTesterArgs(process.argv.slice(2));
  if (!args['package-dir'] || !args.to) {
    throw new Error(
      'Usage: stage-linux-tester.mjs --package-dir <directory> --to <directory> [--git-commit <sha>] [--workflow-run-id <id>] [--workflow-run-attempt <n>]',
    );
  }
  const result = stageLinuxTesterBundle({
    packageDir: args['package-dir'],
    destination: args.to,
    gitCommit: args['git-commit'],
    workflowRunId: args['workflow-run-id'],
    workflowRunAttempt: args['workflow-run-attempt'],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
