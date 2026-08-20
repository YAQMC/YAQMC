/**
 * GPU-on Windows compositor probe against a real Electron process (dev:desktop
 * spawn, not Playwright `_electron` and not ELECTRON_DISABLE_GPU).
 *
 * Broader ACC-02 compositor probe. The UI-PERF multi-window matrix is:
 *   npm run perf:windows-gpu
 *   (scripts/migration/lyrics-multiwindow-gpu-profile.mjs)
 *
 * This file is not started by P12 while UI-PERF Windows Lyrics is FAIL-HUMAN.
 * Tracing is opt-in (`YAQMC_GPU_TRACE=1`). rAF sampling always has a wall-clock
 * timeout so a wedged CDP/rAF wait is a harness hang, not an unbounded wait.
 */
/* global document, window, performance */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanupQaSandbox, createQaSandbox, electronQaArgs, qaElectronEnv } from '../qa-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const electronBinary = createRequire(path.join(desktopRoot, 'package.json'))('electron');
const debugPort = Number(process.env.YAQMC_GPU_PROBE_PORT || 9231);
const collectTrace = process.env.YAQMC_GPU_TRACE === '1';

class ProbeTimeout extends Error {
  constructor(phase, timeoutMs) {
    super(`probe timeout after ${timeoutMs}ms during ${phase}`);
    this.name = 'ProbeTimeout';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
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
        if (Date.now() > deadline) {
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
    durationMs: 120_000,
    trackNumber: 1,
    isFavorite: false,
    quality: 'standard',
    availability: { status: 'available' },
  };
}

function lyricDocument(songId) {
  return {
    songId,
    syncMode: 'line',
    metadata: { sourceLabel: 'gpu-probe', offsetMs: 0 },
    vocalists: [],
    lines: Array.from({ length: 36 }, (_, index) => ({
      id: `l${String(index)}`,
      startMs: index * 1_200,
      endMs: (index + 1) * 1_200,
      text: `probe-line-${String(index)} ${'lyric '.repeat(8)}`,
      words: [],
    })),
  };
}

async function invoke(page, method, params) {
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
    12_000,
    `invoke:${method}`,
  );
}

async function probe(page, name, arg) {
  return withTimeout(
    page.evaluate(
      async ({ methodName, payload }) => {
        const api = globalThis.__YAQMC_PLAYBACK_UI_PROBE__;
        const method = api?.[methodName];
        if (typeof method !== 'function') throw new Error('playback UI probe is missing');
        return method(payload);
      },
      { methodName: name, payload: arg },
    ),
    16_000,
    `probe:${name}`,
  );
}

async function sampleRaf(page, durationMs = 1_000) {
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
      return {
        durationMs: elapsed,
        rafFrames: frames,
        rafFps: frames * (1_000 / elapsed),
        rafP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
        rafMaxMs: sorted[sorted.length - 1] ?? 0,
        wallClockTimedOut,
        rafStuck: wallClockTimedOut && frames < 3,
      };
    }, durationMs),
    durationMs + 4_000,
    `sampleRaf:${durationMs}`,
  );
}

async function traceWindow(page, durationMs) {
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
    await session.send('Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing',
    });
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const complete = new Promise((resolve) => {
      const timer = setTimeout(resolve, 4_000);
      session.once('Tracing.tracingComplete', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await session.send('Tracing.end');
    await complete;
  } catch (error) {
    return { error: String(error) };
  } finally {
    session.off('Tracing.dataCollected', onData);
  }
  const interesting = new Set([
    'Paint',
    'Layout',
    'UpdateLayoutTree',
    'PrePaint',
    'Layerize',
    'PaintImage',
    'RasterTask',
    'CompositeLayers',
    'FireAnimationFrame',
    'RunTask',
    'HitTest',
    'ScheduleStyleRecalculation',
    'UpdateLayer',
    'Commit',
  ]);
  const events = [...buckets.entries()]
    .filter(([name]) => interesting.has(name))
    .map(([name, stats]) => ({
      name,
      count: stats.count,
      maxMs: stats.maxUs / 1_000,
      sumMs: stats.sumUs / 1_000,
    }))
    .sort((left, right) => right.maxMs - left.maxMs);
  return { events };
}

async function maximize(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'maximized' },
    });
  } catch {
    await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => undefined);
  }
}

async function main() {
  const sandbox = createQaSandbox({ purpose: 'windows-gpu-perf-probe' });
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

  const child = spawn(
    electronBinary,
    electronQaArgs(sandbox, [
      `--remote-debugging-port=${String(debugPort)}`,
      '--lang=en-US',
      '--force-device-scale-factor=1.5',
      '--start-maximized',
    ]),
    {
      cwd: desktopRoot,
      env,
      stdio: 'inherit',
      windowsHide: false,
    },
  );
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  process.on('exit', stop);
  try {
    await waitForTcp('127.0.0.1', debugPort, 45_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(debugPort)}`);
    const page =
      browser.contexts().flatMap((context) => context.pages())[0] ??
      (await browser.contexts()[0]?.waitForEvent('page'));
    if (!page) throw new Error('no Electron page');
    await page.waitForSelector('.app-shell', { timeout: 60_000 });
    await page.waitForFunction(
      () => typeof globalThis.__YAQMC_PLAYBACK_UI_PROBE__?.sample === 'function',
      null,
      { timeout: 30_000 },
    );
    await maximize(page);

    const webgl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!gl) return { renderer: 'none', vendor: 'none' };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      };
    });

    const artworkSrc = await probe(page, 'makeArtwork');
    await probe(page, 'enableArtworkBackground');
    await probe(page, 'enableFpsOverlay');
    await invoke(page, 'player_pause').catch(() => undefined);
    const idle = await probe(page, 'sample', 1_000);
    process.stdout.write(`${JSON.stringify({ phase: 'idle', webgl, idle }, null, 2)}\n`);

    await invoke(page, 'player_play_tracks', {
      request: { tracks: [fixtureTrack('gpu-clock', artworkSrc)], shuffle: false },
    });
    await invoke(page, 'player_play');
    await page
      .waitForFunction(
        async () => {
          const snap = await globalThis.yaqmc.invoke('player_snapshot');
          return Boolean(snap?.isPlaying);
        },
        null,
        { timeout: 15_000 },
      )
      .catch(() => undefined);
    await page
      .waitForFunction(
        () =>
          document.querySelector('.app-background__image')?.getAttribute('data-preblurred') ===
          'true',
        null,
        { timeout: 8_000 },
      )
      .catch(() => undefined);

    const playingDefault = await probe(page, 'sample', 1_200);
    const playingTrace = collectTrace ? await traceWindow(page, 800) : null;
    process.stdout.write(
      `${JSON.stringify({ phase: 'playingDefault', webgl, playingDefault, playingTrace }, null, 2)}\n`,
    );
    const ab = {};
    for (const mode of ['no-backdrop', 'no-artwork-blur', 'no-filters', 'no-progress-raf']) {
      await probe(page, 'setCompositorProbe', mode);
      ab[mode] = await probe(page, 'sample', 1_000);
    }
    process.stdout.write(`${JSON.stringify({ phase: 'ab', ab }, null, 2)}\n`);
    await probe(page, 'setCompositorProbe', 'off');

    const progress = page.locator('.player-progress input[type="range"]');
    const box = await progress.boundingBox();
    const dragSample = probe(page, 'sample', 1_200);
    if (box) {
      await page.mouse.move(box.x + 24, box.y + box.height / 2);
      await page.mouse.down();
      for (let index = 0; index < 24; index += 1) {
        await page.mouse.move(box.x + 24 + (index % 12) * 18, box.y + box.height / 2);
      }
    }
    const seekDrag = await dragSample;
    await page.mouse.up();

    await invoke(page, 'player_set_lyrics', { document: lyricDocument('gpu-clock') });
    const lyricsOpenTrace = collectTrace ? traceWindow(page, 600) : Promise.resolve(null);
    const lyricsOpenTransition = await probe(page, 'sampleLyricsRouteTransition', 'open');
    await page.waitForSelector('.lyrics-stage', { timeout: 8_000 });
    const lyricsOpenTraceResult = await lyricsOpenTrace;
    const lyricsWindowed = await probe(page, 'sample', 1_000);
    const lyricsCloseTrace = collectTrace ? traceWindow(page, 600) : Promise.resolve(null);
    const lyricsCloseTransition = await probe(page, 'sampleLyricsRouteTransition', 'close');
    await page
      .waitForFunction(() => document.querySelector('.lyrics-stage') === null, null, {
        timeout: 8_000,
      })
      .catch(() => undefined);
    const lyricsCloseTraceResult = await lyricsCloseTrace;

    const lyricsRouteAb = {};
    for (const mode of ['no-enter-artwork', 'no-filters']) {
      await probe(page, 'setCompositorProbe', mode);
      lyricsRouteAb[mode] = {
        open: await probe(page, 'sampleLyricsRouteTransition', 'open'),
        close: await probe(page, 'sampleLyricsRouteTransition', 'close'),
      };
    }
    await probe(page, 'setCompositorProbe', 'off');

    await probe(page, 'sampleLyricsRouteTransition', 'open');
    await page.waitForSelector('.lyrics-stage', { timeout: 8_000 });
    await page.keyboard.press('F11');
    await page
      .waitForSelector('.lyrics-stage[data-fullscreen]', { timeout: 8_000 })
      .catch(() => undefined);
    const fullscreen = await probe(page, 'sample', 1_200);
    const fullscreenTrace = collectTrace ? await traceWindow(page, 800) : null;
    await probe(page, 'setCompositorProbe', 'no-line-blur');
    const fullscreenNoLineBlur = await probe(page, 'sample', 1_000);
    await probe(page, 'setCompositorProbe', 'no-filters');
    const fullscreenNoFilters = await probe(page, 'sample', 1_000);
    await probe(page, 'setCompositorProbe', 'off');
    await page.keyboard.press('Escape').catch(() => undefined);

    await probe(page, 'enableLyricsSurface', 'desktop');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const desktopPage = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes('surface=desktop'));
    const desktop = desktopPage ? await sampleRaf(desktopPage, 1_000) : { missing: true };
    await probe(page, 'enableLyricsSurface', 'island');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const islandPage = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes('surface=island'));
    const desktopAndIsland = islandPage
      ? {
          main: await probe(page, 'sample', 800),
          island: await sampleRaf(islandPage, 800),
          desktop: desktopPage ? await sampleRaf(desktopPage, 800) : desktop,
        }
      : { missing: true, desktop };

    const report = {
      probe: 'windows-gpu-on-cdp',
      gpuDisabledEnv: process.env.ELECTRON_DISABLE_GPU ?? null,
      webgl,
      idle,
      playingDefault,
      playingTrace,
      ab,
      seekDrag,
      lyricsOpenTransition,
      lyricsOpenTrace: lyricsOpenTraceResult,
      lyricsWindowed,
      lyricsCloseTransition,
      lyricsCloseTrace: lyricsCloseTraceResult,
      lyricsRouteAb,
      fullscreen,
      fullscreenTrace,
      fullscreenNoLineBlur,
      fullscreenNoFilters,
      desktop,
      desktopAndIsland,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await browser.close().catch(() => undefined);
    cleanupQaSandbox(sandbox.root);
  } finally {
    stop();
  }
}

await main();
