import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function readRootVersion(repoRoot) {
  const version = readJson(path.join(repoRoot, 'package.json')).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('root package.json is missing a version');
  }
  return version;
}

export function workspaceCrateManifests(repoRoot) {
  const cargo = readFileSync(path.join(repoRoot, 'Cargo.toml'), 'utf8');
  const block = cargo.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!block) {
    throw new Error('Cargo.toml workspace members not found');
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) =>
    path.join(repoRoot, match[1], 'Cargo.toml'),
  );
}

export function readCargoPackageVersion(text) {
  const start = text.search(/^\[package\]/m);
  if (start < 0) {
    throw new Error('Cargo.toml is missing [package]');
  }
  const fromPackage = text.slice(start);
  const nextSection = fromPackage.search(/\n\[/);
  const section = nextSection >= 0 ? fromPackage.slice(0, nextSection) : fromPackage;
  const match = section.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error('Cargo.toml [package] is missing version');
  }
  return match[1];
}

export function setCargoPackageVersion(text, version) {
  const current = readCargoPackageVersion(text);
  if (current === version) {
    return { text, changed: false };
  }
  const next = text.replace(/^(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m, `$1${version}$3`);
  if (next === text) {
    throw new Error('failed to replace Cargo.toml package version');
  }
  return { text: next, changed: true };
}

export function setJsonPackageVersion(text, version) {
  const current = JSON.parse(text).version;
  if (current === version) {
    return { text, changed: false };
  }
  if (typeof current !== 'string') {
    throw new Error('package.json is missing a version');
  }
  const next = text.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${version}$3`);
  if (next === text) {
    throw new Error('package.json version field was not found');
  }
  return { text: next, changed: true };
}

function desktopPackagePath(repoRoot) {
  return path.join(repoRoot, 'apps', 'desktop', 'package.json');
}

export function collectVersionTargets(repoRoot) {
  return [desktopPackagePath(repoRoot), ...workspaceCrateManifests(repoRoot)];
}

function relativeToRoot(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

export function syncVersions(options) {
  const repoRoot = options.repoRoot;
  const check = options.check === true;
  const expected = readRootVersion(repoRoot);
  const updates = [];

  const desktopPath = desktopPackagePath(repoRoot);
  const desktopText = readFileSync(desktopPath, 'utf8');
  const desktop = setJsonPackageVersion(desktopText, expected);
  if (desktop.changed) {
    updates.push({
      path: desktopPath,
      from: JSON.parse(desktopText).version,
      to: expected,
    });
    if (!check) {
      writeFileSync(desktopPath, desktop.text);
    }
  }

  for (const manifest of workspaceCrateManifests(repoRoot)) {
    const text = readFileSync(manifest, 'utf8');
    const found = readCargoPackageVersion(text);
    if (found === expected) {
      continue;
    }
    updates.push({ path: manifest, from: found, to: expected });
    if (!check) {
      const next = setCargoPackageVersion(text, expected);
      writeFileSync(manifest, next.text);
    }
  }

  if (check && updates.length > 0) {
    const lines = updates.map(
      (update) => `${relativeToRoot(repoRoot, update.path)}: ${update.from} != ${update.to}`,
    );
    throw new Error(`version mismatch (root ${expected}):\n${lines.join('\n')}`);
  }

  return { version: expected, updates };
}

function main() {
  const check = process.argv.includes('--check') || process.argv.includes('--dry-run');
  const result = syncVersions({ repoRoot: defaultRepoRoot, check });
  if (result.updates.length === 0) {
    process.stdout.write(`versions already match ${result.version}\n`);
    return;
  }
  process.stdout.write(`synced ${result.updates.length} file(s) to ${result.version}\n`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
