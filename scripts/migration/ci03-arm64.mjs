/**
 * CI-03: print arm64 yaqmc-core + electron-builder commands (dry).
 *
 * Does not run cargo, rustup, or electron-builder. Does not claim boot-test
 * green. Does not edit .github/workflows/ci.yml. PACK-01 already declares
 * arm64 in apps/desktop/electron-builder.yml.
 *
 * Run: node scripts/migration/ci03-arm64.mjs
 *
 * Windows core cross-build:
 *   rustup target add aarch64-pc-windows-msvc
 *   cargo build -p yaqmc-core --release --target aarch64-pc-windows-msvc
 * Linux native (ubuntu-24.04-arm):
 *   cargo build -p yaqmc-core --release --target aarch64-unknown-linux-gnu
 * Pack:
 *   electron-builder --projectDir apps/desktop --config electron-builder.yml --win --arm64
 *   electron-builder --projectDir apps/desktop --config electron-builder.yml --linux --arm64
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CI03_ID = 'CI-03';
export const ELECTRON_VERSION = '43.4.0';
export const BUILDER_VERSION = '26.15.7';
export const WINDOWS_CORE_TRIPLE = 'aarch64-pc-windows-msvc';
export const LINUX_CORE_TRIPLE = 'aarch64-unknown-linux-gnu';
export const LINUX_ARM_RUNNER = 'ubuntu-24.04-arm';
export const BOOT_TEST_STATE = 'boot-test pending';
export const HARDWARE_STATE = 'hardware pending';

export function rustupWindowsArm64Target() {
  return `rustup target add ${WINDOWS_CORE_TRIPLE}`;
}

export function cargoWindowsArm64Core() {
  return `cargo build -p yaqmc-core --release --target ${WINDOWS_CORE_TRIPLE}`;
}

export function cargoLinuxArm64Core() {
  return `cargo build -p yaqmc-core --release --target ${LINUX_CORE_TRIPLE}`;
}

export function cargoLinuxArm64Native() {
  return 'cargo build -p yaqmc-core --release';
}

export function electronBuilderWinArm64() {
  return 'electron-builder --projectDir apps/desktop --config electron-builder.yml --win --arm64';
}

export function electronBuilderLinuxArm64() {
  return 'electron-builder --projectDir apps/desktop --config electron-builder.yml --linux --arm64';
}

export function windowsCoreBinaryPath() {
  return `target/${WINDOWS_CORE_TRIPLE}/release/yaqmc-core.exe`;
}

export function linuxCoreBinaryPath() {
  return `target/${LINUX_CORE_TRIPLE}/release/yaqmc-core`;
}

export function ci03Report({ now = () => new Date().toISOString().slice(0, 10) } = {}) {
  return {
    id: CI03_ID,
    date: now(),
    dry: true,
    executedCargo: false,
    executedElectronBuilder: false,
    electron: ELECTRON_VERSION,
    electronBuilder: BUILDER_VERSION,
    electronUpdater: false,
    ciYmlEdited: false,
    provenance: 'BLOCKED',
    protocolHardCapMiB: 32,
    qmApiRs: false,
    windows: {
      story: 'cross-build',
      triple: WINDOWS_CORE_TRIPLE,
      hardware: HARDWARE_STATE,
      bootTest: BOOT_TEST_STATE,
      commands: {
        rustup: rustupWindowsArm64Target(),
        cargo: cargoWindowsArm64Core(),
        stage: `Copy-Item ${windowsCoreBinaryPath().replaceAll('/', '\\')} apps\\desktop\\resources\\core\\yaqmc-core.exe`,
        pack: electronBuilderWinArm64(),
      },
      coreBinary: windowsCoreBinaryPath(),
    },
    linux: {
      story: 'native',
      runner: LINUX_ARM_RUNNER,
      triple: LINUX_CORE_TRIPLE,
      hardware: HARDWARE_STATE,
      bootTest: BOOT_TEST_STATE,
      commands: {
        cargoNative: cargoLinuxArm64Native(),
        cargo: cargoLinuxArm64Core(),
        pack: electronBuilderLinuxArm64(),
      },
      coreBinary: linuxCoreBinaryPath(),
    },
    pack01: {
      ymlDeclaresArm64: true,
      note: 'apps/desktop/electron-builder.yml already lists win/linux arm64 targets (PACK-01).',
    },
    notes: [
      'Dry print only. This script does not execute cargo, rustup, or electron-builder.',
      `Windows: cross-build yaqmc-core for ${WINDOWS_CORE_TRIPLE} from x64 Windows + MSVC ARM64 tools.`,
      `Linux: native ${LINUX_ARM_RUNNER} when hardware/CI allows; do not cross GNU from this Windows host.`,
      'electron-builder already declares arm64 in PACK-01 yml.',
      'Boot-test pending. Hardware pending. CI-03 is not green.',
      'Do not edit .github/workflows/ci.yml in this checkpoint.',
      'Do not bump Electron. Do not add electron-updater. Do not start qm-api-rs.',
      'Provenance remains BLOCKED. 32 MiB protocol hard cap unchanged.',
    ],
  };
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.stdout.write(`${JSON.stringify(ci03Report(), null, 2)}\n`);
}
