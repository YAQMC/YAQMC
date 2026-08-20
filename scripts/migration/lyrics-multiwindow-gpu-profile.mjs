/**
 * GPU-on multi-window Fullscreen Lyrics matrix.
 *
 * HUMAN 2026-08-20: Fullscreen Lyrics is smooth alone and low-FPS when Desktop
 * Lyrics and/or Lyrics Island remain open. This probe measures each BrowserWindow
 * separately and never waits unbounded on CDP/rAF.
 *
 * Vite must already serve 127.0.0.1:1420; desktop main must be built.
 *
 *   $env:CARGO_TARGET_DIR='E:\cargo-target\yaqmc-electron-migration'
 *   $env:YAQMC_CORE_BIN="$env:CARGO_TARGET_DIR\debug\yaqmc-core.exe"
 *   npm run perf:windows-gpu
 */
/* global window, performance, requestAnimationFrame */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  cleanupQaSandbox,
  createQaSandbox,
  electronQaArgs,
  qaElectronEnv,
} from '../qa-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const electronBinary = createRequire(path.join(desktopRoot, 'package.json'))('electron');
const debugPort = Number(process.env.YAQMC_GPU_PROBE_PORT || 9231);
const enableTrace = process.env.YAQMC_GPU_TRACE === '1';
const pauseCycles = Number(process.env.YAQMC_PAUSE_CYCLES || 5);
const outputDir = path.join(repoRoot, 'output');
const reportPath = path.join(outputDir, 'lyrics-multiwindow-gpu-on.json');
const hangDumpPath = path.join(outputDir, 'lyrics-multiwindow-hang.json');

class ProbeTimeout extends Error {
  constructor(phase, timeoutMs) {
    super(`probe timeout after ${timeoutMs}ms during ${phase}`);
    this.name = 'ProbeTimeout';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, phase) {
  let timer;
  let settled = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (!settled) reject(new ProbeTimeout(phase, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    settled = true;
    clearTimeout(timer);
  }
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

function fixtureTrack(id, artworkSrc) {
  return {
    id,
    title: id,
    artists: [{ id: 'artist', name: 'Artist' }],
    album: { id: 'album', title: 'Album' },
    artwork: { src: artworkSrc, alt: 'Cover', dominantColor: '#334422' },
    durationMs: 180_000,
    trackNumber: 1,
    isFavorite: false,
    quality: 'standard',
    availability: { status: 'available' },
  };
}

function lyricDocument(songId) {
  return {
    songId,
    syncMode: 'word',
    metadata: { sourceLabel: 'gpu-multiwindow-probe', offsetMs: 0 },
    vocalists: [],
    lines: Array.from({ length: 48 }, (_, index) => ({
      id: `l${String(index)}`,
      startMs: index * 2_400,
      endMs: (index + 1) * 2_400,
      text: `probe-line-${String(index)} ${'lyric '.repeat(10)}`,
      words: Array.from({ length: 6 }, (__, wordIndex) => ({
        text: `w${String(wordIndex)}`,
        startMs: index * 2_400 + wordIndex * 400,
        endMs: index * 2_400 + (wordIndex + 1) * 400,
      })),
    })),
  };
}

function snapshotProcesses(rootPid) {
  try {
    const script = `
      $root = ${Number(rootPid)}
      Get-CimInstance Win32_Process |
        Where-Object {
          $_.ProcessId -eq $root -or
          $_.ParentProcessId -eq $root
        } |
        Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize, CommandLine, KernelModeTime, UserModeTime |
        ConvertTo-Json -Compress
    `;
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    const parsed = JSON.parse(raw || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({
      ...row,
      CommandLine:
        typeof row.CommandLine === 'string' ? row.CommandLine.slice(0, 240) : row.CommandLine,
      kind: /--type=gpu-process/.test(row.CommandLine ?? '')
        ? 'gpu'
        : /--type=renderer/.test(row.CommandLine ?? '')
          ? 'renderer'
          : row.Name === 'yaqmc-core.exe'
            ? 'core'
            : 'other',
    }));
  } catch (error) {
    return { error: String(error) };
  }
}

let currentPhase = 'boot';
const consoleLines = [];

function rememberConsole(entry) {
  consoleLines.push(entry);
  if (consoleLines.length > 80) consoleLines.shift();
}

async function invoke(page, method, params, timeoutMs = 12_000) {
  return withTimeout(
    page.evaluate(
      async ({ methodName, payload }) => {
        const yaqmc = globalThis.yaqmc;
        if (!yaqmc || typeof yaqmc.invoke !== 'function') {
          throw new Error('window.yaqmc.invoke is missing');
        }
        return yaqmc.invoke(methodName, payload);
      },
      { methodName: method, payload: params },
    ),
    timeoutMs,
    `invoke:${method}`,
  );
}

async function probe(page, name, arg, timeoutMs = 12_000) {
  return withTimeout(
    page.evaluate(
      async ({ methodName, payload }) => {
        const api = globalThis.__YAQMC_PLAYBACK_UI_PROBE__;
        const method = api?.[methodName];
        if (typeof method !== 'function')
          throw new Error(`playback UI probe ${methodName} is missing`);
        return method(payload);
      },
      { methodName: name, payload: arg },
    ),
    timeoutMs,
    `probe:${name}`,
  );
}

async function sampleRaf(page, durationMs) {
  return withTimeout(
    page.evaluate(async (ms) => {
      const frameTimes = [];
      const started = performance.now();
      let previous = null;
      let frames = 0;
      let wallClockTimedOut = false;
      await new Promise((resolve) => {
        let settled = false;
        const finish = (timedOut) => {
          if (settled) return;
          settled = true;
          wallClockTimedOut = timedOut;
          resolve();
        };
        const wall = setTimeout(() => finish(true), ms + 250);
        const tick = (now) => {
          if (settled) return;
          frames += 1;
          if (previous !== null) frameTimes.push(now - previous);
          previous = now;
          if (now - started >= ms) {
            clearTimeout(wall);
            finish(false);
            return;
          }
          window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
      });
      const elapsed = Math.max(1, performance.now() - started);
      const sorted = [...frameTimes].sort((left, right) => left - right);
      const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      return {
        durationMs: elapsed,
        rafFrames: frames,
        rafFps: frames * (1_000 / elapsed),
        rafP50Ms: at(0.5),
        rafP95Ms: at(0.95),
        rafMaxMs: sorted[sorted.length - 1] ?? 0,
        wallClockTimedOut,
        rafStuck: wallClockTimedOut && frames < 3,
        longTasks:
          performance.getEntriesByType?.('longtask')?.filter((entry) => entry.duration >= 50)
            .length ?? -1,
        href: location.href,
        visualActive: document.visibilityState !== 'hidden',
        probePhase: document.documentElement.dataset.probePhase ?? '',
      };
    }, durationMs),
    durationMs + 4_000,
    `sampleRaf:${durationMs}`,
  );
}

function pageByUrl(browser, fragment) {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate && !candidate.isClosed() && candidate.url().includes(fragment));
}

async function waitForSurfacePage(browser, fragment, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = pageByUrl(browser, fragment);
    if (found) {
      await withTimeout(
        found.waitForFunction(
          () => typeof globalThis.__YAQMC_PLAYBACK_UI_PROBE__?.sample === 'function',
          null,
          { timeout: 4_000 },
        ),
        4_500,
        `waitSurfaceProbe:${fragment}`,
      ).catch(() => undefined);
      return found;
    }
    await sleep(80);
  }
  return undefined;
}

function gpuProcesses(snapshot) {
  if (!Array.isArray(snapshot)) return { error: snapshot?.error ?? 'unavailable' };
  return snapshot
    .filter((row) => row.kind === 'gpu')
    .map((row) => ({
      pid: row.ProcessId,
      workingSetMiB: Number(row.WorkingSetSize) / (1024 * 1024),
      cpu100ns: Number(row.KernelModeTime) + Number(row.UserModeTime),
    }));
}

async function captureHang(page, child, cause) {
  const dump = {
    probe: 'lyrics-multiwindow-gpu-on-hang',
    at: new Date().toISOString(),
    phase: currentPhase,
    cause:
      cause instanceof Error
        ? { name: cause.name, message: cause.message, phase: cause.phase }
        : String(cause),
    rendererResponsive: false,
    hangClass: 'unknown',
    processes: snapshotProcesses(child?.pid),
    console: consoleLines.slice(-40),
  };
  if (!page) {
    dump.hangClass = 'perf harness hang';
    dump.rendererPing = { error: 'no page' };
  } else {
    try {
      dump.rendererPing = await withTimeout(
        page.evaluate(() => ({
          at: Date.now(),
          href: location.href,
          vis: document.visibilityState,
        })),
        2_500,
        'hang:rendererPing',
      );
      dump.rendererResponsive = true;
      dump.rafPing = await withTimeout(
        page.evaluate(
          () =>
            new Promise((resolve) => {
              const wall = setTimeout(() => resolve({ progressed: false }), 200);
              requestAnimationFrame(() => {
                clearTimeout(wall);
                resolve({ progressed: true });
              });
            }),
        ),
        2_500,
        'hang:rafPing',
      );
      dump.hangClass =
        dump.rafPing?.progressed === false ? 'application hang' : 'perf harness hang';
    } catch (error) {
      dump.rendererPing = { error: String(error) };
      dump.hangClass = 'application hang';
    }
  }
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(hangDumpPath, `${JSON.stringify(dump, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ phase: 'hang', dump }, null, 2)}\n`);
  return dump;
}

async function waitPlaying(page) {
  await withTimeout(
    page.waitForFunction(
      async () => {
        const snap = await globalThis.yaqmc.invoke('player_snapshot');
        return Boolean(snap?.isPlaying);
      },
      null,
      { timeout: 12_000 },
    ),
    13_000,
    'waitPlaying',
  );
}

async function openFullscreen(page) {
  currentPhase = 'enter';
  await probe(page, 'openLyrics');
  await withTimeout(page.waitForSelector('.lyrics-stage', { timeout: 8_000 }), 9_000, 'waitStage');
  await page.keyboard.press('F11');
  await withTimeout(
    page.waitForSelector('.lyrics-stage[data-fullscreen]', { timeout: 8_000 }),
    9_000,
    'waitFullscreen',
  ).catch(() => undefined);
  await sleep(400);
}

async function closeFullscreen(page) {
  currentPhase = 'exit';
  await page.keyboard.press('Escape').catch(() => undefined);
  await probe(page, 'closeLyrics');
  await withTimeout(
    page.waitForFunction(() => document.querySelector('.lyrics-stage') === null, null, {
      timeout: 8_000,
    }),
    9_000,
    'waitStageGone',
  ).catch(() => undefined);
}

async function setSurfaces(page, browser, enabled) {
  if (enabled.desktop) await probe(page, 'enableLyricsSurface', 'desktop');
  else await probe(page, 'disableLyricsSurface', 'desktop');
  if (enabled.island) await probe(page, 'enableLyricsSurface', 'island');
  else await probe(page, 'disableLyricsSurface', 'island');
  return {
    desktop: enabled.desktop ? await waitForSurfacePage(browser, 'surface=desktop') : undefined,
    island: enabled.island ? await waitForSurfacePage(browser, 'surface=island') : undefined,
  };
}

function summarize(sample) {
  if (!sample || typeof sample !== 'object') return sample;
  return {
    rafFps: sample.rafFps,
    rafP50Ms: sample.rafP50Ms,
    rafP95Ms: sample.rafP95Ms,
    rafMaxMs: sample.rafMaxMs,
    rafFrames: sample.rafFrames,
    longTasks: sample.longTasks,
    wallClockTimedOut: sample.wallClockTimedOut,
    rafStuck: sample.rafStuck,
    visualActive: sample.visualActive ?? sample.visibilityState !== 'hidden',
    visibilityState: sample.visibilityState,
    lyricsMutations: sample.lyricsMutations,
    storeHz: sample.storeHz,
    surfaceCommits: sample.surfaceCommits,
    backgroundThrottled: sample.backgroundThrottled,
  };
}

async function sampleOverlay(page) {
  if (!page || page.isClosed()) return { missing: true };
  try {
    const sample = await probe(page, 'sample', 900, 5_000);
    if (sample?.wallClockTimedOut && sample.rafFrames < 3) {
      sample.backgroundThrottled = true;
      sample.rafStuck = false;
    }
    return summarize(sample);
  } catch {
    return summarize(await sampleRaf(page, 900));
  }
}

async function sampleWindows(mainPage, surfaces, label, child) {
  currentPhase = label;
  const gpuBefore = gpuProcesses(snapshotProcesses(child?.pid));
  const started = Date.now();
  const main = await probe(mainPage, 'sample', 1_000, 6_000);
  const desktop = surfaces.desktop ? await sampleOverlay(surfaces.desktop) : { missing: true };
  const island = surfaces.island ? await sampleOverlay(surfaces.island) : { missing: true };
  const inspect = await probe(mainPage, 'inspectHang', undefined, 4_000).catch((error) => ({
    error: String(error),
  }));
  const gpuAfter = gpuProcesses(snapshotProcesses(child?.pid));
  const row = {
    label,
    main: summarize(main),
    desktop,
    island,
    inspect: {
      panelCommits: inspect?.panelCommits,
      lastPanelCommitAgeMs: inspect?.lastPanelCommitAgeMs,
      longTasks: inspect?.longTasks,
      lyricsStage: inspect?.lyricsStage,
      error: inspect?.error,
    },
    gpu: { before: gpuBefore, after: gpuAfter, elapsedMs: Date.now() - started },
  };
  process.stdout.write(`${JSON.stringify({ phase: 'matrix', row }, null, 2)}\n`);
  return row;
}

async function setOverlayProbe(surfaces, mode) {
  for (const page of [surfaces.desktop, surfaces.island]) {
    if (!page || page.isClosed()) continue;
    await page.evaluate((next) => {
      if (!next) delete document.documentElement.dataset.compositorProbe;
      else document.documentElement.dataset.compositorProbe = next;
    }, mode);
  }
}

async function paintOverlayOpaque(surfaces, opaque) {
  for (const page of [surfaces.desktop, surfaces.island]) {
    if (!page || page.isClosed()) continue;
    await page.evaluate((on) => {
      document.documentElement.style.background = on ? '#12130f' : '';
      document.body.style.background = on ? '#12130f' : '';
    }, opaque);
  }
}

async function setSurfaceLock(page, kind, interaction) {
  const raw = await invoke(page, 'app_preferences_get');
  await invoke(page, 'lyrics_surface_set_interaction', {
    kind,
    interaction,
    value: typeof raw === 'string' && raw.length > 0 ? raw : '{}',
  });
}

async function traceInteresting(page, durationMs) {
  if (!enableTrace) return { skipped: true };
  const session = await page.context().newCDPSession(page);
  const buckets = new Map();
  const onData = (payload) => {
    for (const event of payload.value ?? []) {
      const name = typeof event.name === 'string' ? event.name : '';
      if (!name) continue;
      const duration = Number(event.dur ?? 0);
      const current = buckets.get(name) ?? { count: 0, maxUs: 0, sumUs: 0 };
      current.count += 1;
      current.maxUs = Math.max(current.maxUs, duration);
      current.sumUs += duration;
      buckets.set(name, current);
    }
  };
  session.on('Tracing.dataCollected', onData);
  try {
    await withTimeout(
      session.send('Tracing.start', {
        categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing',
      }),
      4_000,
      'Tracing.start',
    );
    await sleep(durationMs);
    const complete = withTimeout(
      new Promise((resolve) => session.once('Tracing.tracingComplete', () => resolve())),
      4_000,
      'Tracing.tracingComplete',
    ).catch(() => undefined);
    await session.send('Tracing.end').catch(() => undefined);
    await complete;
  } catch (error) {
    return { error: String(error) };
  } finally {
    session.off('Tracing.dataCollected', onData);
  }
  const interesting = new Set([
    'Paint',
    'RasterTask',
    'CompositeLayers',
    'FireAnimationFrame',
    'Commit',
  ]);
  return [...buckets.entries()]
    .filter(([name]) => interesting.has(name))
    .map(([name, stats]) => ({
      name,
      count: stats.count,
      maxMs: stats.maxUs / 1_000,
      sumMs: stats.sumUs / 1_000,
    }))
    .sort((left, right) => right.sumMs - left.sumMs);
}

async function main() {
  const sandbox = createQaSandbox({ purpose: 'windows-gpu-multiwindow' });
  const env = qaElectronEnv(process.env, sandbox, {
    YAQMC_VITE_DEV: '1',
    YAQMC_E2E_NATIVE: '1',
    YAQMC_ELECTRON_E2E: '1',
    YAQMC_E2E_CORE: '1',
  });
  delete env.ELECTRON_DISABLE_GPU;
  delete env.YAQMC_DESKTOP_SMOKE;
  if (!env.YAQMC_CORE_BIN && env.CARGO_TARGET_DIR) {
    env.YAQMC_CORE_BIN = path.join(env.CARGO_TARGET_DIR, 'debug', 'yaqmc-core.exe');
  }

  await waitForTcp('127.0.0.1', 1420, 5_000).catch(() => {
    throw new Error('Vite is not serving 127.0.0.1:1420; start npm run dev first');
  });
  await fs.mkdir(outputDir, { recursive: true });

  const child = spawn(
    electronBinary,
    electronQaArgs(sandbox, [
      `--remote-debugging-port=${String(debugPort)}`,
      '--lang=en-US',
      '--force-device-scale-factor=1.5',
      '--start-maximized',
    ]),
    { cwd: desktopRoot, env, stdio: 'inherit', windowsHide: false },
  );
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  process.on('exit', stop);
  const deadlineMs = Number(process.env.YAQMC_PROBE_DEADLINE_MS || 10 * 60 * 1_000);
  const deadlineTimer = setTimeout(() => {
    currentPhase = 'deadline';
    stop();
    process.stderr.write(`probe deadline after ${deadlineMs}ms\n`);
    process.exit(2);
  }, deadlineMs);
  deadlineTimer.unref?.();
  let page = null;

  try {
    await waitForTcp('127.0.0.1', debugPort, 45_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(debugPort)}`);
    page =
      browser.contexts().flatMap((context) => context.pages())[0] ??
      (await browser.contexts()[0]?.waitForEvent('page'));
    if (!page) throw new Error('no Electron page');
    page.setDefaultTimeout(12_000);
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        rememberConsole({ type: message.type(), text: message.text() });
      }
    });
    page.on('pageerror', (error) => rememberConsole({ type: 'pageerror', text: String(error) }));
    await withTimeout(
      page.waitForSelector('.app-shell', { timeout: 60_000 }),
      61_000,
      'waitAppShell',
    );
    await withTimeout(
      page.waitForFunction(
        () => typeof globalThis.__YAQMC_PLAYBACK_UI_PROBE__?.sample === 'function',
        null,
        {
          timeout: 30_000,
        },
      ),
      31_000,
      'waitProbe',
    );

    const webgl = await withTimeout(
      page.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        if (!gl) return { renderer: 'none', vendor: 'none' };
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          renderer: ext
            ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER),
          vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        };
      }),
      5_000,
      'webgl',
    );

    const artworkSrc = await probe(page, 'makeArtwork');
    await probe(page, 'enableArtworkBackground');
    await probe(page, 'enableFpsOverlay');
    await invoke(page, 'player_play_tracks', {
      request: { tracks: [fixtureTrack('lyrics-multiwindow', artworkSrc)], shuffle: false },
    });
    await invoke(page, 'player_play');
    await waitPlaying(page);
    await invoke(page, 'player_set_lyrics', { document: lyricDocument('lyrics-multiwindow') });

    const enterOnly = await probe(page, 'sample', 500, 5_000).catch(() => null);
    await openFullscreen(page);
    const matrix = {};
    matrix.fullscreenOnly = await sampleWindows(
      page,
      { desktop: undefined, island: undefined },
      'fullscreen-only',
      child,
    );
    matrix.fullscreenOnly.trace = await traceInteresting(page, 700);

    let surfaces = await setSurfaces(page, browser, { desktop: true, island: false });
    matrix.fullscreenDesktop = await sampleWindows(page, surfaces, 'fullscreen+desktop', child);

    surfaces = await setSurfaces(page, browser, { desktop: false, island: true });
    matrix.fullscreenIsland = await sampleWindows(page, surfaces, 'fullscreen+island', child);

    surfaces = await setSurfaces(page, browser, { desktop: true, island: true });
    matrix.fullscreenBoth = await sampleWindows(page, surfaces, 'fullscreen+desktop+island', child);
    matrix.fullscreenBoth.trace = await traceInteresting(page, 700);

    const isolation = {};
    surfaces = await setSurfaces(page, browser, { desktop: true, island: false });
    isolation.desktopVisible = await sampleWindows(page, surfaces, 'iso:desktop-visible', child);
    await invoke(page, 'lyrics_surface_close', { kind: 'desktop' });
    await sleep(400);
    isolation.desktopHiddenAlive = await sampleWindows(
      page,
      { desktop: pageByUrl(browser, 'surface=desktop'), island: undefined },
      'iso:desktop-hidden',
      child,
    );
    const hiddenDesktop = pageByUrl(browser, 'surface=desktop');
    if (hiddenDesktop) await hiddenDesktop.close().catch(() => undefined);
    await sleep(400);
    isolation.desktopDestroyed = await sampleWindows(
      page,
      { desktop: undefined, island: undefined },
      'iso:desktop-destroyed',
      child,
    );
    surfaces = await setSurfaces(page, browser, { desktop: true, island: false });
    await setSurfaceLock(page, 'desktop', 'passive-locked').catch(() => undefined);
    await sleep(300);
    isolation.desktopLocked = await sampleWindows(
      page,
      { desktop: pageByUrl(browser, 'surface=desktop'), island: undefined },
      'iso:desktop-locked',
      child,
    );
    await setSurfaceLock(page, 'desktop', 'interactive').catch(() => undefined);

    surfaces = await setSurfaces(page, browser, { desktop: false, island: true });
    isolation.islandVisible = await sampleWindows(page, surfaces, 'iso:island-visible', child);
    await invoke(page, 'lyrics_surface_close', { kind: 'island' });
    await sleep(400);
    isolation.islandHiddenAlive = await sampleWindows(
      page,
      { desktop: undefined, island: pageByUrl(browser, 'surface=island') },
      'iso:island-hidden',
      child,
    );

    const animationAb = {};
    surfaces = await setSurfaces(page, browser, { desktop: true, island: true });
    for (const mode of [
      'no-surface-anim',
      'no-island-expand',
      'no-surface-artwork',
      'no-backdrop',
    ]) {
      await setOverlayProbe(surfaces, mode);
      animationAb[mode] = await sampleWindows(page, surfaces, `ab:${mode}`, child);
    }
    await setOverlayProbe(surfaces, '');
    await paintOverlayOpaque(surfaces, true);
    animationAb['opaque-html'] = await sampleWindows(page, surfaces, 'ab:opaque-html', child);
    await paintOverlayOpaque(surfaces, false);

    surfaces = await setSurfaces(page, browser, { desktop: true, island: true });
    const pauseRuns = [];
    for (let index = 0; index < pauseCycles; index += 1) {
      currentPhase = `pause#${index + 1}`;
      await invoke(page, 'player_play').catch(() => undefined);
      await waitPlaying(page);
      await sleep(200);
      const playing = await probe(page, 'sample', 700, 5_000);
      await invoke(page, 'player_pause');
      await sleep(200);
      const paused = await probe(page, 'sample', 800, 5_000);
      await invoke(page, 'player_play');
      await waitPlaying(page);
      const resumed = await probe(page, 'sample', 700, 5_000);
      pauseRuns.push({
        playingFps: playing.rafFps,
        pausedFps: paused.rafFps,
        resumedFps: resumed.rafFps,
        pausedP95: paused.rafP95Ms,
        rafStuck: Boolean(playing.rafStuck || paused.rafStuck || resumed.rafStuck),
      });
    }

    const exitBoth = await (async () => {
      const sampling = probe(page, 'sample', 600, 5_000);
      await closeFullscreen(page);
      return summarize(await sampling);
    })();

    const report = {
      probe: 'lyrics-multiwindow-gpu-on',
      gpuDisabledEnv: process.env.ELECTRON_DISABLE_GPU ?? null,
      tracing: enableTrace,
      windowFlags: {
        transparent: true,
        frame: false,
        alwaysOnTop: 'screen-saver',
        hasShadow: false,
        show: false,
        skipTaskbar: true,
        backgroundColor: '#00000000',
        backgroundThrottlingCreate: false,
        backgroundThrottlingWhenHidden: true,
        lock: 'setIgnoreMouseEvents(true) without { forward: true }',
      },
      webgl,
      enterOnly: enterOnly ? summarize(enterOnly) : null,
      matrix,
      isolation,
      animationAb,
      pauseRuns,
      exitBoth,
      processes: snapshotProcesses(child.pid),
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await browser.close().catch(() => undefined);
    cleanupQaSandbox(sandbox.root);
  } catch (error) {
    try {
      await captureHang(page, child, error);
    } catch {
      process.stdout.write(`${JSON.stringify({ phase: 'fatal', error: String(error) })}\n`);
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    stop();
  }
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
}
