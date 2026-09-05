import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANDROID_APPLICATION_ID,
  androidArtifactName,
  stageAndroidRelease,
} from './stage-android-release.mjs';

test('stages a revision-bound arm64 APK with checksums and public metadata', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-android-release-'));
  const apk = path.join(root, 'app-release.apk');
  const destination = path.join(root, 'staged');
  writeFileSync(apk, 'signed-apk-fixture');

  const result = stageAndroidRelease({
    apkPath: apk,
    destination,
    version: '0.1.0-beta.7',
    commit: 'a'.repeat(40),
  });

  assert.equal(result.name, 'YAQMC-android-arm64-v8a-v0.1.0-beta.7.apk');
  assert.equal(readFileSync(result.stagedApk, 'utf8'), 'signed-apk-fixture');
  const expected = createHash('sha256').update('signed-apk-fixture').digest('hex');
  assert.equal(
    readFileSync(path.join(destination, 'SHA256SUMS-android.txt'), 'utf8'),
    `${expected}  ${result.name}\n`,
  );
  const identity = JSON.parse(
    readFileSync(path.join(destination, 'BUILD-IDENTITY-ANDROID.json'), 'utf8'),
  );
  assert.equal(identity.schemaVersion, 1);
  assert.equal(identity.applicationId, ANDROID_APPLICATION_ID);
  assert.equal(identity.versionCode, 1_002_007);
  assert.equal(identity.commit, 'a'.repeat(40));
  assert.equal(identity.abi, 'arm64-v8a');
  assert.match(
    readFileSync(path.join(destination, 'RELEASE-NOTES-ANDROID.md'), 'utf8'),
    /Android 8\.0/,
  );
});

test('rejects missing artifacts, invalid versions, and abbreviated revisions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-android-release-invalid-'));
  assert.throws(
    () =>
      stageAndroidRelease({
        apkPath: path.join(root, 'missing.apk'),
        destination: path.join(root, 'out'),
        version: '0.1.0',
        commit: 'b'.repeat(40),
      }),
    /does not exist/,
  );
  writeFileSync(path.join(root, 'app.apk'), 'apk');
  assert.throws(
    () =>
      stageAndroidRelease({
        apkPath: path.join(root, 'app.apk'),
        destination: path.join(root, 'out'),
        version: '0.1.0-dev.1',
        commit: 'b'.repeat(40),
      }),
    /Android release version/,
  );
  assert.throws(
    () =>
      stageAndroidRelease({
        apkPath: path.join(root, 'app.apk'),
        destination: path.join(root, 'out'),
        version: '0.1.0',
        commit: 'b'.repeat(12),
      }),
    /full lowercase Git SHA/,
  );
});

test('normalizes the Android public artifact name from canonical SemVer', () => {
  assert.equal(androidArtifactName('1.2.3'), 'YAQMC-android-arm64-v8a-v1.2.3.apk');
});
