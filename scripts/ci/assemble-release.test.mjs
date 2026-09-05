import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { addAndroidReleaseAssets, RELEASE_NOTES_NAME } from './assemble-release.mjs';
import { stageAndroidRelease } from './stage-android-release.mjs';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-unified-release-'));
  const apk = path.join(root, 'app-release.apk');
  const android = path.join(root, 'android');
  const assembled = path.join(root, 'assembled');
  const commit = 'a'.repeat(40);
  writeFileSync(apk, 'signed-apk-fixture');
  stageAndroidRelease({ apkPath: apk, destination: android, version: '0.1.0', commit });
  mkdirSync(assembled);
  writeFileSync(path.join(assembled, 'YAQMC-windows-x64-setup.exe'), 'electron');
  return { android, assembled, commit };
}

test('adds a revision-bound Android APK and unified notes to assembled release assets', () => {
  const { android, assembled, commit } = fixture();
  const result = addAndroidReleaseAssets({
    sourceDir: android,
    destDir: assembled,
    expectedCommit: commit,
  });

  assert.equal(result.apkName, 'YAQMC-android-arm64-v8a-v0.1.0.apk');
  assert.equal(readFileSync(path.join(assembled, result.apkName), 'utf8'), 'signed-apk-fixture');
  const notes = readFileSync(path.join(assembled, RELEASE_NOTES_NAME), 'utf8');
  assert.match(notes, /^# YAQMC release/mu);
  assert.match(notes, /^## YAQMC desktop release/mu);
  assert.match(notes, /^## YAQMC Android 0\.1\.0/mu);
});

test('rejects Android assets with a mismatched commit or checksum', () => {
  const mismatch = fixture();
  assert.throws(
    () =>
      addAndroidReleaseAssets({
        sourceDir: mismatch.android,
        destDir: mismatch.assembled,
        expectedCommit: 'b'.repeat(40),
      }),
    /build identity does not match/u,
  );

  const tampered = fixture();
  writeFileSync(path.join(tampered.android, 'YAQMC-android-arm64-v8a-v0.1.0.apk'), 'tampered');
  assert.throws(
    () =>
      addAndroidReleaseAssets({
        sourceDir: tampered.android,
        destDir: tampered.assembled,
        expectedCommit: tampered.commit,
      }),
    /checksum does not match/u,
  );
});

test('rejects Android assets staged for a different project version', () => {
  const mismatch = fixture();
  assert.throws(
    () =>
      addAndroidReleaseAssets({
        sourceDir: mismatch.android,
        destDir: mismatch.assembled,
        expectedCommit: mismatch.commit,
        expectedVersion: '0.1.1',
      }),
    /build identity does not match/u,
  );
});
