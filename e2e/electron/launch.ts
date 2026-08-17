import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  native?: boolean;
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
  if (options.native) {
    env.YAQMC_E2E_NATIVE = '1';
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

export type E2ePlayerSnapshotView = {
  queueLength: number;
  currentIndex: number | null;
  currentId: string | null;
  isPlaying: boolean;
  playbackState: string;
  snapshotRevision: number;
  errorCode: string | null;
};

export async function e2eOpenSettingsHits(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { openSettingsHits?: () => number } })
      .__YAQMC_E2E__;
    return hooks?.openSettingsHits?.() ?? 0;
  });
}

export async function e2eLastPlayerSnapshot(
  app: ElectronApplication,
): Promise<E2ePlayerSnapshotView | null> {
  const raw = await app.evaluate(() => {
    const hooks = (
      globalThis as {
        __YAQMC_E2E__?: { lastPlayerSnapshot?: () => E2ePlayerSnapshotView | null };
      }
    ).__YAQMC_E2E__;
    const view = hooks?.lastPlayerSnapshot?.() ?? null;
    return view === null ? '' : JSON.stringify(view);
  });
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as E2ePlayerSnapshotView;
}

export async function e2ePlayerSnapshotHits(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { playerSnapshotHits?: () => number } })
      .__YAQMC_E2E__;
    return hooks?.playerSnapshotHits?.() ?? 0;
  });
}

export async function e2eCoreInvoke(
  app: ElectronApplication,
  method: string,
  params?: unknown,
): Promise<unknown> {
  return app.evaluate(
    async (_electron, payload) => {
      const hooks = (
        globalThis as {
          __YAQMC_E2E__?: {
            coreInvoke?: (method: string, params?: unknown) => Promise<unknown>;
          };
        }
      ).__YAQMC_E2E__;
      if (!hooks?.coreInvoke) {
        throw new Error('coreInvoke hook missing');
      }
      const result = await hooks.coreInvoke(payload.method, payload.params);
      return result ?? null;
    },
    { method, params },
  );
}

/** Arm `window.yaqmc.on` in the renderer — the production preload IPC seam. */
export async function e2eArmOpenSettingsListener(page: Page): Promise<void> {
  await page.evaluate(() => {
    const yaqmc = Reflect.get(globalThis, 'yaqmc') as
      { on?: (channel: string, cb: (payload: unknown) => void) => void } | undefined;
    if (typeof yaqmc?.on !== 'function') {
      throw new Error('window.yaqmc.on is missing');
    }
    Reflect.set(globalThis, '__YAQMC_E2E_OPEN_SETTINGS__', false);
    yaqmc.on('app://open-settings', () => {
      Reflect.set(globalThis, '__YAQMC_E2E_OPEN_SETTINGS__', true);
    });
  });
}

export async function e2eOpenSettingsEventSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => Reflect.get(globalThis, '__YAQMC_E2E_OPEN_SETTINGS__') === true);
}

export async function e2eWaitForHostExit(
  app: ElectronApplication,
  timeoutMs: number,
): Promise<void> {
  const child = app.process();
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Electron host pid ${String(child.pid)} did not exit within ${String(timeoutMs)}ms`,
        ),
      );
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function e2eMainVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { mainVisible?: () => boolean } }).__YAQMC_E2E__;
    return hooks?.mainVisible?.() ?? false;
  });
}

export async function e2eMainHide(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { mainHide?: () => boolean } }).__YAQMC_E2E__;
    return hooks?.mainHide?.() ?? false;
  });
}

export async function e2eCorePid(app: ElectronApplication): Promise<number | null> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { corePid?: () => number | null } })
      .__YAQMC_E2E__;
    return hooks?.corePid?.() ?? null;
  });
}

export async function e2eCoreDataDir(app: ElectronApplication): Promise<string> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { coreDataDir?: () => string } }).__YAQMC_E2E__;
    return hooks?.coreDataDir?.() ?? '';
  });
}

export async function e2eHostPid(app: ElectronApplication): Promise<number | null> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { hostPid?: () => number } }).__YAQMC_E2E__;
    return hooks?.hostPid?.() ?? null;
  });
}

export async function e2eSecondInstanceHits(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => {
    const hooks = (globalThis as { __YAQMC_E2E__?: { secondInstanceHits?: () => number } })
      .__YAQMC_E2E__;
    return hooks?.secondInstanceHits?.() ?? 0;
  });
}

function parsePidFile(contents: string): number | undefined {
  const line = contents.trim().split(/\s+/u)[0];
  if (!line) {
    return undefined;
  }
  const pid = Number.parseInt(line, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  return pid;
}

/** Same image-name contract as `apps/desktop/main/core/pid.ts` `isCoreImageName`. */
export function e2eIsCoreImageName(name: string | undefined): boolean {
  if (!name) {
    return false;
  }
  const base = path.basename(name).toLowerCase();
  return base === 'yaqmc-core' || base === 'yaqmc-core.exe';
}

/** Same lookup as `apps/desktop/main/core/pid.ts` `lookupProcessImage`. */
export function e2eProcessImage(pid: number, platform = process.platform): string | undefined {
  if (platform === 'win32') {
    try {
      const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
      }).trim();
      if (!output.startsWith('"')) {
        return undefined;
      }
      const name = output.split(',')[0]?.replaceAll('"', '');
      return name || undefined;
    } catch {
      return undefined;
    }
  }
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function e2ePidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readCorePidFile(dataDir: string): number | undefined {
  const file = path.join(dataDir, 'core.pid');
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    return parsePidFile(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Last-resort cleanup for this test's recorded Core PID only.
 * Unrelated images (PID reuse) are left alone. Never `taskkill /IM`.
 */
export function e2eStopOwnedCorePid(pid: number): void {
  if (!e2eIsCoreImageName(e2eProcessImage(pid))) {
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

export async function e2eWaitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!e2ePidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return !e2ePidAlive(pid);
}

export type SpawnedSecondHost = {
  pid: number;
  waitForExit: (timeoutMs: number) => Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>;
  kill: () => void;
};

/**
 * Spawn a second real Electron host against the same e2e env/userData.
 * Do not use Playwright `_electron.launch` here: the loser quits before
 * `whenReady` and never opens a CDP window.
 */
export function spawnSecondElectronHost(options: LaunchElectronOptions = {}): SpawnedSecondHost {
  const env = electronEnv(options);
  if (env.YAQMC_ELECTRON_E2E !== '1') {
    throw new Error('second-launch E2E refused: YAQMC_ELECTRON_E2E must be 1');
  }
  const stderrChunks: Buffer[] = [];
  const child = spawn(electronBinary, ['.', '--lang=en-US'], {
    cwd: desktopRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('second Electron host spawned without a pid');
  }
  return {
    pid,
    waitForExit(timeoutMs) {
      return waitForChildExit(child, timeoutMs, stderrChunks);
    },
    kill() {
      killSpawnedHost(child);
    },
  };
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
  stderrChunks: Buffer[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stderrText = () => Buffer.concat(stderrChunks).toString('utf8');
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, stderr: stderrText() });
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        killSpawnedHost(child);
        const stderr = stderrText();
        const timeoutMsg =
          `second Electron host pid ${String(child.pid)} ` +
          `did not exit within ${String(timeoutMs)}ms`;
        reject(new Error(stderr ? `${timeoutMsg}\n${stderr}` : timeoutMsg));
      });
    }, timeoutMs);
    child.once('error', (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.once('exit', (code, signal) => {
      finish(() => {
        resolve({ code, signal, stderr: stderrText() });
      });
    });
  });
}

/** Kill only this spawned child (Windows: that PID's process tree). Never `/IM`. */
function killSpawnedHost(child: ChildProcess): void {
  if (child.exitCode !== null) {
    return;
  }
  const pid = child.pid;
  try {
    child.kill();
  } catch {
    // already gone
  }
  if (pid === undefined || process.platform !== 'win32') {
    return;
  }
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5_000,
      stdio: 'ignore',
    });
  } catch {
    // already gone
  }
}

export type E2eLyricsKind = 'desktop' | 'island';

export type E2eLyricsBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function e2eLyricsShow(app: ElectronApplication, kind: E2eLyricsKind): Promise<void> {
  await app.evaluate((_electron, surface) => {
    (
      globalThis as { __YAQMC_E2E__?: { lyricsShow?: (kind: E2eLyricsKind) => void } }
    ).__YAQMC_E2E__?.lyricsShow?.(surface);
  }, kind);
}

export async function e2eLyricsBounds(
  app: ElectronApplication,
  kind: E2eLyricsKind,
): Promise<E2eLyricsBounds | null> {
  const raw = await app.evaluate((_electron, surface) => {
    const hooks = (
      globalThis as {
        __YAQMC_E2E__?: { lyricsBounds?: (kind: E2eLyricsKind) => E2eLyricsBounds | null };
      }
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
  kind: E2eLyricsKind,
  bounds: E2eLyricsBounds,
): Promise<boolean> {
  return app.evaluate(
    (_electron, payload) => {
      const hooks = (
        globalThis as {
          __YAQMC_E2E__?: {
            lyricsSetBounds?: (kind: E2eLyricsKind, bounds: E2eLyricsBounds) => boolean;
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
  kind: E2eLyricsKind,
): Promise<void> {
  await app.evaluate((_electron, surface) => {
    return (
      globalThis as {
        __YAQMC_E2E__?: { lyricsFlushGeometry?: (kind: E2eLyricsKind) => Promise<void> };
      }
    ).__YAQMC_E2E__?.lyricsFlushGeometry?.(surface);
  }, kind);
}

/** Live Electron window URLs via Playwright's host seam — not an in-memory map. */
export function e2eBrowserWindowUrls(app: ElectronApplication): string[] {
  return app.windows().map((page) => page.url());
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

/** Production renderer (no `?provider=fake`). Does not wait for the fake shell. */
export async function launchElectronNativeWindow(
  options: Omit<LaunchElectronOptions, 'native'> = {},
): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await electron.launch({
    executablePath: electronBinary,
    args: ['.', '--lang=en-US'],
    cwd: desktopRoot,
    env: electronEnv({ ...options, native: true }),
    timeout: options.spawnCore ? 90_000 : 60_000,
    chromiumSandbox: true,
    locale: 'en-US',
  });
  const page = await app.firstWindow();
  return { app, page };
}
