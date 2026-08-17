import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function coreBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'yaqmc-core.exe' : 'yaqmc-core';
}

export function cargoTargetDir(env = process.env, repoRoot) {
  return env.CARGO_TARGET_DIR || path.join(repoRoot, 'target');
}

export function findCoreBinary(options) {
  const { repoRoot, env = process.env, profile } = options;
  const name = coreBinaryName();
  const target = cargoTargetDir(env, repoRoot);
  const profiles = profile ? [profile] : ['release', 'debug'];
  const candidates = profiles.map((entry) => path.join(target, entry, name));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`yaqmc-core binary was not found under ${target}`);
  }
  return found;
}

export function stageCore(options) {
  const { repoRoot, env = process.env, destinationDir, profile } = options;
  const source = findCoreBinary({ repoRoot, env, profile });
  const destDir = destinationDir ?? path.join(repoRoot, 'apps', 'desktop', 'resources', 'core');
  mkdirSync(destDir, { recursive: true });
  const name = path.basename(source);
  const destination = path.join(destDir, name);
  copyFileSync(source, destination);
  const bytes = statSync(destination).size;
  const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');
  // Spawn-time verify (SUP-03) reads manifest.json next to the staged binary.
  writeFileSync(path.join(destDir, 'core.sha256'), `${sha256}  ${name}\n`);
  writeFileSync(
    path.join(destDir, 'manifest.json'),
    `${JSON.stringify({ name, sha256, bytes }, null, 2)}\n`,
  );
  return { source, destination, sha256, bytes };
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const profileFlag = process.argv.indexOf('--profile');
  const profile = profileFlag >= 0 ? process.argv[profileFlag + 1] : undefined;
  const staged = stageCore({ repoRoot, profile });
  process.stdout.write(`staged ${staged.destination} sha256=${staged.sha256}\n`);
}
