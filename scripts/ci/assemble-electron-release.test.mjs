import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './repo.mjs';
import {
  ELECTRON_COMBINED_CHECKSUMS_NAME,
  ELECTRON_RELEASE_NOTES,
  ELECTRON_RELEASE_NOTES_NAME,
  assembleElectronRelease,
  electronDraftTag,
} from './assemble-electron-release.mjs';
import {
  AMLL_ORIGIN,
  AMLL_REV,
  AMLL_VERSION,
  CORRESPONDING_SOURCE_MANIFEST,
} from './corresponding-source.mjs';
import { QM_API_RS_ORIGIN, QM_API_RS_REV } from './qm-api-rs-access.mjs';
import { sha256File } from './write-build-info.mjs';

const WORKFLOW = path.join(repositoryRoot, '.github', 'workflows', 'electron-release.yml');

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const content = Buffer.from(value, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + content.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, central, end]);
}

test('tagged builds publish against the existing version tag', () => {
  assert.equal(electronDraftTag({ eventName: 'push', refName: 'v0.1.0' }), 'v0.1.0');
  assert.equal(
    electronDraftTag({ eventName: 'workflow_dispatch', refName: 'main', runId: '99' }),
    'electron-draft-99',
  );
  assert.equal(electronDraftTag({ eventName: 'push', refName: 'v1.2.3' }), 'v1.2.3');
});

test('assembles installers, x64 updater feeds, and combined checksums', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-electron-release-'));
  const packages = path.join(root, 'packed');
  const releaseCommit = 'a'.repeat(40);
  const win = path.join(packages, `YAQMC-electron-windows-x64-${releaseCommit}`);
  const linux = path.join(packages, `YAQMC-electron-linux-x64-${releaseCommit}`);
  mkdirSync(win, { recursive: true });
  mkdirSync(linux, { recursive: true });
  writeFileSync(path.join(win, 'YAQMC-windows-x64-setup.exe'), 'nsis');
  writeFileSync(
    path.join(win, 'latest.yml'),
    'version: 0.1.0\npath: YAQMC-windows-x64-setup.exe\n',
  );
  writeFileSync(path.join(linux, 'YAQMC-linux-x64.AppImage'), 'appimage');
  writeFileSync(
    path.join(linux, 'latest-linux.yml'),
    'version: 0.1.0\npath: YAQMC-linux-x64.AppImage\n',
  );
  writeFileSync(
    path.join(win, 'build-info-windows-x64.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      gitSha: releaseCommit,
      os: 'windows',
      architecture: 'x64',
      target: 'x86_64-pc-windows-msvc',
      files: ['YAQMC-windows-x64-setup.exe', 'latest.yml'].map((name) => ({
        name,
        sha256: sha256File(path.join(win, name)),
      })),
    })}\n`,
  );
  writeFileSync(
    path.join(linux, 'build-info-linux-x64.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      gitSha: releaseCommit,
      os: 'linux',
      architecture: 'x64',
      target: 'x86_64-unknown-linux-gnu',
      files: ['YAQMC-linux-x64.AppImage', 'latest-linux.yml'].map((name) => ({
        name,
        sha256: sha256File(path.join(linux, name)),
      })),
    })}\n`,
  );
  const correspondingSource = path.join(root, 'corresponding-source');
  mkdirSync(correspondingSource);
  const yaqmcSource = `YAQMC-source-${releaseCommit}.zip`;
  const qmApiSource = `qm-api-rs-source-${QM_API_RS_REV}.zip`;
  const amllSource = `applemusic-like-lyrics-source-${AMLL_REV}.zip`;
  const readinessRecord = `${JSON.stringify({
    cutoverAuthorized: true,
    defaultBackend: 'qmapi',
    targetPin: QM_API_RS_REV,
  })}\n`;
  const provenanceLedger = `${JSON.stringify({
    audit: { qmApiRs: { revision: QM_API_RS_REV } },
    release: { decision: 'pass', blockers: [] },
  })}\n`;
  const provenanceAudit = 'provenance audit\n';
  const qmApiProvenance = 'qm-api-rs provenance\n';
  writeFileSync(
    path.join(correspondingSource, yaqmcSource),
    storedZip({
      [`YAQMC-${releaseCommit}/LICENSE`]: 'GPL-3.0-or-later\n',
      [`YAQMC-${releaseCommit}/docs/release/provider-readiness.json`]: readinessRecord,
      [`YAQMC-${releaseCommit}/docs/release/provenance-ledger.json`]: provenanceLedger,
      [`YAQMC-${releaseCommit}/docs/release/provenance.md`]: provenanceAudit,
      [`YAQMC-${releaseCommit}/docs/release/qm-api-rs-provenance.md`]: qmApiProvenance,
    }),
  );
  writeFileSync(
    path.join(correspondingSource, qmApiSource),
    storedZip({
      [`qm-api-rs-${QM_API_RS_REV}/Cargo.toml`]: '[package]\nname = "qqmusic-api"\n',
      [`qm-api-rs-${QM_API_RS_REV}/LICENSE`]: 'GPL-3.0-or-later\n',
    }),
  );
  writeFileSync(
    path.join(correspondingSource, amllSource),
    storedZip({
      [`applemusic-like-lyrics-${AMLL_REV}/LICENSE`]: 'AGPL-3.0-only\n',
      [`applemusic-like-lyrics-${AMLL_REV}/package.json`]: `${JSON.stringify({ license: 'AGPL-3.0-only' })}\n`,
      [`applemusic-like-lyrics-${AMLL_REV}/pnpm-lock.yaml`]: 'lockfileVersion: 9\n',
      [`applemusic-like-lyrics-${AMLL_REV}/packages/core/package.json`]: `${JSON.stringify({
        name: '@applemusic-like-lyrics/core',
        version: AMLL_VERSION,
        license: 'AGPL-3.0-only',
      })}\n`,
      [`applemusic-like-lyrics-${AMLL_REV}/packages/core/src/index.ts`]: 'export {};\n',
      [`applemusic-like-lyrics-${AMLL_REV}/packages/react/package.json`]: `${JSON.stringify({
        name: '@applemusic-like-lyrics/react',
        version: AMLL_VERSION,
        license: 'AGPL-3.0-only',
      })}\n`,
      [`applemusic-like-lyrics-${AMLL_REV}/packages/react/src/index.ts`]: 'export {};\n',
    }),
  );
  writeFileSync(
    path.join(correspondingSource, CORRESPONDING_SOURCE_MANIFEST),
    `${JSON.stringify({
      schemaVersion: 2,
      license: 'GPL-3.0-or-later',
      releaseCommit,
      qmApiRsRevision: QM_API_RS_REV,
      amll: {
        origin: AMLL_ORIGIN,
        revision: AMLL_REV,
        version: AMLL_VERSION,
        license: 'AGPL-3.0-only',
        packages: [
          {
            name: '@applemusic-like-lyrics/core',
            manifestPath: 'packages/core/package.json',
          },
          {
            name: '@applemusic-like-lyrics/react',
            manifestPath: 'packages/react/package.json',
          },
        ],
      },
      p14c: {
        status: 'READY',
        targetPin: QM_API_RS_REV,
        readinessRecord: 'docs/release/provider-readiness.json',
        readinessSha256: sha256Text(readinessRecord),
      },
      provenance: {
        status: 'PASS',
        ledger: 'docs/release/provenance-ledger.json',
        ledgerSha256: sha256Text(provenanceLedger),
        evidence: ['docs/release/provenance.md', 'docs/release/qm-api-rs-provenance.md'],
        evidenceSha256: {
          'docs/release/provenance.md': sha256Text(provenanceAudit),
          'docs/release/qm-api-rs-provenance.md': sha256Text(qmApiProvenance),
        },
      },
      components: [
        {
          name: 'YAQMC',
          origin: 'https://github.com/YAQMC/YAQMC',
          revision: releaseCommit,
          archive: yaqmcSource,
          sha256: sha256File(path.join(correspondingSource, yaqmcSource)),
          licenseFiles: ['LICENSE'],
        },
        {
          name: 'qm-api-rs',
          origin: QM_API_RS_ORIGIN,
          revision: QM_API_RS_REV,
          archive: qmApiSource,
          sha256: sha256File(path.join(correspondingSource, qmApiSource)),
          licenseFiles: ['LICENSE'],
        },
        {
          name: 'applemusic-like-lyrics',
          origin: AMLL_ORIGIN,
          revision: AMLL_REV,
          archive: amllSource,
          sha256: sha256File(path.join(correspondingSource, amllSource)),
          licenseFiles: ['LICENSE'],
        },
      ],
    })}\n`,
  );
  const dest = path.join(root, 'assembled');
  const result = assembleElectronRelease({
    sourceDir: packages,
    correspondingSourceDir: correspondingSource,
    destDir: dest,
  });
  assert.equal(result.hasWindowsFeed, true);
  assert.equal(result.hasLinuxFeed, true);
  assert.equal(readFileSync(path.join(dest, 'YAQMC-windows-x64-setup.exe'), 'utf8'), 'nsis');
  assert.match(readFileSync(path.join(dest, 'latest.yml'), 'utf8'), /YAQMC-windows-x64-setup\.exe/);
  assert.match(readFileSync(path.join(dest, 'latest-linux.yml'), 'utf8'), /AppImage/);
  assert.match(
    readFileSync(path.join(dest, ELECTRON_COMBINED_CHECKSUMS_NAME), 'utf8'),
    /YAQMC-windows-x64-setup\.exe/,
  );
  assert.match(
    readFileSync(path.join(dest, ELECTRON_COMBINED_CHECKSUMS_NAME), 'utf8'),
    new RegExp(`YAQMC-source-${releaseCommit}\\.zip`),
  );
  assert.match(
    readFileSync(path.join(dest, ELECTRON_COMBINED_CHECKSUMS_NAME), 'utf8'),
    new RegExp(`applemusic-like-lyrics-source-${AMLL_REV}\\.zip`),
  );
  assert.equal(
    readFileSync(path.join(dest, ELECTRON_RELEASE_NOTES_NAME), 'utf8'),
    ELECTRON_RELEASE_NOTES,
  );
  assert.match(ELECTRON_RELEASE_NOTES, /Authenticode-signed/i);
  assert.match(ELECTRON_RELEASE_NOTES, /publisher/i);
  assert.match(ELECTRON_RELEASE_NOTES, /i686/);
  assert.match(ELECTRON_RELEASE_NOTES, /Chromium\/Ozone/);
  assert.match(ELECTRON_RELEASE_NOTES, /org\.yaqmc\.desktop/);
  assert.match(ELECTRON_RELEASE_NOTES, /corresponding-source/);
  assert.match(ELECTRON_RELEASE_NOTES, /Apple Music-like Lyrics/);
  assert.doesNotMatch(ELECTRON_RELEASE_NOTES, /Provenance remains \*\*BLOCKED\*\*/);

  const manifestPath = path.join(correspondingSource, CORRESPONDING_SOURCE_MANIFEST);
  const manifestSource = readFileSync(manifestPath, 'utf8');
  const mismatchedManifest = JSON.parse(manifestSource);
  mismatchedManifest.p14c.readinessSha256 = 'c'.repeat(64);
  writeFileSync(manifestPath, `${JSON.stringify(mismatchedManifest)}\n`);
  assert.throws(
    () =>
      assembleElectronRelease({
        sourceDir: packages,
        correspondingSourceDir: correspondingSource,
        destDir: path.join(root, 'mismatched-source-assembled'),
      }),
    /evidence hash mismatch/,
  );
  writeFileSync(manifestPath, manifestSource);

  writeFileSync(path.join(win, 'YAQMC-windows-x64-setup.exe'), 'tampered');
  assert.throws(
    () =>
      assembleElectronRelease({
        sourceDir: packages,
        correspondingSourceDir: correspondingSource,
        destDir: path.join(root, 'tampered-assembled'),
      }),
    /invalid file hashes/,
  );
});

test('Electron release workflow is the sole tagged desktop release workflow', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /^name: Electron release/m);
  assert.match(workflow, /tags:\s*\n\s+-\s+'v\*'/);
  assert.match(workflow, /node scripts\/ci\/package-electron\.mjs/);
  assert.match(workflow, /libasound2-dev rpm fakeroot/);
  assert.match(workflow, /environment:\s*release-signing/);
  assert.match(workflow, /--require-signing/);
  assert.match(workflow, /secrets\.WIN_CSC_LINK/);
  assert.match(workflow, /secrets\.WIN_CSC_KEY_PASSWORD/);
  assert.match(workflow, /secrets\.YAQMC_WINDOWS_SIGNER_SUBJECT/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /SignatureStatus\]::Valid/);
  assert.match(workflow, /npm run provider:enforce/);
  assert.match(workflow, /npm run provenance:enforce/);
  assert.match(workflow, /node scripts\/ci\/corresponding-source\.mjs/);
  assert.match(workflow, /repository: YAQMC\/qm-api-rs/);
  assert.match(workflow, new RegExp(`ref:\\s*${QM_API_RS_REV}`));
  assert.match(workflow, /repository: amll-dev\/applemusic-like-lyrics/);
  assert.match(workflow, new RegExp(`ref:\\s*${AMLL_REV}`));
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /--source-from corresponding-source/);
  assert.match(workflow, /node scripts\/ci\/stage-linux-tester\.mjs/);
  assert.match(workflow, /YAQMC-linux-x64-tester-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /node scripts\/ci\/assemble-electron-release\.mjs/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--draft/);
  assert.doesNotMatch(workflow, /autoDownload:\s*true/);
  assert.doesNotMatch(workflow, /--publish always/);
});
