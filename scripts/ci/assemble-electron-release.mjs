import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './write-build-info.mjs';

export const ELECTRON_RELEASE_NOTES_NAME = 'RELEASE-NOTES-ELECTRON.md';
export const ELECTRON_COMBINED_CHECKSUMS_NAME = 'SHA256SUMS-electron.txt';

export const ELECTRON_RELEASE_NOTES = `# YAQMC Electron draft

This is an **unsigned** Electron host draft (**R-9**). It is not the Tauri GitHub
Release from \`build.yml\`.

- Windows i686 is not published.
- App and keyring data stay under \`org.yaqmc.desktop\`.
- WebKitGTK troubleshooting does not apply to this host.
- Updater metadata (\`latest.yml\`, \`latest-linux.yml\`) is the **x64** feed only.
  Arm64 installers may be attached; they are not in the updater channel yet.
- This draft is not an A→B upgrade rehearsal. Provenance remains **BLOCKED**.
`;

export function parseAssembleArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    options[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

export function electronDraftTag({ eventName, refName, runId }) {
  if (eventName === 'push' && typeof refName === 'string' && /^v\d/.test(refName)) {
    return `electron-${refName}`;
  }
  if (!runId) {
    throw new Error('electron draft tag requires GITHUB_RUN_ID when not a v* tag');
  }
  return `electron-draft-${runId}`;
}

function listFilesRecursive(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

export function assembleElectronRelease({ sourceDir, destDir }) {
  if (!existsSync(sourceDir)) {
    throw new Error(`electron release source is missing: ${sourceDir}`);
  }
  mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const file of listFilesRecursive(sourceDir)) {
    const name = path.basename(file);
    if (name === 'latest.yml' || name === 'latest-linux.yml') {
      continue;
    }
    const dest = path.join(destDir, name);
    if (existsSync(dest)) {
      throw new Error(`duplicate Electron release file ${name}`);
    }
    copyFileSync(file, dest);
    copied.push(name);
  }

  const windowsFeed = listFilesRecursive(sourceDir).find(
    (file) =>
      path.basename(file) === 'latest.yml' &&
      file.includes(`${path.sep}YAQMC-electron-windows-x64`),
  );
  const linuxFeed = listFilesRecursive(sourceDir).find(
    (file) =>
      path.basename(file) === 'latest-linux.yml' &&
      file.includes(`${path.sep}YAQMC-electron-linux-x64`),
  );
  if (windowsFeed) {
    copyFileSync(windowsFeed, path.join(destDir, 'latest.yml'));
    copied.push('latest.yml');
  }
  if (linuxFeed) {
    copyFileSync(linuxFeed, path.join(destDir, 'latest-linux.yml'));
    copied.push('latest-linux.yml');
  }

  const checksumTargets = copied.filter(
    (name) =>
      !name.startsWith('SHA256SUMS') &&
      name !== 'latest.yml' &&
      name !== 'latest-linux.yml' &&
      name !== ELECTRON_RELEASE_NOTES_NAME,
  );
  const sums = checksumTargets
    .sort()
    .map((name) => `${sha256File(path.join(destDir, name))}  ${name}`)
    .join('\n');
  writeFileSync(path.join(destDir, ELECTRON_COMBINED_CHECKSUMS_NAME), `${sums}\n`);
  writeFileSync(path.join(destDir, ELECTRON_RELEASE_NOTES_NAME), ELECTRON_RELEASE_NOTES);
  return {
    destDir,
    files: readdirSync(destDir).sort(),
    hasWindowsFeed: Boolean(windowsFeed),
    hasLinuxFeed: Boolean(linuxFeed),
  };
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const options = parseAssembleArgs(process.argv.slice(2));
  if (!options.from || !options.to) {
    throw new Error('assemble-electron-release requires --from and --to');
  }
  const result = assembleElectronRelease({ sourceDir: options.from, destDir: options.to });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
