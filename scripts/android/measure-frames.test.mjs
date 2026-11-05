import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  frameTimeStats,
  matchesPackageLayer,
  pacingFromPresents,
  parseFramestats,
  parseGfxinfoSummary,
  parseRefreshRate,
  parseSurfaceFlingerLatency,
  parseTopThreads,
} from './measure-frames.mjs';

test('parses gfxinfo summary counters and GPU percentiles', () => {
  const summary = parseGfxinfoSummary(`
Total frames rendered: 2400
Janky frames: 96 (4.00%)
50th percentile: 6ms
90th percentile: 9ms
95th percentile: 11ms
99th percentile: 19ms
Number Missed Vsync: 3
Number Slow UI thread: 40
Number Slow bitmap uploads: 0
Number Frame deadline missed: 90
50th gpu percentile: 3ms
90th gpu percentile: 5ms
99th gpu percentile: 9ms
`);
  assert.equal(summary.totalFrames, 2400);
  assert.equal(summary.jankyFrames, 96);
  assert.equal(summary.p99Ms, 19);
  assert.equal(summary.deadlineMissed, 90);
  assert.equal(summary.gpuP90Ms, 5);
});

test('drops pending SurfaceFlinger rows and reads the vsync period', () => {
  const parsed = parseSurfaceFlingerLatency(
    '8333333\n100 1000000000 90\n200 9223372036854775807 0\n300 1008333333 290\n',
  );
  assert.equal(parsed.periodNs, 8333333);
  assert.deepEqual(parsed.presents, [1000000000, 1008333333]);
});

test('computes on-screen FPS and counts skipped refreshes', () => {
  const period = 8_333_333;
  // 9 frames every vsync, then one interval that skips a refresh.
  const presents = Array.from({ length: 10 }, (_, index) => index * period);
  presents.push(presents.at(-1) + 2 * period);
  const pacing = pacingFromPresents([...presents, presents[3]], period);
  assert.equal(pacing.frames, 11);
  assert.equal(pacing.jankIntervals, 1);
  assert.ok(pacing.effectiveFps > 100 && pacing.effectiveFps < 120);
});

test('reads the render frame rate from display dumps', () => {
  assert.equal(parseRefreshRate('  renderFrameRate 120.00001'), 120);
  assert.equal(parseRefreshRate('mActiveSfDisplayMode={id=2, width=1080, refreshRate=60.0}'), 60);
  assert.equal(parseRefreshRate('nothing here'), null);
});

test('falls back to the SurfaceFlinger refresh-rate line', () => {
  assert.equal(
    parseRefreshRate('Display 0 HWC layers:\n   refresh-rate              : 90.000000 fps'),
    90,
  );
});

test('parses framestats rows by header name and skips flagged frames', () => {
  const header =
    'Flags,FrameTimelineVsyncId,IntendedVsync,Vsync,InputEventId,HandleInputStart,FrameCompleted,DequeueBufferDuration,';
  const row = (flags, start, end) => `${flags},1,${start},${start},0,0,${end},0,`;
  const frames = parseFramestats(`Applications Graphics Acceleration Info:
---PROFILEDATA---
${header}
${row(0, 1_000_000, 7_000_000)}
${row(1, 9_000_000, 90_000_000)}
${row(0, 17_000_000, 36_000_000)}
---PROFILEDATA---
View hierarchy:`);
  assert.deepEqual(frames, [
    { vsync: 1_000_000, frameNs: 6_000_000 },
    { vsync: 17_000_000, frameNs: 19_000_000 },
  ]);
});

test('judges app frame times against the vsync period', () => {
  const frames = [4, 5, 6, 7, 9, 18].map((ms, index) => ({ vsync: index, frameNs: ms * 1e6 }));
  const stats = frameTimeStats(frames, 8.333);
  assert.equal(stats.frames, 6);
  assert.equal(stats.p50Ms, 6);
  assert.equal(stats.p99Ms, 18);
  assert.equal(stats.overOneVsync, 2);
  assert.equal(stats.overTwoVsync, 1);
  assert.equal(frameTimeStats([], 8.333), null);
});

test('locates top columns from the header across toybox layouts', () => {
  // Android 10+: S[%CPU] spans the state and %CPU data columns.
  const modern = parseTopThreads(`Threads: 60 total
  TID USER         PR  NI VIRT  RES  SHR S[%CPU] %MEM     TIME+ THREAD          PROCESS
 4242 u0_a123      10 -10  14G 220M 140M S 18.3   3.1   0:42.10 RenderThread    org.yaqmc.android
 4200 u0_a123      10 -10  14G 220M 140M R  9.0   3.1   0:20.00 yaqmc.android   org.yaqmc.android`);
  assert.deepEqual(modern, [
    { name: 'RenderThread', cpu: 18.3 },
    { name: 'yaqmc.android', cpu: 9 },
  ]);
  // Pre-toybox layouts (CPU% header, optional PCY column) are refused rather than misread.
  const legacy =
    parseTopThreads(`  PID   TID USER     PR  NI CPU% S     VSS     RSS PCY Thread          Proc
 4200  4242 u0_a123  10 -10   21% S 1.0G 200M  ta RenderThread    org.yaqmc.android`);
  assert.deepEqual(legacy, []);
  assert.deepEqual(parseTopThreads('no header'), []);
});

test('matches the app layer for the exact package only', () => {
  const base = 'org.yaqmc.android';
  assert.ok(matchesPackageLayer('org.yaqmc.android/org.yaqmc.android.MainActivity#123', base));
  assert.ok(
    matchesPackageLayer('BLAST(org.yaqmc.android/org.yaqmc.android.MainActivity)#124', base),
  );
  assert.ok(
    !matchesPackageLayer('org.yaqmc.android.perftest/org.yaqmc.android.MainActivity#9', base),
  );
  assert.ok(
    matchesPackageLayer(
      'org.yaqmc.android.perftest/org.yaqmc.android.MainActivity#9',
      `${base}.perftest`,
    ),
  );
  assert.ok(!matchesPackageLayer('orgXyaqmcXandroid/Main#1', base));
});
