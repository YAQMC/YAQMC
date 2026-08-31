import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './repo.mjs';

const forbiddenMarkers = [
  'Offline fixtures',
  'artist-mira-vale',
  'Quiet Light',
  '?provider=fake',
  '__YAQMC_E2E__',
  'uiDiagnostics=1',
  'YAQMC_DESKTOP_SMOKE',
  'YAQMC_ELECTRON_E2E',
  'YAQMC_UI_PERF_DIAG',
  'yaqmc-smoke-ok',
  'harness failed to load',
];

const scannedExtensions = new Set(['.cjs', '.css', '.html', '.js', '.json', '.mjs']);

function filesBelow(root) {
  if (!existsSync(root)) {
    throw new Error(`release bundle directory is missing: ${root}`);
  }
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function unsafePath(relative) {
  const parts = relative.toLowerCase().split('/');
  return parts.some(
    (part) =>
      part === 'harness' ||
      part === 'fixtures' ||
      part.includes('playwright') ||
      part.includes('.test.') ||
      part.includes('.spec.'),
  );
}

export function verifyReleaseBundle({ rendererDir, desktopDir } = {}) {
  const roots = [
    rendererDir ? { kind: 'renderer', root: path.resolve(rendererDir) } : null,
    desktopDir ? { kind: 'desktop', root: path.resolve(desktopDir) } : null,
  ].filter(Boolean);
  if (roots.length === 0) {
    throw new Error('verify-release-bundle requires --renderer and/or --desktop');
  }

  const violations = [];
  for (const { kind, root } of roots) {
    for (const file of filesBelow(root)) {
      const relative = path.relative(root, file).replaceAll('\\', '/');
      if (relative.endsWith('.map')) continue;
      if (unsafePath(relative)) {
        violations.push(`${kind}:${relative}: test-only path`);
      }
      if (
        kind === 'renderer' &&
        relative.startsWith('artwork/') &&
        relative !== 'artwork/preset-preview.svg'
      ) {
        violations.push(`${kind}:${relative}: non-product artwork`);
      }
      if (!scannedExtensions.has(path.extname(relative).toLowerCase())) continue;
      const contents = readFileSync(file, 'utf8');
      for (const marker of forbiddenMarkers) {
        if (contents.includes(marker)) {
          violations.push(`${kind}:${relative}: forbidden marker ${JSON.stringify(marker)}`);
        }
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`release bundle contains QA/test content:\n${violations.join('\n')}`);
  }
  return roots.map(({ kind, root }) => ({ kind, root, files: filesBelow(root).length }));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name !== '--renderer' && name !== '--desktop') continue;
    const value = argv[index + 1];
    if (!value) throw new Error(`${name} requires a directory`);
    options[name.slice(2) + 'Dir'] = path.resolve(repositoryRoot, value);
    index += 1;
  }
  return options;
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const verified = verifyReleaseBundle(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    `${verified.map(({ kind, files }) => `${kind}=${String(files)} files`).join(', ')}: release bundle clean\n`,
  );
}
