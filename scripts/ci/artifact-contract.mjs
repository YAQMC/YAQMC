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
].map(([id, source, platform, kind, pattern]) =>
  Object.freeze({ id, source, platform, kind, pattern }),
);

export function artifactContractEntries() {
  return CONTRACT.map((entry) => ({ ...entry }));
}
