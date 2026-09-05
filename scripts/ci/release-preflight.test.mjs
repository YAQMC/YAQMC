import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { releasePreflight } from './release-preflight.mjs';

const credentials = {
  ANDROID_RELEASE_KEYSTORE_BASE64: 'fixture',
  ANDROID_RELEASE_KEY_ALIAS: 'fixture',
  ANDROID_RELEASE_STORE_PASSWORD: 'fixture',
  ANDROID_RELEASE_KEY_PASSWORD: 'fixture',
  ANDROID_RELEASE_CERT_SHA256: 'ab'.repeat(32),
  WIN_CSC_LINK: 'fixture',
  WIN_CSC_KEY_PASSWORD: 'fixture',
  YAQMC_WINDOWS_SIGNER_SUBJECT: 'fixture',
};

test('preflight requires both Android and Windows secrets for a full release', () => {
  assert.deepEqual(releasePreflight(credentials, '0.1.0'), {
    targets: 'all',
    version: '0.1.0',
    tagged: false,
  });
  for (const name of Object.keys(credentials)) {
    assert.throws(
      () => releasePreflight({ ...credentials, [name]: ' ' }, '0.1.0'),
      (error) => error.message.includes(name) && !error.message.includes('fixture'),
    );
  }
});

test('a Linux-only rehearsal still includes Android but does not require Windows signing', () => {
  const android = Object.fromEntries(
    Object.entries(credentials).filter(([key]) => key.startsWith('ANDROID_')),
  );
  assert.equal(releasePreflight({ ...android, YAQMC_TARGETS: 'linux' }, '0.1.0').targets, 'linux');
  assert.throws(
    () => releasePreflight({ ...android, YAQMC_TARGETS: 'windows' }, '0.1.0'),
    /WIN_CSC_LINK/u,
  );
});

test('rejects invalid fingerprints, tags and incomplete tagged releases without printing values', () => {
  assert.throws(
    () =>
      releasePreflight({ ...credentials, ANDROID_RELEASE_CERT_SHA256: 'private-value' }, '0.1.0'),
    (error) => error.message.includes('fingerprint') && !error.message.includes('private-value'),
  );
  const tagged = { ...credentials, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.1.0' };
  assert.equal(releasePreflight(tagged, '0.1.0').tagged, true);
  assert.throws(() => releasePreflight(tagged, '0.2.0'), /canonical version/u);
  assert.throws(
    () => releasePreflight({ ...tagged, YAQMC_TARGETS: 'linux' }, '0.1.0'),
    /every platform/u,
  );
  assert.throws(
    () => releasePreflight({ ...credentials, YAQMC_TARGETS: 'unknown' }, '0.1.0'),
    /Invalid release targets/u,
  );
});

test('release preflight gates heavy jobs and stable publication follows asset assembly', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/electron-release.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /release-gates:[\s\S]*?environment: release-signing/u);
  assert.match(workflow, /node scripts\/ci\/release-preflight.mjs/u);
  assert.match(workflow, /gh release edit "\$tag" --draft=false --prerelease=false --latest/u);
  assert.match(workflow, /needs: \[assemble\]/u);
});
