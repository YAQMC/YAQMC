import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { CORRESPONDING_SOURCE_MANIFEST, YAQMC_ORIGIN } from './corresponding-source.mjs';
import { QM_API_RS_ORIGIN, QM_API_RS_REV } from './qm-api-rs-access.mjs';
import { sha256File } from './write-build-info.mjs';

export const ELECTRON_RELEASE_NOTES_NAME = 'RELEASE-NOTES-ELECTRON.md';
export const ELECTRON_COMBINED_CHECKSUMS_NAME = 'SHA256SUMS-electron.txt';

export const ELECTRON_RELEASE_NOTES = `# YAQMC desktop release draft

Windows installers and portable executables in this draft are Authenticode-signed.
The release workflow validates both signature status and the expected publisher
identity before artifacts can be uploaded. Linux artifacts are not code-signed;
use the published SHA-256 checksums for transport verification.

- Windows i686 is not published.
- App and keyring data stay under \`org.yaqmc.desktop\`.
- Linux graphics diagnostics use Chromium/Ozone modes; retired-host renderer overrides do not apply.
- Updater metadata (\`latest.yml\`, \`latest-linux.yml\`) is the **x64** feed only.
  Arm64 installers may be attached; they are not in the updater channel yet.
- Provider readiness and provenance are enforced before packaging. The exact YAQMC and
  \`qm-api-rs\` corresponding-source archives are identified by
  \`CORRESPONDING-SOURCE-MANIFEST.json\`.
- This draft is not an A→B upgrade rehearsal.
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
    return refName;
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

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const normalized = value.replaceAll('\\', '/');
  return (
    !path.posix.isAbsolute(normalized) &&
    path.posix.normalize(normalized) === normalized &&
    normalized !== '..' &&
    !normalized.startsWith('../')
  );
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function indexZipArchive(archivePath) {
  const source = readFileSync(archivePath);
  const minimumOffset = Math.max(0, source.length - 65_557);
  let endOffset = -1;
  for (let offset = source.length - 22; offset >= minimumOffset; offset -= 1) {
    if (source.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0 || endOffset + 22 > source.length) {
    throw new Error(`corresponding-source archive is not a supported ZIP: ${archivePath}`);
  }
  const disk = source.readUInt16LE(endOffset + 4);
  const centralDisk = source.readUInt16LE(endOffset + 6);
  const entriesOnDisk = source.readUInt16LE(endOffset + 8);
  const entryCount = source.readUInt16LE(endOffset + 10);
  const centralSize = source.readUInt32LE(endOffset + 12);
  const centralOffset = source.readUInt32LE(endOffset + 16);
  const commentLength = source.readUInt16LE(endOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize > endOffset ||
    endOffset + 22 + commentLength !== source.length
  ) {
    throw new Error(`corresponding-source ZIP layout is unsupported: ${archivePath}`);
  }

  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > source.length || source.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`corresponding-source ZIP central directory is invalid: ${archivePath}`);
    }
    const flags = source.readUInt16LE(offset + 8);
    const method = source.readUInt16LE(offset + 10);
    const compressedSize = source.readUInt32LE(offset + 20);
    const uncompressedSize = source.readUInt32LE(offset + 24);
    const nameLength = source.readUInt16LE(offset + 28);
    const extraLength = source.readUInt16LE(offset + 30);
    const entryCommentLength = source.readUInt16LE(offset + 32);
    const localOffset = source.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (
      nextOffset > source.length ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      (flags & 1) !== 0 ||
      ![0, 8].includes(method)
    ) {
      throw new Error(`corresponding-source ZIP entry is unsupported: ${archivePath}`);
    }
    const name = source.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const safeName = name.endsWith('/') ? name.slice(0, -1) : name;
    if (!safeName || !isSafeRelativePath(safeName) || entries.has(name)) {
      throw new Error(`corresponding-source ZIP entry path is invalid: ${name}`);
    }
    entries.set(name, { compressedSize, flags, localOffset, method, uncompressedSize });
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error(`corresponding-source ZIP central directory size is invalid: ${archivePath}`);
  }
  return { entries, source };
}

function readZipEntry(archive, name) {
  const entry = archive.entries.get(name);
  if (!entry) {
    throw new Error(`corresponding-source archive is missing ${name}`);
  }
  const { source } = archive;
  const offset = entry.localOffset;
  if (offset + 30 > source.length || source.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`corresponding-source ZIP local entry is invalid: ${name}`);
  }
  const localFlags = source.readUInt16LE(offset + 6);
  const localMethod = source.readUInt16LE(offset + 8);
  const nameLength = source.readUInt16LE(offset + 26);
  const extraLength = source.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  const localName = source.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
  if (
    localFlags !== entry.flags ||
    localMethod !== entry.method ||
    localName !== name ||
    dataEnd > source.length
  ) {
    throw new Error(`corresponding-source ZIP entry data is invalid: ${name}`);
  }
  const compressed = source.subarray(dataOffset, dataEnd);
  const content = entry.method === 0 ? compressed : inflateRawSync(compressed);
  if (content.length !== entry.uncompressedSize) {
    throw new Error(`corresponding-source ZIP entry size mismatch: ${name}`);
  }
  return content;
}

function validateArchiveEvidence(sourceDir, manifest) {
  for (const component of manifest.components) {
    const archivePath = path.join(sourceDir, component.archive);
    const archive = indexZipArchive(archivePath);
    const prefix = `${component.name}-${component.revision}/`;
    for (const licenseFile of component.licenseFiles) {
      readZipEntry(archive, `${prefix}${licenseFile}`);
    }
    if (component.name === 'qm-api-rs') {
      readZipEntry(archive, `${prefix}Cargo.toml`);
      continue;
    }

    const evidence = new Map([
      [manifest.p14c.readinessRecord, manifest.p14c.readinessSha256],
      [manifest.provenance.ledger, manifest.provenance.ledgerSha256],
      ...manifest.provenance.evidence.map((file) => [
        file,
        manifest.provenance.evidenceSha256[file],
      ]),
    ]);
    for (const [file, expectedHash] of evidence) {
      const content = readZipEntry(archive, `${prefix}${file}`);
      if (sha256Bytes(content) !== expectedHash) {
        throw new Error(`corresponding-source evidence hash mismatch: ${file}`);
      }
    }
    const readiness = JSON.parse(
      readZipEntry(archive, `${prefix}${manifest.p14c.readinessRecord}`).toString('utf8'),
    );
    const ledger = JSON.parse(
      readZipEntry(archive, `${prefix}${manifest.provenance.ledger}`).toString('utf8'),
    );
    if (
      readiness?.cutoverAuthorized !== true ||
      readiness?.defaultBackend !== 'qmapi' ||
      readiness?.targetPin !== QM_API_RS_REV ||
      ledger?.release?.decision !== 'pass' ||
      !Array.isArray(ledger?.release?.blockers) ||
      ledger.release.blockers.length !== 0 ||
      ledger?.audit?.qmApiRs?.revision !== QM_API_RS_REV
    ) {
      throw new Error('corresponding-source archive contains non-release-ready evidence');
    }
  }
}

function validateCorrespondingSource(sourceDir) {
  if (!existsSync(sourceDir)) {
    throw new Error(`corresponding source is missing: ${sourceDir}`);
  }
  const manifestPath = path.join(sourceDir, CORRESPONDING_SOURCE_MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(`corresponding-source manifest is missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.license !== 'GPL-3.0-or-later' ||
    !/^[0-9a-f]{40}$/u.test(manifest?.releaseCommit ?? '') ||
    manifest?.qmApiRsRevision !== QM_API_RS_REV ||
    manifest?.p14c?.status !== 'READY' ||
    manifest?.p14c?.targetPin !== QM_API_RS_REV ||
    manifest?.p14c?.readinessRecord !== 'docs/release/provider-readiness.json' ||
    !/^[0-9a-f]{64}$/u.test(manifest?.p14c?.readinessSha256 ?? '') ||
    manifest?.provenance?.status !== 'PASS' ||
    manifest?.provenance?.ledger !== 'docs/release/provenance-ledger.json' ||
    !/^[0-9a-f]{64}$/u.test(manifest?.provenance?.ledgerSha256 ?? '') ||
    JSON.stringify(manifest?.provenance?.evidence) !==
      JSON.stringify(['docs/release/provenance.md', 'docs/release/qm-api-rs-provenance.md']) ||
    Object.keys(manifest?.provenance?.evidenceSha256 ?? {}).length !== 2 ||
    manifest.provenance.evidence.some(
      (file) => !/^[0-9a-f]{64}$/u.test(manifest.provenance.evidenceSha256[file] ?? ''),
    ) ||
    !Array.isArray(manifest.components) ||
    manifest.components.length !== 2
  ) {
    throw new Error('corresponding-source manifest is not release-ready');
  }
  const expectedComponents = new Map([
    [
      'YAQMC',
      {
        origin: YAQMC_ORIGIN,
        revision: manifest.releaseCommit,
        archive: `YAQMC-source-${manifest.releaseCommit}.zip`,
      },
    ],
    [
      'qm-api-rs',
      {
        origin: QM_API_RS_ORIGIN,
        revision: QM_API_RS_REV,
        archive: `qm-api-rs-source-${QM_API_RS_REV}.zip`,
      },
    ],
  ]);
  const archives = new Set();
  for (const component of manifest.components) {
    const expected = expectedComponents.get(component?.name);
    if (
      !expected ||
      component.origin !== expected.origin ||
      component.revision !== expected.revision ||
      component.archive !== expected.archive ||
      typeof component?.archive !== 'string' ||
      path.basename(component.archive) !== component.archive ||
      !/^[0-9a-f]{64}$/u.test(component.sha256 ?? '') ||
      !Array.isArray(component.licenseFiles) ||
      component.licenseFiles.length === 0 ||
      component.licenseFiles.some((licenseFile) => !isSafeRelativePath(licenseFile))
    ) {
      throw new Error('corresponding-source component entry is invalid');
    }
    const archive = path.join(sourceDir, component.archive);
    if (!existsSync(archive) || sha256File(archive) !== component.sha256) {
      throw new Error(`corresponding-source archive hash mismatch: ${component.archive}`);
    }
    if (archives.has(component.archive)) {
      throw new Error(`duplicate corresponding-source archive ${component.archive}`);
    }
    archives.add(component.archive);
    expectedComponents.delete(component.name);
  }
  if (expectedComponents.size > 0) {
    throw new Error('corresponding-source manifest is missing an expected component');
  }
  validateArchiveEvidence(sourceDir, manifest);
  return {
    files: [manifestPath, ...[...archives].sort().map((name) => path.join(sourceDir, name))],
    releaseCommit: manifest.releaseCommit,
  };
}

function validatePackageArtifactIdentity(sourceDir, releaseCommit) {
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  if (entries.length === 0) {
    throw new Error('electron release source contains no package artifacts');
  }
  for (const entry of entries) {
    const match =
      entry.isDirectory() &&
      /^YAQMC-electron-(windows|linux)-(x64|arm64)-([0-9a-f]{40})$/u.exec(entry.name);
    if (!match || match[3] !== releaseCommit) {
      throw new Error(
        `electron package artifact ${entry.name} is not bound to source commit ${releaseCommit}`,
      );
    }
    const [, platform, architecture] = match;
    const buildInfoPath = path.join(
      sourceDir,
      entry.name,
      `build-info-${platform}-${architecture}.json`,
    );
    if (!existsSync(buildInfoPath)) {
      throw new Error(`electron package artifact ${entry.name} has no build identity`);
    }
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
    if (
      buildInfo?.schemaVersion !== 1 ||
      buildInfo?.gitSha !== releaseCommit ||
      buildInfo?.os !== platform ||
      buildInfo?.architecture !== architecture ||
      typeof buildInfo?.target !== 'string' ||
      buildInfo.target.length === 0 ||
      !Array.isArray(buildInfo.files) ||
      buildInfo.files.length === 0
    ) {
      throw new Error(`electron package artifact ${entry.name} has a mismatched build identity`);
    }
    const expectedFiles = new Set(
      readdirSync(path.join(sourceDir, entry.name)).filter(
        (name) =>
          name !== path.basename(buildInfoPath) &&
          name !== `SHA256SUMS-electron-${platform}-${architecture}.txt`,
      ),
    );
    const recordedFiles = new Set();
    for (const file of buildInfo.files) {
      const filePath = path.join(sourceDir, entry.name, file?.name ?? '');
      if (
        typeof file?.name !== 'string' ||
        path.basename(file.name) !== file.name ||
        recordedFiles.has(file.name) ||
        !expectedFiles.has(file.name) ||
        !/^[0-9a-f]{64}$/u.test(file?.sha256 ?? '') ||
        !existsSync(filePath) ||
        sha256File(filePath) !== file.sha256
      ) {
        throw new Error(`electron package artifact ${entry.name} has invalid file hashes`);
      }
      recordedFiles.add(file.name);
    }
    if (recordedFiles.size !== expectedFiles.size) {
      throw new Error(
        `electron package artifact ${entry.name} omits files from its build identity`,
      );
    }
  }
}

export function assembleElectronRelease({ sourceDir, correspondingSourceDir, destDir }) {
  if (!existsSync(sourceDir)) {
    throw new Error(`electron release source is missing: ${sourceDir}`);
  }
  if (existsSync(destDir) && readdirSync(destDir).length > 0) {
    throw new Error(`refusing to overwrite non-empty Electron release directory ${destDir}`);
  }
  const correspondingSource = validateCorrespondingSource(correspondingSourceDir);
  validatePackageArtifactIdentity(sourceDir, correspondingSource.releaseCommit);
  mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const file of [...listFilesRecursive(sourceDir), ...correspondingSource.files]) {
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
  if (!options.from || !options['source-from'] || !options.to) {
    throw new Error('assemble-electron-release requires --from, --source-from, and --to');
  }
  const result = assembleElectronRelease({
    sourceDir: options.from,
    correspondingSourceDir: options['source-from'],
    destDir: options.to,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
