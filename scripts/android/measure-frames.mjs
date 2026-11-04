#!/usr/bin/env node
// Measures on-device frame pacing for the YAQMC Android app (open the lyrics page and start playback first).
//
//   node scripts/android/measure-frames.mjs --label before --seconds 20 [--serial <id>] [--out dir]
//   node scripts/android/measure-frames.mjs --compare before.json after.json
//
// Sources: SurfaceFlinger present timestamps for the app layer (what reached the screen),
// gfxinfo (app RenderThread frame times, jank counters, GPU percentiles), the active display
// mode sampled through the run, per-thread CPU from `top`, and thermal status.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = 'org.yaqmc.android';

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

/** `dumpsys SurfaceFlinger --latency <layer>`: first line is the vsync period in ns, then
 * "desiredPresent actualPresent frameReady" rows; INT64_MAX marks a pending frame. */
export function parseSurfaceFlingerLatency(text) {
  const lines = text.trim().split('\n');
  const periodNs = Number(lines[0]);
  const presents = lines
    .slice(1)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) => row.length >= 3 && row[1] > 0 && row[1] < 9e18)
    .map((row) => row[1]);
  return { periodNs: Number.isFinite(periodNs) ? periodNs : null, presents };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/** Frame pacing from unique present timestamps (ns): intervals, effective FPS, and jank, where a
 * jank is an interval longer than 1.5 vsync periods (at least one refresh was skipped). */
export function pacingFromPresents(presentsNs, periodNs) {
  const unique = [...new Set(presentsNs)].sort((a, b) => a - b);
  const intervals = [];
  for (let index = 1; index < unique.length; index += 1) {
    intervals.push((unique[index] - unique[index - 1]) / 1e6);
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const spanMs = unique.length > 1 ? (unique.at(-1) - unique[0]) / 1e6 : 0;
  const periodMs = periodNs ? periodNs / 1e6 : null;
  return {
    frames: unique.length,
    spanMs: Math.round(spanMs),
    effectiveFps: spanMs > 0 ? Number(((intervals.length / spanMs) * 1000).toFixed(1)) : null,
    intervalP50Ms: percentile(sorted, 0.5),
    intervalP95Ms: percentile(sorted, 0.95),
    intervalP99Ms: percentile(sorted, 0.99),
    jankIntervals: periodMs ? intervals.filter((value) => value > periodMs * 1.5).length : null,
  };
}

export function parseRefreshRate(displayDump) {
  const render = displayDump.match(/renderFrameRate[=:\s]+([\d.]+)/);
  const mode = displayDump.match(/mActiveSfDisplayMode=.*?(?:refreshRate|fps)=([\d.]+)/);
  const legacy = displayDump.match(/mRefreshRate=([\d.]+)/);
  const value = render?.[1] ?? mode?.[1] ?? legacy?.[1];
  return value === undefined ? null : Number(Number(value).toFixed(1));
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

function appLayer(serial) {
  const layers = shell(serial, 'dumpsys SurfaceFlinger --list').split('\n');
  const ours = layers.map((line) => line.trim()).filter((line) => line.includes(PACKAGE));
  return (
    ours.find((line) => line.includes('MainActivity') && line.includes('BLAST')) ??
    ours.find((line) => line.includes('MainActivity')) ??
    ours[0] ??
    null
  );
}

async function measure({ serial, seconds, label, out }) {
  const pid = shell(serial, `pidof ${PACKAGE}`, { allowFailure: true }).trim();
  if (!pid) throw new Error(`${PACKAGE} is not running; open the lyrics page and start playback.`);
  const props = (name) => shell(serial, `getprop ${name}`, { allowFailure: true }).trim();
  const device = {
    model: `${props('ro.product.manufacturer')} ${props('ro.product.model')}`.trim(),
    android: props('ro.build.version.release'),
    sdk: props('ro.build.version.sdk'),
    soc: props('ro.soc.model') || props('ro.board.platform'),
    supportedModes: [
      ...new Set(
        [...shell(serial, 'dumpsys display').matchAll(/fps=([\d.]+)/g)].map((m) =>
          Number(Number(m[1]).toFixed(1)),
        ),
      ),
    ],
  };
  const layer = appLayer(serial);
  shell(serial, `dumpsys gfxinfo ${PACKAGE} reset`);
  if (layer)
    shell(serial, `dumpsys SurfaceFlinger --latency-clear "${layer}"`, { allowFailure: true });

  const refreshSamples = [];
  const presents = [];
  let periodNs = null;
  const threadSamples = [];
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    refreshSamples.push(parseRefreshRate(shell(serial, 'dumpsys display')));
    if (layer) {
      // The latency buffer holds ~128 frames (about one second at 120 Hz), so sample often.
      const latency = parseSurfaceFlingerLatency(
        shell(serial, `dumpsys SurfaceFlinger --latency "${layer}"`, { allowFailure: true }) || '0',
      );
      periodNs = latency.periodNs ?? periodNs;
      presents.push(...latency.presents);
    }
    threadSamples.push(shell(serial, `top -H -b -n 1 -p ${pid}`, { allowFailure: true }));
    await sleep(500);
  }

  const gfx = shell(serial, `dumpsys gfxinfo ${PACKAGE}`);
  const thermal = shell(serial, 'dumpsys thermalservice', { allowFailure: true }).match(
    /Thermal Status:\s*(\d+)/,
  );
  const threads = new Map();
  for (const sample of threadSamples) {
    for (const line of sample.split('\n')) {
      const columns = line.trim().split(/\s+/);
      const cpu = Number(columns[8]);
      if (columns.length < 12 || !Number.isFinite(cpu)) continue;
      const name = columns.slice(11).join(' ');
      threads.set(name, (threads.get(name) ?? 0) + cpu / threadSamples.length);
    }
  }
  const report = {
    label,
    measuredAt: new Date().toISOString(),
    seconds,
    device,
    refreshRateSamples: refreshSamples,
    layer,
    vsyncPeriodMs: periodNs ? Number((periodNs / 1e6).toFixed(3)) : null,
    surfaceFlinger: pacingFromPresents(presents, periodNs),
    gfxinfo: parseGfxinfoSummary(gfx),
    topThreadsCpuPercent: [...threads.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, cpu]) => [name, Number(cpu.toFixed(1))]),
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
  const rows = [
    [
      'refresh Hz (median sample)',
      (r) =>
        [...r.refreshRateSamples].sort((a, b) => a - b)[
          Math.floor(r.refreshRateSamples.length / 2)
        ],
    ],
    ['on-screen FPS (SurfaceFlinger)', (r) => r.surfaceFlinger.effectiveFps],
    ['present interval p50 ms', (r) => r.surfaceFlinger.intervalP50Ms],
    ['present interval p95 ms', (r) => r.surfaceFlinger.intervalP95Ms],
    ['skipped-refresh intervals', (r) => r.surfaceFlinger.jankIntervals],
    ['gfxinfo frames', (r) => r.gfxinfo.totalFrames],
    ['gfxinfo janky frames', (r) => r.gfxinfo.jankyFrames],
    ['gfxinfo p90 / p99 ms', (r) => `${r.gfxinfo.p90Ms} / ${r.gfxinfo.p99Ms}`],
    ['GPU p90 / p99 ms', (r) => `${r.gfxinfo.gpuP90Ms} / ${r.gfxinfo.gpuP99Ms}`],
    ['thermal status', (r) => r.thermalStatus],
  ];
  process.stdout.write(`| metric | ${before.label} | ${after.label} |\n|---|---|---|\n`);
  for (const [name, read] of rows) {
    process.stdout.write(`| ${name} | ${read(before)} | ${read(after)} |\n`);
  }
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
    });
  }
}
