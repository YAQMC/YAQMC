/**
 * GPU-on Windows profile of Fullscreen Lyrics Pause FPS.
 *
 * Playwright `_electron` + ELECTRON_DISABLE_GPU is not evidence for this defect.
 *
 * Every CDP/rAF/evaluate wait is wall-clock bounded. A Pause A/B hang dumps
 * evidence to output/lyrics-pause-hang.json and kills that Electron instead of
 * waiting indefinitely. Renderer-alive + rAF-alive timeouts are classified as
 * a perf harness hang; CDP-dead or rAF-dead timeouts are application hangs.
 *
 * Vite must already serve 127.0.0.1:1420; desktop main must be built.
 *
 *   $env:CARGO_TARGET_DIR='E:\cargo-target\yaqmc-electron-migration'
 *   $env:YAQMC_CORE_BIN="$env:CARGO_TARGET_DIR\debug\yaqmc-core.exe"
 *   node scripts/migration/lyrics-pause-gpu-profile.mjs
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
const debugPort = Number(process.env.YAQMC_GPU_PROBE_PORT || 9235);
const cycles = Number(process.env.YAQMC_PAUSE_CYCLES || 8);
const extraVinylCycles = Number(process.env.YAQMC_VINYL_EXTRA_CYCLES || 10);
const jankFps = Number(process.env.YAQMC_JANK_FPS || 20);
const jankP95 = Number(process.env.YAQMC_JANK_P95_MS || 50);
const enableTrace = process.env.YAQMC_GPU_TRACE === '1';
const outputDir = path.join(repoRoot, 'output');
const hangDumpPath = path.join(outputDir, 'lyrics-pause-hang.json');
const reportPath = path.join(outputDir, 'lyrics-pause-gpu-on.json');

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
    metadata: { sourceLabel: 'gpu-pause-probe', offsetMs: 0 },
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
          $_.ParentProcessId -eq $root -or
          $_.Name -match 'electron|yaqmc-core'
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
      kind: /\b--type=gpu-process\b/.test(row.CommandLine ?? '')
        ? 'gpu'
        : /\b--type=renderer\b/.test(row.CommandLine ?? '')
          ? 'renderer'
          : /\b--type=/.test(row.CommandLine ?? '')
            ? 'utility'
            : row.Name === 'yaqmc-core.exe'
              ? 'core'
              : 'main',
    }));
  } catch (error) {
    return { error: String(error) };
  }
}

function cpuDelta(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second)) return second;
  return second.map((row) => {
    const previous = first.find((item) => item.ProcessId === row.ProcessId);
    const nowTicks = Number(row.KernelModeTime ?? 0) + Number(row.UserModeTime ?? 0);
    const prevTicks = Number(previous?.KernelModeTime ?? 0) + Number(previous?.UserModeTime ?? 0);
    return { ...row, cpu100nsDelta: nowTicks - prevTicks };
  });
}

function waitForPortFree(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.end();
        if (Date.now() >= deadline) {
          reject(new Error(`port ${port} stayed occupied`));
          return;
        }
        setTimeout(attempt, 200);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve();
      });
    };
    attempt();
  });
}

function isJank(sample) {
  if (!sample || typeof sample !== 'object') return true;
  if (sample.rafStuck || sample.wallClockTimedOut) return true;
  return sample.rafFps < jankFps || sample.rafP95Ms > jankP95 || sample.rafMaxMs > 80;
}

function summarizeSample(sample) {
  if (!sample || typeof sample !== 'object') return sample;
  return {
    rafFps: sample.rafFps,
    rafP50Ms: sample.rafP50Ms,
    rafP95Ms: sample.rafP95Ms,
    rafMaxMs: sample.rafMaxMs,
    rafFrames: sample.rafFrames,
    longTasks: sample.longTasks,
    storeUpdates: sample.storeUpdates,
    storeHz: sample.storeHz,
    positionHz: sample.positionHz,
    ipcSnapshotHz: sample.ipcSnapshotHz,
    lyricsMutations: sample.lyricsMutations,
    lyricsMutationHz: sample.lyricsMutationHz,
    playerBarMutationHz: sample.playerBarMutationHz,
    rafStuck: sample.rafStuck ?? false,
    wallClockTimedOut: sample.wallClockTimedOut ?? false,
    lyrics: sample.lyrics,
  };
}

const consoleLines = [];
let currentPhase = 'boot';

function rememberConsole(entry) {
  consoleLines.push(entry);
  if (consoleLines.length > 80) consoleLines.shift();
}

async function setPhase(page, phase) {
  currentPhase = phase;
  if (!page) return;
  await withTimeout(
    page.evaluate((next) => {
      document.documentElement.dataset.probePhase = next;
    }, phase),
    2_500,
    `setPhase:${phase}`,
  ).catch(() => undefined);
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
      };
    }, durationMs),
    durationMs + 4_000,
    `sampleRaf:${durationMs}`,
  );
}

async function pingRenderer(page) {
  return withTimeout(probe(page, 'ping', undefined, 2_500), 3_000, 'pingRenderer');
}

async function pingRaf(page) {
  return withTimeout(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const wall = setTimeout(() => resolve({ progressed: false }), 200);
          requestAnimationFrame(() => {
            clearTimeout(wall);
            resolve({ progressed: true, at: performance.now() });
          });
        }),
    ),
    2_500,
    'pingRaf',
  );
}

async function gpuTargets(page) {
  try {
    const session = await withTimeout(page.context().newCDPSession(page), 3_000, 'cdpSession');
    const result = await withTimeout(session.send('Target.getTargets'), 3_000, 'Target.getTargets');
    return (result.targetInfos ?? []).map((target) => ({
      type: target.type,
      url: target.url,
      title: target.title,
    }));
  } catch (error) {
    return { error: String(error) };
  }
}

async function captureHang(page, child, cause) {
  const firstProcesses = snapshotProcesses(child?.pid);
  await sleep(200);
  const dump = {
    probe: 'lyrics-pause-gpu-on-hang',
    at: new Date().toISOString(),
    phase: currentPhase,
    cause:
      cause instanceof Error
        ? { name: cause.name, message: cause.message, phase: cause.phase }
        : String(cause),
    rendererResponsive: false,
    rafProgressed: null,
    hangClass: 'unknown',
    hangKind: 'unknown',
    rendererPing: null,
    rafPing: null,
    inspectHang: null,
    gpuTargets: null,
    processes: cpuDelta(firstProcesses, snapshotProcesses(child?.pid)),
    console: consoleLines.slice(-50),
  };
  try {
    dump.rendererPing = await pingRenderer(page);
    dump.rendererResponsive = true;
  } catch (error) {
    dump.rendererPing = { error: String(error) };
  }
  if (dump.rendererResponsive) {
    try {
      dump.rafPing = await pingRaf(page);
      dump.rafProgressed = dump.rafPing?.progressed === true;
    } catch (error) {
      dump.rafPing = { error: String(error) };
      dump.rafProgressed = false;
    }
    try {
      dump.inspectHang = await probe(page, 'inspectHang', undefined, 4_000);
    } catch (error) {
      dump.inspectHang = { error: String(error) };
    }
    dump.gpuTargets = await gpuTargets(page);
  }

  if (!dump.rendererResponsive) {
    dump.hangClass = 'application hang';
    dump.hangKind = 'renderer-main-thread-or-cdp-unresponsive';
  } else if (dump.rafProgressed === false) {
    dump.hangClass = 'application hang';
    dump.hangKind = 'raf-or-compositor-stall';
  } else {
    dump.hangClass = 'perf harness hang';
    dump.hangKind = 'profiler-wait-with-live-renderer';
  }

  await fs.mkdir(outputDir, { recursive: true });
  const stamped = path.join(outputDir, `lyrics-pause-hang-${Date.now()}.json`);
  const payload = `${JSON.stringify(dump, null, 2)}\n`;
  await fs.writeFile(stamped, payload);
  await fs.writeFile(hangDumpPath, payload);
  try {
    await withTimeout(
      page.screenshot({ path: path.join(outputDir, 'lyrics-pause-hang.png'), fullPage: true }),
      4_000,
      'hangScreenshot',
    );
  } catch {
    /* renderer may be dead */
  }
  process.stdout.write(`${JSON.stringify({ phase: 'hang', dump }, null, 2)}\n`);
  return dump;
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

async function waitPaused(page) {
  await withTimeout(
    page.waitForFunction(
      async () => {
        const snap = await globalThis.yaqmc.invoke('player_snapshot');
        return snap?.isPlaying === false;
      },
      null,
      { timeout: 8_000 },
    ),
    9_000,
    'waitPaused',
  );
}

async function waitStage(page, stage, timeoutMs = 8_000) {
  await withTimeout(
    page.waitForFunction(
      (wanted) => document.querySelector(`.lyrics-stage[data-stage="${wanted}"]`) !== null,
      stage,
      { timeout: timeoutMs },
    ),
    timeoutMs + 1_000,
    `waitStage:${stage}`,
  );
}

async function waitStageGone(page, timeoutMs = 8_000) {
  await withTimeout(
    page.waitForFunction(() => document.querySelector('.lyrics-stage') === null, null, {
      timeout: timeoutMs,
    }),
    timeoutMs + 1_000,
    'waitStageGone',
  );
}

async function sampleEnter(page) {
  await setPhase(page, 'enter');
  const sampling = probe(page, 'sample', 600, 5_000);
  await probe(page, 'openLyrics');
  const sample = await sampling;
  await waitStage(page, 'open');
  await page.keyboard.press('F11');
  await withTimeout(
    page.waitForSelector('.lyrics-stage[data-fullscreen]', { timeout: 8_000 }),
    9_000,
    'waitFullscreen',
  ).catch(() => undefined);
  await sleep(400);
  return summarizeSample(sample);
}

async function sampleExit(page) {
  await setPhase(page, 'exit');
  await page.keyboard.press('Escape').catch(() => undefined);
  const sampling = probe(page, 'sample', 600, 5_000);
  await probe(page, 'closeLyrics');
  const sample = await sampling;
  await waitStageGone(page);
  return summarizeSample(sample);
}

async function traceWindow(page, durationMs) {
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
        categories:
          'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.layers,disabled-by-default-devtools.timeline.invalidationTracking',
      }),
      4_000,
      'Tracing.start',
    );
    await sleep(durationMs);
    const complete = withTimeout(
      new Promise((resolve) => {
        session.once('Tracing.tracingComplete', () => resolve());
      }),
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
  return [...buckets.entries()]
    .map(([name, stats]) => ({
      name,
      count: stats.count,
      maxMs: stats.maxUs / 1_000,
      sumMs: stats.sumUs / 1_000,
    }))
    .sort((left, right) => right.sumMs - left.sumMs)
    .slice(0, 20);
}

async function profilePauseCycle(page, label) {
  await setPhase(page, `${label}:play`);
  await invoke(page, 'player_play').catch(() => undefined);
  await waitPlaying(page);
  await sleep(300);
  await setPhase(page, `${label}:playingSteady`);
  const playingSteady = await probe(page, 'sample', 900, 6_000);
  const playingInspect = await probe(page, 'inspectLyricsCompositor', undefined, 4_000);

  await setPhase(page, `${label}:pauseOnset`);
  const pauseEarly = sampleRaf(page, 250);
  await invoke(page, 'player_pause');
  const pause0to250 = await pauseEarly;
  await waitPaused(page);
  await setPhase(page, `${label}:pauseSettle`);
  const pause250to1000 = await sampleRaf(page, 750);
  await setPhase(page, `${label}:pausedSteady`);
  const pausedSteady = await probe(page, 'sample', 900, 6_000);
  const pausedInspect = await probe(page, 'inspectLyricsCompositor', undefined, 4_000);

  await setPhase(page, `${label}:resume`);
  await invoke(page, 'player_play').catch(() => undefined);
  await waitPlaying(page);
  const resume0to250 = await sampleRaf(page, 250);
  const resumedSteady = await probe(page, 'sample', 800, 6_000);
  const resumedInspect = await probe(page, 'inspectLyricsCompositor', undefined, 4_000);

  const jank =
    isJank(pause0to250) ||
    isJank(pause250to1000) ||
    isJank(pausedSteady) ||
    playingSteady.rafStuck ||
    pausedSteady.rafStuck ||
    resumedSteady.rafStuck;
  return {
    jank,
    playingSteady: summarizeSample(playingSteady),
    pause0to250,
    pause250to1000,
    pausedSteady: summarizeSample(pausedSteady),
    resume0to250,
    resumedSteady: summarizeSample(resumedSteady),
    playingInspect,
    pausedInspect,
    resumedInspect,
  };
}

async function injectCss(page, css) {
  return page.addStyleTag({ content: css });
}

async function connectPage(child) {
  await waitForTcp('127.0.0.1', debugPort, 45_000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(debugPort)}`);
  const page =
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
  await maximize(page);
  return { browser, page, child };
}

function spawnElectron(env, sandbox) {
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
  return child;
}

async function killChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await sleep(400);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function prepareSession(page) {
  const webgl = await withTimeout(
    page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!gl) return { renderer: 'none', vendor: 'none' };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      };
    }),
    5_000,
    'webgl',
  );
  const artworkSrc = await probe(page, 'makeArtwork');
  await probe(page, 'enableArtworkBackground');
  await probe(page, 'enableFpsOverlay');
  await invoke(page, 'player_pause').catch(() => undefined);
  await invoke(page, 'player_play_tracks', {
    request: { tracks: [fixtureTrack('lyrics-pause', artworkSrc)], shuffle: false },
  });
  await invoke(page, 'player_play');
  await waitPlaying(page);
  await invoke(page, 'player_set_lyrics', { document: lyricDocument('lyrics-pause') });
  return webgl;
}

async function runPreset(page, preset, cycleCount) {
  await probe(page, 'selectLyricsPreset', preset);
  const enter = await sampleEnter(page);
  const runs = [];
  for (let index = 0; index < cycleCount; index += 1) {
    runs.push(await profilePauseCycle(page, `${preset}#${index + 1}`));
  }
  const jankRuns = runs.filter((run) => run.jank);
  const smoothRuns = runs.filter((run) => !run.jank);
  let jankTrace = null;
  let smoothTrace = null;
  if (enableTrace && jankRuns[0]) {
    await invoke(page, 'player_play').catch(() => undefined);
    await waitPlaying(page);
    await sleep(300);
    const tracing = traceWindow(page, 1_100);
    await invoke(page, 'player_pause');
    jankTrace = await tracing;
    await waitPaused(page);
  } else if (enableTrace && smoothRuns[0]) {
    await invoke(page, 'player_play').catch(() => undefined);
    await waitPlaying(page);
    const tracing = traceWindow(page, 1_100);
    await invoke(page, 'player_pause');
    smoothTrace = await tracing;
    await waitPaused(page);
  }
  const playingSteady = runs.map((run) => run.playingSteady?.rafFps);
  const pausedSteady = runs.map((run) => run.pausedSteady?.rafFps);
  const resumedSteady = runs.map((run) => run.resumedSteady?.rafFps);
  const exit = await sampleExit(page);
  const summary = {
    jankCount: jankRuns.length,
    smoothCount: smoothRuns.length,
    enter,
    exit,
    playingFps: playingSteady,
    pausedFps: pausedSteady,
    resumedFps: resumedSteady,
    jankExample: jankRuns[0] ?? null,
    smoothExample: smoothRuns[0] ?? null,
    jankTrace,
    smoothTrace,
    runs: runs.map((run) => ({
      jank: run.jank,
      playingFps: run.playingSteady?.rafFps,
      pause0to250: run.pause0to250,
      pause250to1000: run.pause250to1000,
      pausedFps: run.pausedSteady?.rafFps,
      pausedP95: run.pausedSteady?.rafP95Ms,
      resume0to250: run.resume0to250,
      resumedFps: run.resumedSteady?.rafFps,
      rafStuck: Boolean(
        run.playingSteady?.rafStuck ||
        run.pause0to250?.rafStuck ||
        run.pausedSteady?.rafStuck ||
        run.resumedSteady?.rafStuck,
      ),
    })),
  };
  process.stdout.write(`${JSON.stringify({ phase: 'preset', preset, summary }, null, 2)}\n`);
  return summary;
}

async function runAb(page, preset) {
  await probe(page, 'selectLyricsPreset', preset);
  await sampleEnter(page);
  const abCss = {
    keepVinylRunning: `
      .lyrics-stage__disc-spin { animation-play-state: running !important; }
    `,
    hideBackdrop: `
      .lyrics-stage__backdrop, .lyrics-stage__wash { visibility: hidden !important; }
    `,
    hideDisc: `
      .lyrics-stage__disc, .lyrics-stage__disc-spin { visibility: hidden !important; }
    `,
    hideDiscGrooves: `
      .lyrics-stage__disc-spin::before { display: none !important; }
    `,
  };
  const ab = {};
  for (const [name, css] of Object.entries(abCss)) {
    await setPhase(page, `ab:${name}`);
    const handle = await injectCss(page, css);
    const cycle = await profilePauseCycle(page, `ab:${name}`);
    ab[name] = {
      jank: cycle.jank,
      pause0to250: cycle.pause0to250,
      pause250to1000: cycle.pause250to1000,
      pausedSteady: cycle.pausedSteady,
      pausedInspect: cycle.pausedInspect,
    };
    await handle.evaluate((node) => node.remove());
  }
  await sampleExit(page);
  return ab;
}

async function main() {
  const sandbox = createQaSandbox({ purpose: 'lyrics-pause-gpu-profile' });
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

  let child = spawnElectron(env, sandbox);
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  process.on('exit', stop);

  const hangDumps = [];
  const byPreset = {};
  let ab = null;
  let webgl = null;
  let abTarget = 'builtin.vinyl';
  let extraVinyl = null;

  const runBody = async (page) => {
    webgl = await prepareSession(page);
    const presets = ['builtin.classic', 'builtin.immersive', 'builtin.vinyl'];
    for (const preset of presets) {
      if (byPreset[preset]) continue;
      byPreset[preset] = await runPreset(page, preset, cycles);
    }
    abTarget =
      Object.entries(byPreset).sort(
        (left, right) => right[1].jankCount - left[1].jankCount,
      )[0]?.[0] ?? 'builtin.vinyl';
    if (!ab) ab = await runAb(page, abTarget);
    if (!extraVinyl) {
      await probe(page, 'selectLyricsPreset', 'builtin.vinyl');
      const enter = await sampleEnter(page);
      const runs = [];
      for (let index = 0; index < extraVinylCycles; index += 1) {
        runs.push(await profilePauseCycle(page, `vinyl-extra#${index + 1}`));
      }
      extraVinyl = {
        enter,
        jankCount: runs.filter((run) => run.jank).length,
        smoothCount: runs.filter((run) => !run.jank).length,
        pausedFps: runs.map((run) => run.pausedSteady?.rafFps),
        playingFps: runs.map((run) => run.playingSteady?.rafFps),
        resumedFps: runs.map((run) => run.resumedSteady?.rafFps),
      };
      extraVinyl.exit = await sampleExit(page);
      process.stdout.write(`${JSON.stringify({ phase: 'vinyl-extra', extraVinyl }, null, 2)}\n`);
    }
  };

  const writeReport = async (session) => {
    const report = {
      probe: 'lyrics-pause-gpu-on',
      gpuDisabledEnv: process.env.ELECTRON_DISABLE_GPU ?? null,
      tracing: enableTrace,
      webgl,
      cycles,
      extraVinylCycles,
      jankFps,
      jankP95,
      byPreset,
      abTarget,
      ab,
      extraVinyl,
      hangDumps,
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await session?.browser.close().catch(() => undefined);
    return report;
  };

  try {
    let session = await connectPage(child);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await runBody(session.page);
        await writeReport(session);
        cleanupQaSandbox(sandbox.root);
        return;
      } catch (error) {
        const dump = await captureHang(session.page, child, error);
        hangDumps.push(dump);
        await session.browser.close().catch(() => undefined);
        await killChild(child);
        await waitForPortFree(debugPort).catch(() => undefined);
        if (attempt === 1) {
          await writeReport(null);
          throw error;
        }
        child = spawnElectron(env, sandbox);
        session = await connectPage(child);
      }
    }
  } finally {
    stop();
  }
}

await main();
