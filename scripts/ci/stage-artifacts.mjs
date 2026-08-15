import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './repo.mjs';
import { currentGitSha } from './write-frontend-build-info.mjs';
import { writeBuildInfo, writeSha256Sums } from './write-build-info.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    options[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function walkFiles(directory) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(full));
    else found.push(full);
  }
  return found;
}

export function findReleaseBinary(os, targetRoot, hostRelease) {
  const binaryName = os === 'windows' ? 'yaqmc.exe' : 'yaqmc';
  const candidates = [path.join(targetRoot, binaryName), path.join(hostRelease, binaryName)];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`native binary ${binaryName} was not found under ${targetRoot}`);
  }
  return found;
}

function requireStaged(label, staged, test, bundleRoot) {
  if (staged.some(test)) return;
  const found = walkFiles(bundleRoot)
    .map((file) => path.relative(bundleRoot, file))
    .join(', ');
  throw new Error(
    `${label} was not staged from ${bundleRoot}; found: ${found || '(empty bundle directory)'}`,
  );
}

function shortSha() {
  return currentGitSha().slice(0, 7);
}

function appVersion() {
  const tauriConf = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
  );
  return tauriConf.version;
}

function copyMatching(sourceDir, destDir, test, rename) {
  const copied = [];
  for (const file of walkFiles(sourceDir)) {
    const base = path.basename(file);
    if (!test(base)) continue;
    const destination = path.join(destDir, rename(base));
    copyFileSync(file, destination);
    copied.push(path.basename(destination));
  }
  return copied;
}

function writePortableZip(binaryPath, zipPath) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -LiteralPath '${binaryPath.replaceAll("'", "''")}' -DestinationPath '${zipPath.replaceAll("'", "''")}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    return;
  }
  const directory = path.dirname(zipPath);
  const binaryName = path.basename(binaryPath);
  execFileSync('tar', ['-C', path.dirname(binaryPath), '-czf', zipPath, binaryName], {
    stdio: 'inherit',
  });
  void directory;
}

function writeLinuxReadme(destDir) {
  writeFileSync(
    path.join(destDir, 'README-binary.txt'),
    [
      'YAQMC Linux binary archive',
      '',
      'This archive contains a dynamically linked executable. It is not a static',
      'or fully self-contained portable build. Runtime libraries such as WebKitGTK',
      '4.1 and ALSA must be present on the host. Prefer the AppImage, .deb, or .rpm',
      'when those formats are available.',
      '',
    ].join('\n'),
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = options.target;
  const os = options.os;
  const arch = options.arch;
  const profile = options.profile || 'ci-release';
  const bundles = (options.bundles || '').split(',').filter(Boolean);
  if (!target || !os || !arch) {
    throw new Error('stage-artifacts requires --target --os --arch');
  }

  const version = appVersion();
  const sha = shortSha();
  const releaseDir = path.join(repositoryRoot, 'release', `YAQMC-${os}-${arch}`);
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });

  const targetRoot = path.join(repositoryRoot, 'src-tauri', 'target', target, 'release');
  const hostRelease = path.join(repositoryRoot, 'src-tauri', 'target', 'release');
  const binaryPath = findReleaseBinary(os, targetRoot, hostRelease);

  const prefix = `YAQMC-${version}-${os}-${arch}-${sha}`;
  const staged = [];
  const bundleRoot = path.join(path.dirname(binaryPath), 'bundle');

  if (os === 'windows') {
    staged.push(
      ...copyMatching(
        bundleRoot,
        releaseDir,
        (name) => name.endsWith('.exe') && /setup/i.test(name),
        () => `${prefix}-nsis-setup.exe`,
      ),
      ...copyMatching(
        bundleRoot,
        releaseDir,
        (name) => name.endsWith('.msi'),
        () => `${prefix}-msi.msi`,
      ),
    );
    const zipName = `${prefix}-portable.zip`;
    writePortableZip(binaryPath, path.join(releaseDir, zipName));
    staged.push(zipName);
    if (bundles.includes('nsis')) {
      requireStaged('NSIS installer', staged, (name) => name.includes('-nsis-'), bundleRoot);
    }
    if (bundles.includes('msi')) {
      requireStaged('MSI installer', staged, (name) => name.endsWith('-msi.msi'), bundleRoot);
    }
  } else {
    staged.push(
      ...copyMatching(
        bundleRoot,
        releaseDir,
        (name) => name.endsWith('.AppImage'),
        () => `${prefix}.AppImage`,
      ),
      ...copyMatching(
        bundleRoot,
        releaseDir,
        (name) => name.endsWith('.deb'),
        () => `${prefix}.deb`,
      ),
      ...copyMatching(
        bundleRoot,
        releaseDir,
        (name) => name.endsWith('.rpm'),
        () => `${prefix}.rpm`,
      ),
    );
    writeLinuxReadme(releaseDir);
    const archiveName = `${prefix}-binary.tar.gz`;
    const stagingBinary = path.join(releaseDir, 'yaqmc');
    copyFileSync(binaryPath, stagingBinary);
    execFileSync(
      'tar',
      ['-C', releaseDir, '-czf', path.join(releaseDir, archiveName), 'yaqmc', 'README-binary.txt'],
      {
        stdio: 'inherit',
      },
    );
    rmSync(stagingBinary);
    staged.push('README-binary.txt', archiveName);
    if (bundles.includes('appimage')) {
      requireStaged('AppImage', staged, (name) => name.endsWith('.AppImage'), bundleRoot);
    }
    if (bundles.includes('deb')) {
      requireStaged('deb package', staged, (name) => name.endsWith('.deb'), bundleRoot);
    }
    if (bundles.includes('rpm')) {
      requireStaged('rpm package', staged, (name) => name.endsWith('.rpm'), bundleRoot);
    }
  }

  const unique = [...new Set(staged)];
  if (unique.length === 0) {
    throw new Error('no downloadable artifacts were staged');
  }

  writeBuildInfo({
    outputPath: path.join(releaseDir, 'build-info.json'),
    target,
    arch,
    os,
    profile,
    lto: process.env.CARGO_PROFILE_RELEASE_LTO || (profile === 'production' ? 'true' : 'thin'),
    codegenUnits: Number(
      process.env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS || (profile === 'production' ? 1 : 8),
    ),
    bundles,
    files: unique,
  });
  unique.push('build-info.json');
  writeSha256Sums(releaseDir, unique.sort(), `SHA256SUMS-${os}-${arch}.txt`);
  process.stdout.write(`Staged ${unique.length} files in ${releaseDir}\n`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
