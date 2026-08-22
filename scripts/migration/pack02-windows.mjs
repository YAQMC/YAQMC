/**
 * PACK-02: Windows NSIS + portable install / upgrade / uninstall script.
 * Prints pending clean-VM matrix. Does not run installers. Unsigned (R-9).
 * Run: node scripts/migration/pack02-windows.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK02_ID = 'PACK-02';
export const APP_ID = 'org.yaqmc.desktop';
export const PRODUCT_NAME = 'YAQMC';
export const ELECTRON_VERSION = '43.4.0';
export const BUILDER_VERSION = '26.15.7';
export const OUTPUT_DIR_NAME = 'release-electron';
export const NSIS = { oneClick: false, perMachine: false };
export const CLEAN_VM_STATE = 'LIVE VERIFY pending';

export function nsisArtifactName(arch = 'x64') {
  return `YAQMC-windows-${arch}-setup.exe`;
}
export function portableArtifactName(arch = 'x64') {
  return `YAQMC-windows-${arch}-portable.exe`;
}
export function packWinScript() {
  return 'electron-builder --projectDir . --config electron-builder.yml --win --x64 --publish never';
}
export function packWinArm64Note() {
  return 'electron-builder --projectDir . --config electron-builder.yml --win --arm64';
}
export function perUserInstallDir(localAppData) {
  return path.win32.join(localAppData, 'Programs', PRODUCT_NAME);
}
export function nsisUninstallerName() {
  return `Uninstall ${PRODUCT_NAME}.exe`;
}
export function nsisInstallCommand(setupExe, { silent = true, dir } = {}) {
  const quoted = `"${setupExe}"`;
  const flags = [];
  if (silent) flags.push('/S');
  if (dir) flags.push(`/D=${dir}`);
  return flags.length ? `${quoted} ${flags.join(' ')}` : quoted;
}
export function nsisUninstallCommand(installDir, { silent = true } = {}) {
  const uninstaller = path.win32.join(installDir, nsisUninstallerName());
  const quoted = `"${uninstaller}"`;
  return silent ? `${quoted} /S` : quoted;
}
export function parseBuilderNsis(yaml) {
  return {
    appId: /^\s*appId:\s*org\.yaqmc\.desktop\s*$/m.test(yaml),
    oneClickFalse: /^\s*oneClick:\s*false\s*$/m.test(yaml),
    perMachineFalse: /^\s*perMachine:\s*false\s*$/m.test(yaml),
    nsisTarget: /target:\s*nsis/.test(yaml),
    portableTarget: /target:\s*portable/.test(yaml),
    forceCodeSigningFalse: /^\s*forceCodeSigning:\s*false\s*$/m.test(yaml),
    hasElectronUpdater: /^\s*electron-updater:/m.test(yaml),
  };
}
export function pack02Report({
  repoRoot,
  env = process.env,
  now = () => new Date().toISOString().slice(0, 10),
} = {}) {
  const outputDir = path.join(repoRoot, OUTPUT_DIR_NAME);
  const yamlPath = path.join(repoRoot, 'apps', 'desktop', 'electron-builder.yml');
  const pkgPath = path.join(repoRoot, 'apps', 'desktop', 'package.json');
  const yaml = existsSync(yamlPath) ? readFileSync(yamlPath, 'utf8') : '';
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
  const localAppData =
    env.LOCALAPPDATA ||
    path.win32.join(env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');
  const appData =
    env.APPDATA || path.win32.join(env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Roaming');
  const installDir = perUserInstallDir(localAppData);
  const artifacts = {};
  for (const arch of ['x64', 'arm64']) {
    artifacts[`nsis-${arch}`] = {
      name: nsisArtifactName(arch),
      path: path.join(outputDir, nsisArtifactName(arch)),
      found: existsSync(path.join(outputDir, nsisArtifactName(arch))),
    };
    artifacts[`portable-${arch}`] = {
      name: portableArtifactName(arch),
      path: path.join(outputDir, portableArtifactName(arch)),
      found: existsSync(path.join(outputDir, portableArtifactName(arch))),
    };
  }
  return {
    id: PACK02_ID,
    date: now(),
    unsigned: true,
    risk: 'R-9',
    electron: ELECTRON_VERSION,
    electronBuilder: BUILDER_VERSION,
    appId: APP_ID,
    nsis: { ...NSIS, scope: 'per-user' },
    packWin: pkg.scripts?.['pack:win'] ?? null,
    packWinArm64: packWinArm64Note(),
    electronUpdater: Boolean(
      pkg.dependencies?.['electron-updater'] || pkg.devDependencies?.['electron-updater'],
    ),
    builderConfig: parseBuilderNsis(yaml),
    dataDir: path.win32.join(appData, APP_ID),
    perUserInstallDir: installDir,
    artifacts,
    commands: {
      packWin: 'npm run pack:win -w @yaqmc/desktop',
      nsisInstallA: nsisInstallCommand(path.join(outputDir, nsisArtifactName('x64')), {
        dir: installDir,
      }),
      nsisInstallB: nsisInstallCommand(path.join(outputDir, nsisArtifactName('x64')), {
        dir: installDir,
      }),
      nsisUninstall: nsisUninstallCommand(installDir),
      portable: `"${path.join(outputDir, portableArtifactName('x64'))}"`,
    },
    Windows: {
      nsisPerUserInstall: { state: CLEAN_VM_STATE, checked: false },
      portableExe: { state: CLEAN_VM_STATE, checked: false },
      upgradeAB: { state: CLEAN_VM_STATE, checked: false },
      uninstall: { state: CLEAN_VM_STATE, checked: false },
      x64: { state: CLEAN_VM_STATE, checked: false },
      arm64: { state: CLEAN_VM_STATE, checked: false },
    },
    notes: [
      'LIVE VERIFY / clean-VM pending. This script does not install, upgrade, or uninstall.',
      'Unsigned (R-9).',
      'Do not bump Electron. electron-updater is notify-only (UPD-01); A→B rehearsal still pending.',
      'Do not start qm-api-rs. Provenance remains BLOCKED. 32 MiB protocol hard cap unchanged.',
    ],
  };
}
const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  process.stdout.write(`${JSON.stringify(pack02Report({ repoRoot }), null, 2)}\n`);
}
