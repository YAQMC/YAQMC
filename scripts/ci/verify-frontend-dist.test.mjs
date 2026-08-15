import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyFrontendDist } from './verify-frontend-dist.mjs';
import { frontendBuildInfoPath } from './write-frontend-build-info.mjs';

test('prebuilt frontend provenance must match the current commit', () => {
  const distDir = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-dist-'));
  mkdirSync(distDir, { recursive: true });
  writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>');
  assert.throws(() => verifyFrontendDist(distDir), /provenance sidecar/);
  writeFileSync(
    frontendBuildInfoPath(distDir),
    `${JSON.stringify({ schemaVersion: 1, gitSha: '0'.repeat(40), builtAt: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`,
  );
  assert.throws(() => verifyFrontendDist(distDir), /does not match current commit/);
});
