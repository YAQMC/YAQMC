import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const baselineScript = path.join(repositoryRoot, 'scripts', 'perf-baseline.mjs');

const REQUIRED_METRICS = [
  'coldStartInteractiveMs',
  'warmStartInteractiveMs',
  'rssBootIdle60sMiB',
  'rssPlayback30mMiB',
  'cpuPausedPercent',
  'cpuPlayingPercent',
  'cpuSeekStormPercent',
  'seekRoundTripP95Ms',
  'installerSizeMiB',
  'installedSizeMiB',
];

function pendingMeasurements() {
  return Object.fromEntries(
    ['Windows', 'Linux'].flatMap((platform) =>
      REQUIRED_METRICS.map((metric) => [`${platform}:${metric}`, { state: 'pending' }]),
    ),
  );
}

function fixture() {
  return {
    schemaVersion: 1,
    capturedAt: '2026-08-16',
    toolchains: [
      { name: 'Node.js', required: '24.19.0', observed: '24.14.1', state: 'mismatch' },
      { name: 'Rust', required: '1.88.0', observed: '1.97.1', state: 'mismatch' },
    ],
    releaseAssets: [
      { platform: 'Windows', architectures: 'x64, i686, arm64', formats: 'NSIS installer, MSI installer, portable ZIP' },
      { platform: 'Linux', architectures: 'x64, arm64', formats: 'AppImage, deb, rpm, portable tar.gz' },
    ],
    dataPaths: [
      { platform: 'Windows', purpose: 'App data', path: '%APPDATA%\\org.yaqmc.desktop', state: 'source-verified' },
      { platform: 'Linux', purpose: 'App data', path: '~/.local/share/org.yaqmc.desktop', state: 'source-verified' },
    ],
    settingKeys: ['ui-preferences-v1', 'lyrics-surface-geometry:desktop', 'lyrics-surface-geometry:island'],
    keyring: { service: 'org.yaqmc.desktop', entries: ['qqmusic-session', 'qqmusic-session-staging', 'local-api-bearer-token'] },
    runtimeFacts: { registeredTauriCommands: 117, mainWindow: '1280×800 (minimum 1000×680)' },
    measurements: pendingMeasurements(),
  };
}

function runBaseline(snapshot) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-perf-baseline-'));
  const inputPath = path.join(directory, 'snapshot.json');
  const outputPath = path.join(directory, 'perf-baseline.md');
  writeFileSync(inputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  const result = spawnSync(process.execPath, [baselineScript, '--input', inputPath, '--output', outputPath], {
    encoding: 'utf8',
  });
  return { ...result, outputPath };
}

test('writes a deterministic baseline with pending manual measurements instead of invented values', () => {
  const result = runBaseline(fixture());

  assert.equal(result.status, 0, result.stderr);
  const output = readFileSync(result.outputPath, 'utf8');
  assert.match(output, /Node\.js \| 24\.19\.0 \| 24\.14\.1 \| MISMATCH/);
  assert.match(output, /Cold start to interactive \(3 runs, median\).*PENDING — manual measurement required/);
  assert.match(output, /Seek round-trip p95.*PENDING — manual measurement required/);
  assert.match(output, /Installer size.*PENDING — manual measurement required/);
  assert.match(output, /%APPDATA%\\org\.yaqmc\.desktop/);
  assert.match(output, /lyrics-surface-geometry:desktop/);
  assert.match(output, /qqmusic-session-staging/);
  assert.match(output, /NSIS installer, MSI installer, portable ZIP/);
  assert.match(output, /Registered Tauri commands \| 117/);
  assert.match(output, /1280×800 \(minimum 1000×680\)/);
});

test('rejects snapshots that omit a required measurement instead of substituting a value', () => {
  const snapshot = fixture();
  delete snapshot.measurements['Linux:seekRoundTripP95Ms'];
  const result = runBaseline(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Linux:seekRoundTripP95Ms/);
});
