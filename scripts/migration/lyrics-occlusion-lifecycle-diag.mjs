/**
 * Real-app (no CDP) Fullscreen Lyrics lifecycle A/B.
 *
 * HUMAN 2026-08-20: Fullscreen Lyrics is smooth alone and ~4 FPS when Desktop
 * Lyrics or Lyrics Island stay open. CDP `perf:windows-gpu` reported ~230 FPS
 * for the same matrix and is not this path — DevTools attachment suppresses
 * Chromium occluded-window backgrounding.
 *
 * Vite must already serve 127.0.0.1:1420; this script rebuilds desktop main.
 *
 *   $env:CARGO_TARGET_DIR='E:\cargo-target\yaqmc-electron-migration'
 *   $env:YAQMC_CORE_BIN="$env:CARGO_TARGET_DIR\debug\yaqmc-core.exe"
 *   node scripts/migration/lyrics-occlusion-lifecycle-diag.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronDevEnv } from '../dev-desktop.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const electronBinary = createRequire(path.join(desktopRoot, 'package.json'))('electron');
const outputDir = path.join(repoRoot, 'output');
const reportPath = path.join(outputDir, 'lyrics-occlusion-lifecycle.json');
const variants = (process.env.YAQMC_UI_PERF_DIAG_VARIANTS || 'off,on')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTcp(host, port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      const raw = await fs.readFile(filePath, 'utf8');
      if (raw.includes('"cause"')) return JSON.parse(raw);
    } catch {
      // still writing
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function summarizeVariant(report) {
  const slice = (label) => {
    const step = (report.steps ?? []).find((row) => row.label === label);
    if (!step) return null;
    return {
      rafFps: step.mainSample?.rafFps ?? null,
      rafP95Ms: step.mainSample?.rafP95Ms ?? null,
      ipcSnapshotHz: step.mainSample?.ipcSnapshotHz ?? null,
      storeHz: step.mainSample?.storeHz ?? null,
      panelCommits: step.mainSample?.panelCommits ?? null,
      hidden: step.mainRenderer?.hidden ?? step.mainSample?.hidden ?? null,
      visibilityState: step.mainRenderer?.visibilityState ?? null,
      visualIdle: step.mainSample?.visualIdle ?? null,
      surfaceVisual: step.mainRenderer?.surfaceVisual || step.mainSample?.surfaceVisual || '',
      focused: step.mainHost?.focused ?? null,
      backgroundThrottling: step.mainHost?.backgroundThrottling ?? null,
      bounds: (step.windows ?? []).map((window) => ({
        role: window.role,
        visible: window.visible,
        bounds: window.bounds,
        contentBounds: window.contentBounds,
        painted: window.painted,
        webContentsId: window.webContentsId,
        browserWindowId: window.browserWindowId,
        alwaysOnTop: window.alwaysOnTop,
      })),
    };
  };
  return {
    variant: report.variant,
    switches: report.switches,
    cause: report.cause,
    A: slice('A-fullscreen-only'),
    B: slice('B-desktop-open'),
    B2: slice('B2-desktop-open-main-throttling-true'),
    B3: slice('B3-desktop-open-main-throttling-false'),
    B4: slice('B4-desktop-open-main-refocus'),
    C: slice('C-desktop-closed'),
    D: slice('D-island-open'),
    E: slice('E-both-open'),
  };
}

async function runVariant(mode) {
  const userData = path.join(os.tmpdir(), `yaqmc-ui-perf-diag-${mode}`);
  const variantOut = path.join(outputDir, `lyrics-occlusion-lifecycle-${mode}.json`);
  await fs.rm(variantOut, { force: true });
  await fs.rm(userData, { recursive: true, force: true });

  const env = electronDevEnv({
    ...process.env,
    YAQMC_UI_PERF_DIAG: '1',
    YAQMC_UI_PERF_DIAG_QUIT: '1',
    YAQMC_UI_PERF_DIAG_OUT: variantOut,
    YAQMC_WINDOWS_OCCLUSION: mode,
  });
  delete env.ELECTRON_DISABLE_GPU;
  delete env.YAQMC_DESKTOP_SMOKE;
  delete env.YAQMC_ELECTRON_E2E;
  delete env.YAQMC_E2E_NATIVE;
  if (!env.YAQMC_CORE_BIN && env.CARGO_TARGET_DIR) {
    env.YAQMC_CORE_BIN = path.join(env.CARGO_TARGET_DIR, 'debug', 'yaqmc-core.exe');
  }

  const child = spawn(
    electronBinary,
    ['.', `--user-data-dir=${userData}`, '--lang=en-US'],
    { cwd: desktopRoot, env, stdio: 'inherit', windowsHide: false },
  );
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  process.on('exit', stop);
  try {
    const report = await waitForFile(variantOut, Number(process.env.YAQMC_UI_PERF_DIAG_TIMEOUT_MS || 180_000));
    stop();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(5_000).then(stop),
    ]);
    return report;
  } catch (error) {
    stop();
    throw error;
  } finally {
    process.off('exit', stop);
  }
}

async function main() {
  await waitForTcp('127.0.0.1', 1420, 5_000).catch(() => {
    throw new Error('Vite is not serving 127.0.0.1:1420; start npm run dev first');
  });
  const build = spawnSync(process.execPath, [path.join(desktopRoot, 'scripts', 'build.mjs')], {
    cwd: desktopRoot,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
  await fs.mkdir(outputDir, { recursive: true });

  const variantsOut = {};
  for (const mode of variants) {
    process.stdout.write(`\n=== ui-perf-diag variant=${mode} (no CDP) ===\n`);
    const report = await runVariant(mode);
    variantsOut[mode] = { rawCause: report.cause, summary: summarizeVariant(report) };
    process.stdout.write(`${JSON.stringify(variantsOut[mode].summary, null, 2)}\n`);
  }

  const combined = {
    at: new Date().toISOString(),
    note: 'No CDP / no remote-debugging-port. Isolated userData. Not a substitute for HUMAN FPS.',
    variants: variantsOut,
  };
  await fs.writeFile(reportPath, `${JSON.stringify(combined, null, 2)}\n`);
  process.stdout.write(`\nwrote ${reportPath}\n`);
}

await main();
