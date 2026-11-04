import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  pacingFromPresents,
  parseGfxinfoSummary,
  parseRefreshRate,
  parseSurfaceFlingerLatency,
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
