import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { repositoryRoot as defaultRepositoryRoot } from './ci/repo.mjs';

export const DEFAULT_SOAK_SECONDS = 10;
export const MAINTAINER_FOUR_HOUR_SECONDS = 14_400;

const thisFile = fileURLToPath(import.meta.url);

export function soakSeconds(env = process.env) {
  const raw = env.YAQMC_SOAK_SECONDS;
  if (raw == null || raw === '') {
    return DEFAULT_SOAK_SECONDS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`YAQMC_SOAK_SECONDS must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function defaultReportPath(repositoryRoot = defaultRepositoryRoot) {
  return path.join(repositoryRoot, 'artifacts', 'soak-last.json');
}

function rssBytes() {
  return process.memoryUsage().rss;
}

function createFakePlayer() {
  let positionMs = 0;
  let isPlaying = false;
  const durationMs = 10_000;
  return {
    snapshot() {
      return { positionMs, isPlaying, durationMs, playbackState: isPlaying ? 'playing' : 'paused' };
    },
    play() {
      isPlaying = true;
      return this.snapshot();
    },
    seek(nextPositionMs) {
      positionMs = Math.max(0, Math.min(durationMs, nextPositionMs));
      return this.snapshot();
    },
  };
}

export async function runSoak(options = {}) {
  const durationSeconds = options.durationSeconds ?? soakSeconds(options.env ?? process.env);
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  const reportPath = options.reportPath ?? defaultReportPath(repositoryRoot);
  const intervalMs =
    options.intervalMs ?? (durationSeconds >= 3_600 ? 5_000 : durationSeconds === 0 ? 0 : 200);
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const player = createFakePlayer();
  player.play();

  const rssStart = rssBytes();
  let rssPeak = rssStart;
  let ticks = 0;
  let snapshotCalls = 0;
  let seekCalls = 0;
  const errors = [];
  const deadline = Date.now() + durationSeconds * 1_000;

  while (true) {
    ticks += 1;
    try {
      const snapshot = player.snapshot();
      snapshotCalls += 1;
      const seekTo = (ticks * 1_000) % (snapshot.durationMs + 1);
      player.seek(seekTo);
      seekCalls += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    rssPeak = Math.max(rssPeak, rssBytes());
    if (Date.now() >= deadline) {
      break;
    }
    if (intervalMs > 0) {
      await delay(intervalMs);
    }
  }

  const rssEnd = rssBytes();
  const endedAt = now();
  const growthPercent = rssStart === 0 ? 0 : ((rssEnd - rssStart) / rssStart) * 100;
  const report = {
    id: 'SOAK-01',
    provider: 'fake',
    status: errors.length > 0 ? 'failed' : 'completed',
    durationSeconds,
    maintainerFourHourSeconds: MAINTAINER_FOUR_HOUR_SECONDS,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    ticks,
    rss: {
      startBytes: rssStart,
      endBytes: rssEnd,
      peakBytes: rssPeak,
      growthPercent: Number(growthPercent.toFixed(3)),
    },
    player: {
      lastPositionMs: player.snapshot().positionMs,
      snapshotCalls,
      seekCalls,
      revisionStall: false,
    },
    errors,
    notes: [
      `Default duration is ${DEFAULT_SOAK_SECONDS}s via YAQMC_SOAK_SECONDS (safe for CI/dev).`,
      `Maintainer 4-h run: YAQMC_SOAK_SECONDS=${MAINTAINER_FOUR_HOUR_SECONDS} (record the result with the platform acceptance evidence).`,
      'First 4-h report stays uncommitted (PENDING). This script does not start qm-api-rs.',
      'LIVE VERIFY real-account soak is maintainer-only and is not claimed green here.',
    ],
  };

  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { report, reportPath };
}

function invokedAsCli() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return (
    path.normalize(path.resolve(entry)).toLowerCase() === path.normalize(thisFile).toLowerCase()
  );
}

if (invokedAsCli()) {
  runSoak()
    .then(({ report, reportPath }) => {
      process.stdout.write(
        `${JSON.stringify({ reportPath, rss: report.rss, ticks: report.ticks }, null, 2)}\n`,
      );
      if (report.status !== 'completed') {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
      process.exitCode = 1;
    });
}
