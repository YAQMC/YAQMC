/**
 * PLAY-02 assist: how to measure seek round-trip p95 vs plan §15.4 / §35.2.
 *
 * This script does not perform a live UI measurement and does not invent a green
 * number. Windows and Linux cells stay PENDING until a maintainer records them.
 *
 * Budget (do not treat as a measured result):
 * - §15.4: Electron adds one hop (renderer→main). Total added latency target < 5 ms p95.
 * - §35.2: Seek round-trip p95 (UI event → settled snapshot) ≤ Tauri baseline + 5 ms.
 *
 * Suggested protocol (maintainer, real Electron window, fake or live account):
 * 1. Instrument the UI seek event timestamp at the player-store / slider commit.
 * 2. Wait for the snapshot that settles at the requested position (±250 ms fencing,
 *    snapshot_revision strictly monotonic; drop stale session_id completions).
 * 3. Repeat a rapid-seek storm (plan §15.6: 50 seeks in 2 s) plus isolated seeks.
 * 4. p95 = percentile of (settledTimestamp - uiEventTimestamp) over the sample.
 * 5. Write the number into docs/migration/perf-baseline.md Seek round-trip p95
 *    (or the generator snapshot). Leave the cell PENDING until that capture.
 *
 * Run: node scripts/migration/play02-seek-p95.mjs
 */

const result = {
  id: 'PLAY-02',
  metric: 'seekRoundTripP95Ms',
  budget: {
    section15_4: 'added latency target < 5 ms p95 (not a measured value)',
    section35_2: 'UI event → settled snapshot ≤ baseline + 5 ms (not a measured value)',
  },
  Windows: { state: 'PENDING', p95Ms: null },
  Linux: { state: 'PENDING', p95Ms: null },
  notes: [
    'Do not claim PLAY-02 green. LIVE VERIFY is maintainer-only.',
    'This assist does not start qm-api-rs or invent a p95.',
  ],
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
