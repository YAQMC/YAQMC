#!/usr/bin/env node
// Measures on-device frame pacing for the YAQMC Android app or the amll-android demo.
// Open the lyrics page (or start the demo in benchmark mode) and start playback first.
//
//   node scripts/android/measure-frames.mjs --label before --seconds 20 \
//     [--package org.yaqmc.android.perftest] [--serial <id>] [--out dir]
//   node scripts/android/measure-frames.mjs --compare before.json after.json
//
// Sources, in order of authority:
// - gfxinfo framestats: the app's HWUI timeline for its window (WebView functor + native lyric
//   overlay share it). Sampled repeatedly (HWUI keeps ~120 frames) and de-duplicated by vsync id.
// - gfxinfo summary: jank counters and CPU/GPU percentiles since reset.
// - SurfaceFlinger --latency: present timestamps for the app layer (not available on every
//   Android version/BLAST configuration; reported as null when empty).
// - the active display mode sampled through the run, per-thread CPU from `top`, thermal status.
// For root-causing a regression, capture a Perfetto trace with FrameTimeline instead.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_PACKAGE = 'org.yaqmc.android';

export function parseGfxinfoSummary(text) {
  const number = (pattern) => {
    const match = text.match(pattern);
    return match ? Number(match[1]) : null;
  };
  return {
    totalFrames: number(/Total frames rendered:\s*(\d+)/),
    jankyFrames: number(/Janky frames:\s*(\d+)/),
    p50Ms: number(/^50th percentile:\s*(\d+)ms/m),
    p90Ms: number(/^90th percentile:\s*(\d+)ms/m),
    p95Ms: number(/^95th percentile:\s*(\d+)ms/m),
    p99Ms: number(/^99th percentile:\s*(\d+)ms/m),
    missedVsync: number(/Number Missed Vsync:\s*(\d+)/),
    slowUiThread: number(/Number Slow UI thread:\s*(\d+)/),
    slowBitmapUploads: number(/Number Slow bitmap uploads:\s*(\d+)/),
    deadlineMissed: number(/Number Frame deadline missed:\s*(\d+)/),
    gpuP50Ms: number(/50th gpu percentile:\s*(\d+)ms/),
    gpuP90Ms: number(/90th gpu percentile:\s*(\d+)ms/),
    gpuP99Ms: number(/99th gpu percentile:\s*(\d+)ms/),
  };
}

/**
 * `dumpsys gfxinfo <pkg> framestats`: CSV blocks between ---PROFILEDATA--- markers. Returns valid
 * frames (Flags == 0) as { vsync, frameNs } where frameNs = FrameCompleted - IntendedVsync.
 */
export function parseFramestats(text) {
  const frames = [];
  for (const block of text.split('---PROFILEDATA---').slice(1)) {
    const lines = block
      .trim()
      .split('\n')
      .filter((line) => line.includes(','));
    if (lines.length < 2) continue;
    const header = lines[0].split(',').map((name) => name.trim());
    const col = (name) => header.indexOf(name);
    const [flags, intended, completed] = [
      col('Flags'),
      col('IntendedVsync'),
      col('FrameCompleted'),
    ];
    if (flags < 0 || intended < 0 || completed < 0) continue;
    for (const row of lines.slice(1)) {
      const cells = row.split(',');
      if (Number(cells[flags]) !== 0) continue;
      const start = Number(cells[intended]);
      const end = Number(cells[completed]);
      if (start > 0 && end > start) frames.push({ vsync: start, frameNs: end - start });
    }
  }
  return frames;
}

/** `dumpsys SurfaceFlinger --latency <layer>`: period line, then present rows (INT64_MAX = pending). */
export function parseSurfaceFlingerLatency(text) {
  const lines = text.trim().split('\n');
  const periodNs = Number(lines[0]);
  const presents = lines
    .slice(1)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) => row.length >= 3 && row[1] > 0 && row[1] < 9e18)
    .map((row) => row[1]);
  return { periodNs: Number.isFinite(periodNs) && periodNs > 0 ? periodNs : null, presents };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

const round = (value, digits = 2) => (value === null ? null : Number(value.toFixed(digits)));

/** Present-interval pacing; a jank interval is longer than 1.5 vsync periods (a refresh was skipped). */
export function pacingFromPresents(presentsNs, periodNs) {
  const unique = [...new Set(presentsNs)].sort((a, b) => a - b);
  const intervals = [];
  for (let index = 1; index < unique.length; index += 1) {
    intervals.push((unique[index] - unique[index - 1]) / 1e6);
  }
  if (intervals.length === 0) return null;
  const sorted = [...intervals].sort((a, b) => a - b);
  const spanMs = (unique.at(-1) - unique[0]) / 1e6;
  const periodMs = periodNs ? periodNs / 1e6 : null;
  return {
    frames: unique.length,
    spanMs: Math.round(spanMs),
    effectiveFps: round((intervals.length / spanMs) * 1000, 1),
    intervalP50Ms: round(percentile(sorted, 0.5)),
    intervalP95Ms: round(percentile(sorted, 0.95)),
    intervalP99Ms: round(percentile(sorted, 0.99)),
    jankIntervals: periodMs ? intervals.filter((value) => value > periodMs * 1.5).length : null,
  };
}

/** App frame-time distribution from framestats, judged against the measured vsync period. */
export function frameTimeStats(frames, periodMs) {
  if (frames.length === 0) return null;
  const sorted = frames.map((frame) => frame.frameNs / 1e6).sort((a, b) => a - b);
  return {
    frames: sorted.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.at(-1)),
    // IntendedVsync -> FrameCompleted includes pipelining, so "over budget" is conservative.
    overOneVsync: periodMs ? sorted.filter((ms) => ms > periodMs).length : null,
    overTwoVsync: periodMs ? sorted.filter((ms) => ms > periodMs * 2).length : null,
  };
}

export function parseRefreshRate(dump) {
  const render = dump.match(/renderFrameRate[=:\s]+([\d.]+)/);
  const mode = dump.match(/mActiveSfDisplayMode=.*?(?:refreshRate|fps)=([\d.]+)/);
  const legacy = dump.match(/mRefreshRate=([\d.]+)/);
  const surfaceFlinger = dump.match(/refresh-rate\s*:\s*([\d.]+)/);
  const value = render?.[1] ?? mode?.[1] ?? legacy?.[1] ?? surfaceFlinger?.[1];
  return value === undefined ? null : Number(Number(value).toFixed(1));
}

/**
 * toybox `top -H` output. Columns are located from the header; toybox prints `S[%CPU]` as one header
 * token over two data columns (state and %CPU), so data indexes are shifted after that token.
 */
export function parseTopThreads(text) {
  const lines = text.split('\n');
  const headerIndex = lines.findIndex(
    (line) => /%CPU/.test(line) && /(THREAD|NAME|CMD|ARGS)/.test(line),
  );
  if (headerIndex < 0) return [];
  const header = lines[headerIndex].trim().split(/\s+/);
  const dataIndex = (predicate) => {
    let index = 0;
    for (const token of header) {
      if (predicate(token)) return index + (token.startsWith('S[') ? 1 : 0);
      index += token.startsWith('S[') ? 2 : 1;
    }
    return -1;
  };
  const cpuIndex = dataIndex((token) => token.includes('%CPU'));
  const nameIndex = dataIndex((token) => ['THREAD', 'NAME', 'CMD', 'ARGS'].includes(token));
  if (cpuIndex < 0 || nameIndex < 0) return [];
  const threads = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length <= Math.max(cpuIndex, nameIndex)) continue;
    const cpu = Number(cells[cpuIndex]);
    if (Number.isFinite(cpu)) threads.push({ name: cells[nameIndex], cpu });
  }
  return threads;
}

export function matchesPackageLayer(line, pkg) {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s(])${escaped}/`).test(line);
}

function adb(serial, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('adb', [...(serial ? ['-s', serial] : []), ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

const shell = (serial, command, options) => adb(serial, ['shell', command], options);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appLayer(serial, pkg) {
  const layers = shell(serial, 'dumpsys SurfaceFlinger --list')
    .split('\n')
    .map((line) => line.trim());
  const ours = layers.filter((line) => matchesPackageLayer(line, pkg));
  return ours.find((line) => line.includes('BLAST')) ?? ours[0] ?? null;
}

async function measure({ serial, seconds, label, out, pkg }) {
  const pid = shell(serial, `pidof ${pkg}`, { allowFailure: true }).trim();
  if (!pid) throw new Error(`${pkg} is not running; open the lyrics page and start playback.`);
  const props = (name) => shell(serial, `getprop ${name}`, { allowFailure: true }).trim();
  const displayDump = shell(serial, 'dumpsys display');
  const packageDump = shell(serial, `dumpsys package ${pkg}`, { allowFailure: true });
  const device = {
    model: `${props('ro.product.manufacturer')} ${props('ro.product.model')}`.trim(),
    android: props('ro.build.version.release'),
    sdk: props('ro.build.version.sdk'),
    soc: props('ro.soc.model') || props('ro.board.platform'),
    supportedModes: [
      ...new Set([...displayDump.matchAll(/fps=([\d.]+)/g)].map((m) => round(Number(m[1]), 1))),
    ],
  };
  const build = {
    package: pkg,
    versionName: packageDump.match(/versionName=(\S+)/)?.[1] ?? null,
    profileable: /PROFILEABLE|profileableByShell/.test(packageDump),
    debuggable: /flags=\[[^\]]*DEBUGGABLE/.test(packageDump),
  };
  const layer = appLayer(serial, pkg);
  shell(serial, `dumpsys gfxinfo ${pkg} reset`);
  if (layer)
    shell(serial, `dumpsys SurfaceFlinger --latency-clear "${layer}"`, { allowFailure: true });

  const refreshSamples = [];
  const presents = [];
  const framesByVsync = new Map();
  let periodNs = null;
  const threadCpu = new Map();
  let threadSampleCount = 0;
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    refreshSamples.push(parseRefreshRate(shell(serial, 'dumpsys display')));
    for (const frame of parseFramestats(shell(serial, `dumpsys gfxinfo ${pkg} framestats`))) {
      framesByVsync.set(frame.vsync, frame);
    }
    if (layer) {
      const latency = parseSurfaceFlingerLatency(
        shell(serial, `dumpsys SurfaceFlinger --latency "${layer}"`, { allowFailure: true }) || '0',
      );
      periodNs = latency.periodNs ?? periodNs;
      presents.push(...latency.presents);
    }
    const threads = parseTopThreads(
      shell(serial, `top -H -b -n 1 -p ${pid}`, { allowFailure: true }),
    );
    if (threads.length) threadSampleCount += 1;
    for (const { name, cpu } of threads) threadCpu.set(name, (threadCpu.get(name) ?? 0) + cpu);
    await sleep(500);
  }

  const gfx = shell(serial, `dumpsys gfxinfo ${pkg}`);
  const thermal = shell(serial, 'dumpsys thermalservice', { allowFailure: true }).match(
    /Thermal Status:\s*(\d+)/,
  );
  const medianRefresh =
    [...refreshSamples].filter(Boolean).sort((a, b) => a - b)[
      Math.floor(refreshSamples.length / 2)
    ] ?? null;
  const periodMs = periodNs ? periodNs / 1e6 : medianRefresh ? 1000 / medianRefresh : null;
  const report = {
    label,
    measuredAt: new Date().toISOString(),
    seconds,
    device,
    build,
    refreshRateSamples: refreshSamples,
    vsyncPeriodMs: round(periodMs, 3),
    layer,
    appFrames: frameTimeStats([...framesByVsync.values()], periodMs),
    surfaceFlinger: pacingFromPresents(presents, periodNs),
    gfxinfo: parseGfxinfoSummary(gfx),
    topThreadsCpuPercent: [...threadCpu.entries()]
      .map(([name, total]) => [name, round(total / Math.max(1, threadSampleCount), 1)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
    thermalStatus: thermal ? Number(thermal[1]) : null,
  };
  mkdirSync(out, { recursive: true });
  const file = path.join(out, `android-frames-${label}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n\nSaved ${file}\n`);
}

function compare(beforeFile, afterFile) {
  const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
  const after = JSON.parse(readFileSync(afterFile, 'utf8'));
  const median = (values) =>
    [...values].filter(Boolean).sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const rows = [
    ['refresh Hz (median sample)', (r) => median(r.refreshRateSamples)],
    [
      'app frame time p50 / p95 / p99 ms',
      (r) => r.appFrames && `${r.appFrames.p50Ms} / ${r.appFrames.p95Ms} / ${r.appFrames.p99Ms}`,
    ],
    [
      'app frames over 1 / 2 vsync',
      (r) =>
        r.appFrames &&
        `${r.appFrames.overOneVsync} / ${r.appFrames.overTwoVsync} of ${r.appFrames.frames}`,
    ],
    ['on-screen FPS (SurfaceFlinger)', (r) => r.surfaceFlinger?.effectiveFps],
    ['present interval p95 ms', (r) => r.surfaceFlinger?.intervalP95Ms],
    ['skipped-refresh intervals', (r) => r.surfaceFlinger?.jankIntervals],
    [
      'gfxinfo janky / deadline missed',
      (r) => `${r.gfxinfo.jankyFrames} / ${r.gfxinfo.deadlineMissed}`,
    ],
    ['GPU p90 / p99 ms', (r) => `${r.gfxinfo.gpuP90Ms} / ${r.gfxinfo.gpuP99Ms}`],
    ['thermal status', (r) => r.thermalStatus],
  ];
  process.stdout.write(`| metric | ${before.label} | ${after.label} |\n|---|---|---|\n`);
  for (const [name, read] of rows)
    process.stdout.write(`| ${name} | ${read(before)} | ${read(after)} |\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
  };
  if (args[0] === '--compare') {
    compare(args[1], args[2]);
  } else {
    await measure({
      serial: option('serial', process.env.ANDROID_SERIAL),
      seconds: Number(option('seconds', '20')),
      label: option('label', 'run'),
      out: option('out', 'artifacts/android-perf'),
      pkg: option('package', DEFAULT_PACKAGE),
    });
  }
}
