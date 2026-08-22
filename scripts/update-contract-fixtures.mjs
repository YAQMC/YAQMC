import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_FILES = [
  'constants.json',
  'envelopes.json',
  'methods.json',
  'channels.json',
  'events.json',
  'requests.json',
  'responses.json',
];

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function committedFixturesDir(root = repositoryRoot) {
  return path.join(root, 'packages', 'yaqmc-client', 'fixtures');
}

export function emittedFixturesDir(root = repositoryRoot) {
  const target = process.env.CARGO_TARGET_DIR
    ? path.resolve(process.env.CARGO_TARGET_DIR)
    : path.join(root, 'target');
  return path.join(target, 'contract-fixtures');
}

export function readFixture(dir, name) {
  return JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
}

function emitFixtures(root) {
  execFileSync(
    'cargo',
    [
      'test',
      '-p',
      'yaqmc-protocol',
      '--features',
      'fixtures',
      '--test',
      'emit_fixtures',
      '--locked',
    ],
    { cwd: root, stdio: 'inherit' },
  );
}

function copyFixtures(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of FIXTURE_FILES) {
    const source = path.join(from, name);
    if (!existsSync(source)) {
      throw new Error(`missing emitted fixture: ${name}`);
    }
    copyFileSync(source, path.join(to, name));
  }
}

function fixtureNames(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/gu, '\n');
}

export function assertFixturesMatch(leftDir, rightDir) {
  const left = fixtureNames(leftDir);
  const right = fixtureNames(rightDir);
  if (JSON.stringify(left) !== JSON.stringify(FIXTURE_FILES.slice().sort())) {
    throw new Error(`committed fixture set drifted: ${JSON.stringify(left)}`);
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`emitted fixture set drifted: ${JSON.stringify(right)}`);
  }
  for (const name of FIXTURE_FILES) {
    const leftText = readFileSync(path.join(leftDir, name), 'utf8');
    const rightText = readFileSync(path.join(rightDir, name), 'utf8');
    if (normalizeLineEndings(leftText) !== normalizeLineEndings(rightText)) {
      throw new Error(`${name} drifted from cargo --features fixtures emit`);
    }
  }
}

function main() {
  const check = process.argv.includes('--check');
  emitFixtures(repositoryRoot);
  const emitted = emittedFixturesDir(repositoryRoot);
  const committed = committedFixturesDir(repositoryRoot);
  if (check) {
    assertFixturesMatch(committed, emitted);
    process.stdout.write('Contract fixtures match the protocol emitter.\n');
    return;
  }
  copyFixtures(emitted, committed);
  process.stdout.write(`Updated ${committed}\n`);
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
