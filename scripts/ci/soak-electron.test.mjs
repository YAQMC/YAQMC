import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_SOAK_SECONDS,
  MAINTAINER_FOUR_HOUR_SECONDS,
  runSoak,
  soakSeconds,
} from '../soak-electron.mjs';

test('YAQMC_SOAK_SECONDS defaults to 10 and documents 14400 for the 4-h run', () => {
  assert.equal(soakSeconds({}), DEFAULT_SOAK_SECONDS);
  assert.equal(soakSeconds({ YAQMC_SOAK_SECONDS: '' }), DEFAULT_SOAK_SECONDS);
  assert.equal(soakSeconds({ YAQMC_SOAK_SECONDS: '14400' }), MAINTAINER_FOUR_HOUR_SECONDS);
  assert.equal(DEFAULT_SOAK_SECONDS, 10);
  assert.equal(MAINTAINER_FOUR_HOUR_SECONDS, 14_400);
});

test('fake-provider soak writes a tiny JSON report without a 4-h run', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-soak-'));
  const reportPath = path.join(dir, 'soak-last.json');
  const { report } = await runSoak({
    durationSeconds: 0,
    intervalMs: 0,
    reportPath,
    now: () => new Date('2026-08-17T12:00:00.000Z'),
  });
  const written = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.id, 'SOAK-01');
  assert.equal(report.provider, 'fake');
  assert.equal(report.status, 'completed');
  assert.equal(report.durationSeconds, 0);
  assert.ok(report.ticks >= 1);
  assert.equal(typeof report.rss.startBytes, 'number');
  assert.equal(typeof report.rss.endBytes, 'number');
  assert.equal(written.player.revisionStall, false);
  assert.equal(written.Windows, undefined);
});
