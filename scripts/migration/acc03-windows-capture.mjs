/**
 * ACC-03 Windows capture: cold start, idle RSS, playing CPU, lyrics line jitter.
 * Unique yaqmc-qa sandbox — not the ACC-04 daily-driver profile.
 *
 * Vite must already serve 127.0.0.1:1420. Desktop main must be built.
 *
 *   $env:CARGO_TARGET_DIR='E:\cargo-target\yaqmc-electron-migration'
 *   $env:YAQMC_CORE_BIN="$env:CARGO_TARGET_DIR\debug\yaqmc-core.exe"
 *   node scripts/migration/acc03-windows-capture.mjs
 *
 * Writes artifacts/acc03-windows-last.json (gitignored). Does not invent
 * PLAY-02 p95. Does not run the P12 second 4h soak. BASE-03 pre-migration cells stay
 * PENDING unless that snapshot already has numbers.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { waitForTcp } from '../dev-desktop.mjs';
import {
  cleanupQaSandbox,
  createQaSandbox,
  electronQaArgs,
  qaElectronEnv,
} from '../qa-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const electronBinary = createRequire(path.join(desktopRoot, 'package.json'))('electron');
const debugPort = Number(process.env.YAQMC_ACC03_PORT || 9240);
const lyricsSeconds = Number(process.env.YAQMC_ACC03_LYRICS_SECONDS || 120);

function coreBin() {
  const name = 'yaqmc-core.exe';
  const cargo = process.env.CARGO_TARGET_DIR;
  const candidates = [
    process.env.YAQMC_CORE_BIN,
    cargo ? path.join(cargo, 'debug', name) : undefined,
    path.join(repoRoot, 'target', 'debug', name),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 8_000,
    });
  } catch {
    // already gone
  }
}

function procTree(pid) {
  const script = [
    `$root = ${String(pid)}`,
    '$q = New-Object System.Collections.Generic.Queue[int]',
    '$q.Enqueue($root)',
    '$seen = @{}',
    '$sumWs = [int64]0',
    '$sumCpu = 0.0',
    'while ($q.Count -gt 0) {',
    '  $id = $q.Dequeue()',
    '  if ($seen.ContainsKey($id)) { continue }',
    '  $seen[$id] = $true',
    '  try { $p = Get-Process -Id $id -EA Stop; $sumWs += $p.WorkingSet64; $sumCpu += [double]$p.CPU } catch {}',
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -EA SilentlyContinue | ForEach-Object { $q.Enqueue([int]$_.ProcessId) }',
    '}',
    'Write-Output ("{0} {1} {2}" -f $sumWs, $sumCpu, $seen.Count)',
  ].join('; ');
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  }).trim();
  const [bytes, cpu, count] = out.split(/\s+/u);
  return {
    miB: Number(bytes) / (1024 * 1024),
    cpuSeconds: Number(cpu),
    processes: Number(count),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function isolatedLaunch() {
  const sandbox = createQaSandbox({ purpose: 'acc03-windows' });
  const env = qaElectronEnv(process.env, sandbox, { YAQMC_VITE_DEV: '1' });
  delete env.YAQMC_ELECTRON_E2E;
  delete env.YAQMC_E2E_CORE;
  delete env.YAQMC_E2E_NATIVE;
  delete env.YAQMC_DESKTOP_SMOKE;
  delete env.ELECTRON_DISABLE_GPU;
  const bin = coreBin();
  if (bin) env.YAQMC_CORE_BIN = bin;
  return { env, sandbox };
}

function spawnElectron(env, sandbox, port) {
  return spawn(
    electronBinary,
    electronQaArgs(sandbox, [`--remote-debugging-port=${String(port)}`, '--lang=en-US']),
    { cwd: desktopRoot, env, stdio: 'ignore', windowsHide: false },
  );
}

async function connectPage(port) {
  await waitForTcp('127.0.0.1', port, 45_000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
  const page =
    browser.contexts().flatMap((context) => context.pages())[0] ??
    (await browser.contexts()[0]?.waitForEvent('page'));
  if (!page) throw new Error('no Electron page');
  await page.waitForSelector('.app-shell', { timeout: 60_000 });
  return { browser, page };
}

async function invoke(page, method, params) {
  return page.evaluate(
    async ({ methodName, payload }) => {
      const yaqmc = globalThis.yaqmc;
      if (!yaqmc || typeof yaqmc.invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return yaqmc.invoke(methodName, payload);
    },
    { methodName: method, payload: params },
  );
}

function waitCoreReady(sandbox, timeoutMs = 45_000) {
  const logPath = path.join(sandbox.logs, 'host.log');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (existsSync(logPath) && readFileSync(logPath, 'utf8').includes('core ready')) {
          resolve(logPath);
          return;
        }
      } catch {
        // rotating / locked
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for core ready in ${logPath}`));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function corePid(sandbox) {
  const file = path.join(sandbox.coreData, 'core.pid');
  if (!existsSync(file)) return null;
  const pid = Number.parseInt(readFileSync(file, 'utf8').trim().split(/\s+/u)[0] ?? '', 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function oneColdStart(port) {
  const { env, sandbox } = isolatedLaunch();
  const started = Date.now();
  const child = spawnElectron(env, sandbox, port);
  try {
    const { browser } = await connectPage(port);
    const shellMs = Date.now() - started;
    await waitCoreReady(sandbox);
    const readyMs = Date.now() - started;
    await browser.close().catch(() => undefined);
    return { shellMs, readyMs, electronPid: child.pid, sandbox };
  } finally {
    killTree(child.pid);
    cleanupQaSandbox(sandbox.root);
  }
}

async function main() {
  await waitForTcp('127.0.0.1', 1420, 5_000).catch(() => {
    throw new Error('Vite is not serving 127.0.0.1:1420');
  });
  if (!coreBin()) throw new Error('set YAQMC_CORE_BIN or build debug yaqmc-core');

  const cold = [];
  for (let index = 0; index < 3; index += 1) {
    cold.push(await oneColdStart(debugPort + index));
    await delay(1_000);
  }

  const { env, sandbox } = isolatedLaunch();
  const child = spawnElectron(env, sandbox, debugPort + 10);
  const report = {
    capturedAt: new Date().toISOString(),
    platform: 'windows',
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    notes: [
      'Unique yaqmc-qa sandbox. Not ACC-04 daily-driver.',
      'BASE-03 pre-migration live cells were PENDING in perf-baseline.md at capture time.',
      'Not PLAY-02. Not P12 second soak.',
    ],
    coldStart: {
      runs: cold.map(({ shellMs, readyMs }) => ({ shellMs, readyMs })),
      medianShellMs: median(cold.map((row) => row.shellMs)),
      medianReadyMs: median(cold.map((row) => row.readyMs)),
    },
  };

  try {
    const { browser, page } = await connectPage(debugPort + 10);
    await waitCoreReady(sandbox);
    const electronPid = child.pid;
    const hostPid = corePid(sandbox);
    await delay(60_000);
    const idleTree = procTree(electronPid);
    const idleCore = hostPid ? procTree(hostPid) : null;
    report.idleRss60s = {
      electronTreeMiB: idleTree.miB,
      electronTreeProcesses: idleTree.processes,
      coreTreeMiB: idleCore ? idleCore.miB : null,
      sumMiB: idleTree.miB,
      note: 'sumMiB is the Electron spawn tree (includes yaqmc-core if it is a child). coreTreeMiB is diagnostic only — do not add it again. Not BASE-03 until the historical comparison cells exist.',
    };

    await invoke(page, 'player_play_tracks', {
      request: {
        tracks: [
          {
            id: 'acc03-cpu',
            title: 'acc03-cpu',
            artists: [{ id: 'a', name: 'A' }],
            album: { id: 'b', title: 'B' },
            artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000' },
            durationMs: 120_000,
            trackNumber: 1,
            isFavorite: false,
            quality: 'standard',
            availability: { status: 'available' },
          },
        ],
        shuffle: false,
      },
    });
    await invoke(page, 'player_play');
    const cpu0e = procTree(electronPid);
    const cpu0c = hostPid ? procTree(hostPid) : null;
    const t0 = Date.now();
    await delay(20_000);
    const elapsed = (Date.now() - t0) / 1000;
    const cpu1e = procTree(electronPid);
    const cpu1c = hostPid ? procTree(hostPid) : null;
    report.playingCpu20s = {
      electronTreePp: ((cpu1e.cpuSeconds - cpu0e.cpuSeconds) / elapsed) * 100,
      coreTreePp: cpu0c && cpu1c ? ((cpu1c.cpuSeconds - cpu0c.cpuSeconds) / elapsed) * 100 : null,
      elapsedSeconds: elapsed,
    };

    await invoke(page, 'player_set_lyrics', {
      document: {
        songId: 'acc03-cpu',
        syncMode: 'line',
        metadata: { sourceLabel: 'acc03', offsetMs: 0 },
        vocalists: [],
        lines: Array.from({ length: 80 }, (_, index) => ({
          id: `l${String(index)}`,
          startMs: index * 1_500,
          endMs: (index + 1) * 1_500,
          text: `acc03-${String(index)}`,
          words: [],
        })),
      },
    });
    await invoke(page, 'player_seek', { positionMs: 0 });
    await invoke(page, 'player_play');
    const samples = [];
    const jitterUntil = Date.now() + lyricsSeconds * 1_000;
    while (Date.now() < jitterUntil) {
      const snap = await invoke(page, 'player_snapshot');
      const proj = await invoke(page, 'lyrics_surface_projection');
      const expected = Math.min(79, Math.floor((snap.positionMs ?? 0) / 1_500));
      samples.push({
        positionMs: snap.positionMs,
        lineIndex: proj.lineIndex,
        expected,
        delta: (proj.lineIndex ?? 0) - expected,
      });
      await delay(250);
    }
    const abs = samples.map((row) => Math.abs(row.delta));
    const positions = samples.map((row) => row.positionMs ?? 0);
    report.lyricsJitter = {
      seconds: lyricsSeconds,
      samples: samples.length,
      maxAbsLineDelta: Math.max(...abs),
      meanAbsLineDelta: abs.reduce((sum, value) => sum + value, 0) / abs.length,
      positionMinMs: Math.min(...positions),
      positionMaxMs: Math.max(...positions),
      clockAdvanced: Math.max(...positions) > Math.min(...positions),
    };
    await browser.close().catch(() => undefined);
    cleanupQaSandbox(sandbox.root);
  } finally {
    killTree(child.pid);
  }

  const out = path.join(repoRoot, 'artifacts', 'acc03-windows-last.json');
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
