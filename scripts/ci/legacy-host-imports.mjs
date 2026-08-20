import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './repo.mjs';

const LEGACY_HOST_PACKAGE = ['@', 'tau', 'ri-apps'].join('');

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'target',
  'coverage',
  'output',
  'release',
]);

const SOURCE_EXTENSIONS = new Set(['.cjs', '.css', '.js', '.json', '.mjs', '.ts', '.tsx']);

export function forbiddenLegacyHostImportNeedle() {
  return LEGACY_HOST_PACKAGE;
}

export function lintLegacyHostImportText(source, filePath) {
  if (source.includes(LEGACY_HOST_PACKAGE)) {
    return [`${filePath}: forbidden legacy host package reference`];
  }
  return [];
}

export function scanLegacyHostImports(root = repositoryRoot) {
  const findings = [];
  const srcRoot = path.join(root, 'src');
  for (const relativePath of collectSrcFiles(srcRoot, root)) {
    const normalized = relativePath.replaceAll('\\', '/');
    const source = readFileSync(path.join(root, relativePath), 'utf8');
    findings.push(...lintLegacyHostImportText(source, normalized));
  }
  return findings;
}

export function collectSrcFiles(srcRoot, root) {
  const files = [];
  walk(srcRoot, root, files);
  return files;
}

function walk(current, root, files) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR_NAMES.has(entry.name)) {
        walk(absolute, root, files);
      }
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.relative(root, absolute));
    }
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const findings = scanLegacyHostImports();
  if (findings.length > 0) {
    process.stderr.write(`legacy host import lint failed (${findings.length}):\n`);
    for (const finding of findings) {
      process.stderr.write(`- ${finding}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write('legacy host import lint passed\n');
  }
}
