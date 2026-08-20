/**
 * PACK-03: Linux AppImage / deb / rpm / tar.gz install / upgrade / uninstall script.
 *
 * Dry-run: parse apps/desktop/electron-builder.yml, print electron-builder
 * --linux flags for the declared targets, and emit a LIVE VERIFY / clean-VM
 * pending matrix. Does not require a Linux builder. Does not fail when this
 * Windows host cannot produce artifacts. Does not claim the matrix green,
 * does not bump Electron, and does not add an updater dependency. Unsigned (R-9).
 *
 * Run: node scripts/migration/pack03-linux.mjs
 * Optional: --execute  (spawns electron-builder --linux; skips on non-Linux)
 *
 * x64:
 *   electron-builder --projectDir . --config electron-builder.yml --linux AppImage deb rpm tar.gz --x64
 * arm64 (CI-03):
 *   electron-builder --projectDir . --config electron-builder.yml --linux AppImage deb rpm tar.gz --arm64
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK03_ID = 'PACK-03';
export const APP_ID = 'org.yaqmc.desktop';
export const PRODUCT_NAME = 'YAQMC';
export const ELECTRON_VERSION = '43.4.0';
export const BUILDER_VERSION = '26.15.7';
export const OUTPUT_DIR_NAME = 'release-electron';
export const LINUX_TARGETS = ['AppImage', 'deb', 'rpm', 'tar.gz'];
export const LINUX_ARCHES = ['x64', 'arm64'];
export const UPDATER_BEARING_TARGET = 'AppImage';
export const TRAY_RECOMMENDS_DEB = 'libayatana-appindicator3-1';
export const TRAY_RECOMMENDS_RPM = 'libayatana-appindicator-gtk3';
export const CLEAN_VM_STATE = 'LIVE VERIFY pending';

export function linuxArtifactName(target, arch = 'x64') {
  const ext = target === 'tar.gz' ? 'tar.gz' : target === 'AppImage' ? 'AppImage' : target;
  return `YAQMC-linux-${arch}.${ext}`;
}

export function packLinuxCommand(arch = 'x64', targets = LINUX_TARGETS) {
  return `electron-builder --projectDir . --config electron-builder.yml --linux ${targets.join(' ')} --${arch}`;
}

export function packLinuxCommands(targets = LINUX_TARGETS, arches = LINUX_ARCHES) {
  return Object.fromEntries(arches.map((arch) => [arch, packLinuxCommand(arch, targets)]));
}

export function linuxDataDir({ env = {}, homedir = '/home/scratch' } = {}) {
  const dataHome = env.XDG_DATA_HOME || path.posix.join(homedir, '.local', 'share');
  return path.posix.join(dataHome, APP_ID);
}

export function linuxYamlBlock(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'linux:');
  if (start < 0) {
    return '';
  }
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '' || /^[ \t]/.test(line)) {
      block.push(line);
      continue;
    }
    break;
  }
  return `${block.join('\n')}\n`;
}

export function parseBuilderLinux(yaml) {
  const linux = linuxYamlBlock(yaml);
  const targets = LINUX_TARGETS.filter((target) =>
    new RegExp(`target:\\s*${target.replace('.', '\\.')}\\s*$`, 'm').test(linux),
  );
  const arches = LINUX_ARCHES.filter((arch) =>
    new RegExp(`^\\s+-\\s*${arch}\\s*$`, 'm').test(linux),
  );
  return {
    appId: /^\s*appId:\s*org\.yaqmc\.desktop\s*$/m.test(yaml),
    linuxSection: linux.startsWith('linux:'),
    targets,
    arches,
    appImage: targets.includes('AppImage'),
    deb: targets.includes('deb'),
    rpm: targets.includes('rpm'),
    tarGz: targets.includes('tar.gz'),
    x64: arches.includes('x64'),
    arm64: arches.includes('arm64'),
    artifactName: /artifactName:\s*YAQMC-linux-\$\{arch\}\.\$\{ext\}/.test(linux),
    updaterBearingAppImage: targets.includes('AppImage'),
    ayatanaRecommends: /libayatana-appindicator/.test(yaml),
    ayatanaDeb: yaml.includes(TRAY_RECOMMENDS_DEB),
    ayatanaRpm: yaml.includes(TRAY_RECOMMENDS_RPM),
    webkitGtkDepends: /webkit2?gtk/i.test(yaml),
    hasElectronUpdater: /^\s*[^#\n]*electron-updater/m.test(yaml),
    forceCodeSigningFalse: /^\s*forceCodeSigning:\s*false\s*$/m.test(yaml.replaceAll('\r', '')),
    electronVersion: /^\s*electronVersion:\s*43\.4\.0\s*$/m.test(yaml.replaceAll('\r', '')),
  };
}

export function linuxInstallCommand(target, artifactPath) {
  const quoted = quoteSh(artifactPath);
  if (target === 'AppImage') {
    return `chmod +x ${quoted} && ${quoted}`;
  }
  if (target === 'deb') {
    return `sudo apt install ${quoted}`;
  }
  if (target === 'rpm') {
    return `sudo dnf install ${quoted}`;
  }
  return `tar -xzf ${quoted}`;
}

export function linuxUninstallCommand(target, artifactPath) {
  const quoted = quoteSh(artifactPath);
  if (target === 'AppImage') {
    return `rm -f ${quoted}`;
  }
  if (target === 'deb') {
    return `pkg="$(dpkg-deb -f ${quoted} Package)"; sudo apt remove "$pkg"`;
  }
  if (target === 'rpm') {
    return `pkg="$(rpm -qp --queryformat '%{NAME}\\n' ${quoted})"; sudo dnf remove "$pkg"`;
  }
  return `rm -rf <extracted-tree-from ${quoted}>`;
}

export function pack03Report({
  repoRoot,
  env = process.env,
  now = () => new Date().toISOString().slice(0, 10),
  platform = process.platform,
} = {}) {
  const outputDir = path.join(repoRoot, OUTPUT_DIR_NAME);
  const yamlPath = path.join(repoRoot, 'apps', 'desktop', 'electron-builder.yml');
  const pkgPath = path.join(repoRoot, 'apps', 'desktop', 'package.json');
  const yaml = existsSync(yamlPath) ? readFileSync(yamlPath, 'utf8') : '';
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
  const builderConfig = parseBuilderLinux(yaml);
  const homedir = env.HOME || '/home/scratch';
  const dataDir = linuxDataDir({ env, homedir });
  const commands = packLinuxCommands(
    builderConfig.targets.length ? builderConfig.targets : LINUX_TARGETS,
  );
  const artifacts = {};
  for (const arch of LINUX_ARCHES) {
    for (const target of LINUX_TARGETS) {
      const name = linuxArtifactName(target, arch);
      const artifactPath = path.join(outputDir, name);
      artifacts[`${target}-${arch}`] = {
        name,
        path: artifactPath,
        found: existsSync(artifactPath),
      };
    }
  }

  const linux = {};
  for (const key of [
    'appImageInstall',
    'debInstall',
    'rpmInstall',
    'tarGzInstall',
    'upgradeAB',
    'uninstall',
    'trayAyatanaNonFatal',
    'x64',
    'arm64',
  ]) {
    linux[key] = { state: CLEAN_VM_STATE, checked: false };
  }

  return {
    id: PACK03_ID,
    date: now(),
    unsigned: true,
    risk: 'R-9',
    electron: ELECTRON_VERSION,
    electronBuilder: BUILDER_VERSION,
    appId: APP_ID,
    updaterBearingTarget: UPDATER_BEARING_TARGET,
    trayRecommends: { deb: TRAY_RECOMMENDS_DEB, rpm: TRAY_RECOMMENDS_RPM, hardDepends: false },
    trayFailureNonFatal: true,
    packLinux: pkg.scripts?.['pack:linux'] ?? null,
    electronUpdater: Boolean(
      pkg.dependencies?.['electron-updater'] || pkg.devDependencies?.['electron-updater'],
    ),
    builderConfig,
    dataDir,
    hostPlatform: platform,
    canProduceLinuxArtifacts: platform === 'linux',
    artifacts,
    commands: {
      packLinuxX64: commands.x64,
      packLinuxArm64: commands.arm64,
      appImageRun: linuxInstallCommand(
        'AppImage',
        path.join(outputDir, linuxArtifactName('AppImage')),
      ),
      debInstall: linuxInstallCommand('deb', path.join(outputDir, linuxArtifactName('deb'))),
      rpmInstall: linuxInstallCommand('rpm', path.join(outputDir, linuxArtifactName('rpm'))),
      tarExtract: linuxInstallCommand('tar.gz', path.join(outputDir, linuxArtifactName('tar.gz'))),
      appImageUninstall: linuxUninstallCommand(
        'AppImage',
        path.join(outputDir, linuxArtifactName('AppImage')),
      ),
      debUninstall: linuxUninstallCommand('deb', path.join(outputDir, linuxArtifactName('deb'))),
      rpmUninstall: linuxUninstallCommand('rpm', path.join(outputDir, linuxArtifactName('rpm'))),
    },
    steps: [
      'On a Linux builder (not this Windows host): run electron-builder --linux AppImage deb rpm tar.gz --x64 from apps/desktop. arm64 is a separate --arm64 invocation (CI-03).',
      'AppImage is the updater-bearing target (plan §32). UPD-01 wires notify-only electron-updater; this script still does not run an A→B upgrade.',
      'On a scratch Linux user or clean VM (not the daily-driver profile): install A. Write a marker under $XDG_DATA_HOME/org.yaqmc.desktop (library.sqlite3 or pack03-upgrade-marker.txt).',
      'Install B over A (same appId). Confirm the marker and library.sqlite3 survive.',
      'Tray libayatana-appindicator is Recommends, not Depends. Missing indicator must not fail install; tray init failure is non-fatal.',
      'Uninstall the package or delete the AppImage/tarball tree. App data must remain.',
      'Leave every checkbox unchecked until a maintainer runs this on a clean VM. Do not claim PACK-03 green.',
    ],
    Linux: linux,
    notes: [
      'LIVE VERIFY / clean-VM pending. This script does not install, upgrade, or uninstall.',
      'Dry-run parse/print only on non-Linux hosts. Missing artifacts are not a failure.',
      'Unsigned (R-9). Do not bump Electron. electron-updater is notify-only (UPD-01); A→B rehearsal still pending.',
      'Do not start qm-api-rs. Provenance remains BLOCKED. 32 MiB protocol hard cap unchanged.',
    ],
  };
}

export function executeLinuxPack({
  repoRoot,
  platform = process.platform,
  spawn = spawnSync,
  arch = 'x64',
} = {}) {
  const command = packLinuxCommand(arch);
  if (platform !== 'linux') {
    return {
      attempted: false,
      skipped: true,
      reason: `Linux artifacts require a Linux builder (host is ${platform})`,
      command,
      status: 0,
    };
  }

  const desktopDir = path.join(repoRoot, 'apps', 'desktop');
  const result = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'electron-builder', 'cli.js'),
      '--projectDir',
      '.',
      '--config',
      'electron-builder.yml',
      '--linux',
      ...LINUX_TARGETS,
      `--${arch}`,
    ],
    { cwd: desktopDir, encoding: 'utf8' },
  );

  const status = result.status ?? 1;
  return {
    attempted: true,
    skipped: false,
    command,
    status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ok: true,
    produced: status === 0,
  };
}

function quoteSh(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function parseArgs(argv) {
  return { execute: argv.includes('--execute') };
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const flags = parseArgs(process.argv.slice(2));
  const report = pack03Report({ repoRoot });
  if (flags.execute) {
    report.execute = executeLinuxPack({ repoRoot });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
