import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { releasePreflight } from './release-preflight.mjs';
const { load } = createRequire(import.meta.url)('js-yaml');

const credentials = {
  ANDROID_RELEASE_KEYSTORE_BASE64: 'fixture',
  ANDROID_RELEASE_KEY_ALIAS: 'fixture',
  ANDROID_RELEASE_STORE_PASSWORD: 'fixture',
  ANDROID_RELEASE_KEY_PASSWORD: 'fixture',
  ANDROID_RELEASE_CERT_SHA256: 'ab'.repeat(32),
};

test('preflight requires Android secrets but allows unsigned Windows for a full release', () => {
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
  assert.equal(
    releasePreflight({ ...android, YAQMC_TARGETS: 'windows' }, '0.1.0').targets,
    'windows',
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

test('every release build and publication waits for protected review without receiving private records', () => {
  const workflow = load(
    readFileSync(new URL('../../.github/workflows/electron-release.yml', import.meta.url), 'utf8'),
  );
  const jobs = workflow.jobs;
  assert.equal(jobs['release-policy'].environment, undefined);
  assert.equal(jobs['release-policy'].permissions.actions, 'read');
  assert.deepEqual(jobs['release-gates'].needs, ['release-policy']);
  assert.equal(jobs['release-gates'].environment, 'release-signing');
  const waitsForReview = (name) =>
    name === 'release-gates' || (jobs[name].needs ?? []).some(waitsForReview);
  for (const name of [
    'frontend-build',
    'android-package',
    'electron-package',
    'assemble',
    'github-release-draft',
  ])
    assert.equal(waitsForReview(name), true, name);
  for (const job of Object.values(jobs)) {
    for (const step of job.steps ?? [])
      assert.doesNotMatch(
        step.run ?? '',
        /(?:provider|provenance):enforce|docs\/release\/(?:provider-readiness|provenance-ledger)/u,
      );
  }
});

test('manual tag builds keep their version tag and opt into publication while branches stay drafts', () => {
  const workflow = load(
    readFileSync(new URL('../../.github/workflows/electron-release.yml', import.meta.url), 'utf8'),
  );
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.type, 'boolean');
  assert.equal(workflow.on.workflow_dispatch.inputs.private_gates_confirmed.default, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.private_gates_confirmed.type, 'boolean');
  const publish = workflow.jobs['github-release-draft'].steps.find(
    (step) => step.name === 'Create draft GitHub Release',
  );
  assert.match(
    publish.env.YAQMC_PUBLISH,
    /github.event_name == 'push' \|\| inputs.publish == true/u,
  );
  assert.match(
    publish.run,
    /if \[ "\$GITHUB_REF_TYPE" = "tag" \]; then\s+tag="\$\{GITHUB_REF_NAME\}"/u,
  );
  assert.match(publish.run, /"\$GITHUB_REF_TYPE" == "tag" && "\$YAQMC_PUBLISH" == "true"/u);
  assert.match(publish.run, /--draft=false --prerelease=true --latest=false/u);
  assert.doesNotMatch(publish.run, /--clobber|--generate-notes/u);
});
