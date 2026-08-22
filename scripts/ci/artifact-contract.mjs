const CONTRACT = [
  [
    'electron-windows-nsis',
    'apps/desktop/electron-builder.yml',
    'Windows',
    'NSIS installer',
    'YAQMC-windows-{arch}-setup.exe',
  ],
  [
    'electron-windows-portable',
    'apps/desktop/electron-builder.yml',
    'Windows',
    'Portable executable',
    'YAQMC-windows-{arch}-portable.exe',
  ],
  [
    'electron-windows-updater',
    'scripts/ci/assemble-electron-release.mjs',
    'Windows x64',
    'Updater metadata',
    'latest.yml',
  ],
  [
    'electron-linux-appimage',
    'apps/desktop/electron-builder.yml',
    'Linux',
    'AppImage',
    'YAQMC-linux-{arch}.AppImage',
  ],
  [
    'electron-linux-deb',
    'apps/desktop/electron-builder.yml',
    'Linux',
    'deb',
    'YAQMC-linux-{arch}.deb',
  ],
  [
    'electron-linux-rpm',
    'apps/desktop/electron-builder.yml',
    'Linux',
    'rpm',
    'YAQMC-linux-{arch}.rpm',
  ],
  [
    'electron-linux-tar',
    'apps/desktop/electron-builder.yml',
    'Linux',
    'tar.gz',
    'YAQMC-linux-{arch}.tar.gz',
  ],
  [
    'electron-linux-updater',
    'scripts/ci/assemble-electron-release.mjs',
    'Linux x64',
    'Updater metadata',
    'latest-linux.yml',
  ],
  [
    'electron-linux-tester',
    'scripts/ci/stage-linux-tester.mjs',
    'Linux x64',
    'Flat acceptance tester artifact',
    'YAQMC-linux-x64-tester-{sha}',
  ],
  [
    'electron-build-info',
    'scripts/ci/package-electron.mjs',
    'Windows/Linux',
    'Per-platform build identity',
    'build-info-{os}-{arch}.json',
  ],
  [
    'electron-release-checksums',
    'scripts/ci/assemble-electron-release.mjs',
    'Windows/Linux',
    'Checksums',
    'SHA256SUMS-electron.txt',
  ],
  [
    'electron-release-notes',
    'scripts/ci/assemble-electron-release.mjs',
    'Windows/Linux',
    'Release notes',
    'RELEASE-NOTES-ELECTRON.md',
  ],
  [
    'electron-corresponding-source-manifest',
    'scripts/ci/corresponding-source.mjs',
    'Windows/Linux',
    'Corresponding-source manifest',
    'CORRESPONDING-SOURCE-MANIFEST.json',
  ],
  [
    'electron-yaqmc-source',
    'scripts/ci/corresponding-source.mjs',
    'Windows/Linux',
    'YAQMC corresponding source',
    'YAQMC-source-{sha}.zip',
  ],
  [
    'electron-qm-api-rs-source',
    'scripts/ci/corresponding-source.mjs',
    'Windows/Linux',
    'qm-api-rs corresponding source',
    'qm-api-rs-source-{pin}.zip',
  ],
].map(([id, source, platform, kind, pattern]) =>
  Object.freeze({ id, source, platform, kind, pattern }),
);

export function artifactContractEntries() {
  return CONTRACT.map((entry) => ({ ...entry }));
}
