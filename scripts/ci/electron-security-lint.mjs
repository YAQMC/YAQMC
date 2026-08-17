import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './repo.mjs';

const DISABLE_WEB_SECURITY = ['--', 'disable-web-security'].join('');
const NO_SANDBOX = ['--', 'no-sandbox'].join('');
const SWITCH_NEEDLES = [DISABLE_WEB_SECURITY, NO_SANDBOX];

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'target',
  'coverage',
  'output',
  'release',
  '.playwright-cli',
]);

const SWITCH_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.json',
  '.mjs',
  '.ps1',
  '.sh',
  '.ts',
  '.tsx',
  '.yml',
  '.yaml',
]);

const PRELOAD_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.ts']);

const ALLOWED_ELECTRON_IMPORTS = new Set(['contextBridge', 'ipcRenderer', 'IpcRendererEvent']);

export const ELECTRON_SECURITY_SKIP_RELATIVE = [
  'scripts/ci/electron-security-lint.mjs',
  'scripts/ci/electron-security-lint.test.mjs',
];

export function forbiddenChromiumSwitches() {
  return SWITCH_NEEDLES.slice();
}

export function lintSwitchText(source, filePath) {
  const findings = [];
  for (const needle of SWITCH_NEEDLES) {
    if (source.includes(needle)) {
      findings.push(`${filePath}: forbidden Chromium switch ${needle}`);
    }
  }
  return findings;
}

export function lintPreloadSource(source, filePath) {
  const findings = [];
  if (/\brequire\s*\(/u.test(source)) {
    findings.push(`${filePath}: preload must not call require(`);
  }
  if (/\bprocess\.env\b/u.test(source)) {
    findings.push(`${filePath}: preload must not read process.env`);
  }
  for (const names of electronImportNames(source)) {
    for (const name of names) {
      if (!ALLOWED_ELECTRON_IMPORTS.has(name)) {
        findings.push(`${filePath}: preload electron import '${name}' is not allowed`);
      }
    }
  }
  return findings;
}

export function scanElectronSecurity(root = repositoryRoot) {
  const findings = [];
  for (const relativePath of collectSourceFiles(root)) {
    if (ELECTRON_SECURITY_SKIP_RELATIVE.includes(relativePath.replaceAll('\\', '/'))) {
      continue;
    }
    const absolutePath = path.join(root, relativePath);
    const source = readFileSync(absolutePath, 'utf8');
    const ext = path.extname(relativePath);
    if (SWITCH_EXTENSIONS.has(ext)) {
      findings.push(...lintSwitchText(source, relativePath));
    }
    if (isPreloadPath(relativePath) && PRELOAD_EXTENSIONS.has(ext)) {
      findings.push(...lintPreloadSource(source, relativePath));
    }
  }
  return findings;
}

export function collectSourceFiles(root) {
  const files = [];
  walk(root, root, files);
  return files;
}

function isPreloadPath(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  return normalized.startsWith('apps/desktop/preload/') || normalized.includes('/preload/');
}

function electronImportNames(source) {
  const groups = [];
  const named =
    /import\s+(?:type\s+)?(?:\*\s+as\s+(\w+)|(\w+)\s*,\s*)?\{([^}]+)\}\s+from\s+['"]electron['"]/gu;
  for (const match of source.matchAll(named)) {
    const names = [];
    if (match[1]) {
      names.push(match[1]);
    }
    if (match[2]) {
      names.push(match[2]);
    }
    for (const part of match[3].split(',')) {
      const token = part
        .replace(/\btype\b/gu, '')
        .replace(/\bas\s+\w+/gu, '')
        .trim();
      if (token) {
        names.push(token);
      }
    }
    groups.push(names);
  }
  const namespace = /import\s+(?:type\s+)?(?:\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]electron['"]/gu;
  for (const match of source.matchAll(namespace)) {
    if (match[0].includes('{')) {
      continue;
    }
    groups.push([match[1] ?? match[2]]);
  }
  return groups;
}

function walk(root, current, files) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') {
      continue;
    }
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }
      walk(root, absolute, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relativePath = path.relative(root, absolute);
    const ext = path.extname(entry.name);
    if (
      SWITCH_EXTENSIONS.has(ext) ||
      (isPreloadPath(relativePath) && PRELOAD_EXTENSIONS.has(ext))
    ) {
      files.push(relativePath);
    }
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const findings = scanElectronSecurity();
  if (findings.length > 0) {
    process.stderr.write(`electron security lint failed (${findings.length}):\n`);
    for (const finding of findings) {
      process.stderr.write(`- ${finding}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write('electron security lint passed\n');
  }
}
