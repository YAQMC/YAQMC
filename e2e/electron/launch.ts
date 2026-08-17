import { existsSync } from 'node:fs';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VITE_DEV_ORIGIN, waitForFakeShell } from '../fake-ui';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const electronBinary = createRequire(path.join(desktopRoot, 'package.json'))('electron') as string;

export type LaunchElectronOptions = {
  spawnCore?: boolean;
  tray?: boolean;
};

function electronEnv(options: LaunchElectronOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'YAQMC_DESKTOP_SMOKE') {
      env[key] = value;
    }
  }
  env.YAQMC_ELECTRON_E2E = '1';
  env.YAQMC_VITE_DEV = '1';
  env.ELECTRON_DISABLE_GPU = '1';
  if (options.spawnCore) {
    const bin = resolveE2eCoreBin();
    if (!bin) {
      throw new Error('yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');
    }
    env.YAQMC_E2E_CORE = '1';
    env.YAQMC_CORE_BIN = bin;
  }
  if (options.tray) {
    env.YAQMC_E2E_TRAY = '1';
  }
  return env;
}

export function resolveE2eCoreBin(): string | undefined {
  const name = process.platform === 'win32' ? 'yaqmc-core.exe' : 'yaqmc-core';
  const cargo = process.env.CARGO_TARGET_DIR;
  const candidates = [
    process.env.YAQMC_CORE_BIN,
    cargo ? path.join(cargo, 'debug', name) : undefined,
    cargo ? path.join(cargo, 'release', name) : undefined,
    path.join(repoRoot, 'target', 'debug', name),
    path.join(repoRoot, 'target', 'release', name),
  ];
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate)),
  );
}

export async function e2eCoreStatus(app: ElectronApplication): Promise<string> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { coreStatus?: () => string } }).__YAQMC_E2E__;
    return hooks?.coreStatus?.() ?? 'absent';
  });
}

export async function e2eKillCore(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { killCore?: () => boolean } }).__YAQMC_E2E__;
    return hooks?.killCore?.() ?? false;
  });
}

export async function e2eTrayClick(app: ElectronApplication, id: string): Promise<boolean> {
  return app.evaluate((_electron, menuId) => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { trayClick?: (id: string) => boolean } })
      .__YAQMC_E2E__;
    return hooks?.trayClick?.(menuId) ?? false;
  }, id);
}

export async function e2eTrayActive(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { trayActive?: () => boolean } }).__YAQMC_E2E__;
    return hooks?.trayActive?.() ?? false;
  });
}

export async function e2eMainVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { mainVisible?: () => boolean } }).__YAQMC_E2E__;
    return hooks?.mainVisible?.() ?? false;
  });
}

export type E2eLyricsBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function e2eLyricsShow(app: ElectronApplication, kind: string): Promise<void> {
  await app.evaluate((_electron, surface) => {
    (
      globalThis as { __YAQMC_E2E__?: { lyricsShow?: (kind: string) => void } }
    ).__YAQMC_E2E__?.lyricsShow?.(surface);
  }, kind);
}

export async function e2eLyricsBounds(
  app: ElectronApplication,
  kind: string,
): Promise<E2eLyricsBounds | null> {
  const raw = await app.evaluate((_electron, surface) => {
    const hooks = (
      globalThis as { __YAQMC_E2E__?: { lyricsBounds?: (kind: string) => E2eLyricsBounds | null } }
    ).__YAQMC_E2E__;
    const bounds = hooks?.lyricsBounds?.(surface) ?? null;
    return bounds === null ? '' : JSON.stringify(bounds);
  }, kind);
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as E2eLyricsBounds;
}

export async function e2eLyricsSetBounds(
  app: ElectronApplication,
  kind: string,
  bounds: E2eLyricsBounds,
): Promise<boolean> {
  return app.evaluate(
    (_electron, payload) => {
      const hooks = (
        globalThis as {
          __YAQMC_E2E__?: {
            lyricsSetBounds?: (kind: string, bounds: E2eLyricsBounds) => boolean;
          };
        }
      ).__YAQMC_E2E__;
      return hooks?.lyricsSetBounds?.(payload.kind, payload.bounds) ?? false;
    },
    { kind, bounds },
  );
}

export async function e2eLyricsFlushGeometry(
  app: ElectronApplication,
  kind: string,
): Promise<void> {
  await app.evaluate((_electron, surface) => {
    return (
      globalThis as { __YAQMC_E2E__?: { lyricsFlushGeometry?: (kind: string) => Promise<void> } }
    ).__YAQMC_E2E__?.lyricsFlushGeometry?.(surface);
  }, kind);
}

export async function launchElectronFakeWindow(options: LaunchElectronOptions = {}): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await electron.launch({
    executablePath: electronBinary,
    args: ['.', '--lang=en-US'],
    cwd: desktopRoot,
    env: electronEnv(options),
    timeout: options.spawnCore ? 90_000 : 60_000,
    chromiumSandbox: true,
    locale: 'en-US',
  });
  const page = await app.firstWindow();
  await waitForFakeShell(page);
  await page.goto(`${VITE_DEV_ORIGIN}/?provider=fake`);
  await waitForFakeShell(page);
  return { app, page };
}
