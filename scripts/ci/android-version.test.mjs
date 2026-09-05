import assert from 'node:assert/strict';
import test from 'node:test';

import { androidVersion, assertAndroidReleaseTag } from './android-version.mjs';

test('maps stable and prerelease SemVer values to monotonically ordered Android codes', () => {
  const alpha = androidVersion('0.1.0-alpha.12');
  const beta = androidVersion('0.1.0-beta.6');
  const rc = androidVersion('0.1.0-rc.1');
  const stable = androidVersion('0.1.0');
  const patch = androidVersion('0.1.1-alpha.1');

  assert.equal(beta.versionName, '0.1.0-beta.6');
  assert.equal(beta.versionCode, 1_002_006);
  assert.ok(alpha.versionCode < beta.versionCode);
  assert.ok(beta.versionCode < rc.versionCode);
  assert.ok(rc.versionCode < stable.versionCode);
  assert.ok(stable.versionCode < patch.versionCode);
});

test('rejects formats and components that cannot be encoded safely', () => {
  for (const version of [
    'v1.2.3',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-beta.01',
    '1.2',
    '1.2.3-preview.1',
    '1.2.3-beta',
    '1.2.3+build',
    '21.0.0',
    '1.100.0',
    '1.0.100',
    '1.0.0-beta.1000',
  ]) {
    assert.throws(() => androidVersion(version), /Android/);
  }
});

test('requires the Git tag to exactly match the canonical version', () => {
  assert.equal(assertAndroidReleaseTag('0.1.0-beta.7', 'v0.1.0-beta.7'), 'v0.1.0-beta.7');
  assert.throws(
    () => assertAndroidReleaseTag('0.1.0-beta.7', 'v0.1.0'),
    /does not match canonical version/,
  );
});
