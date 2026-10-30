import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateReleaseCommits } from './release-commits.mjs';
import { writeAppUpdateMetadata } from './app-update-metadata.mjs';
import { officialBuildIdentity } from '../../apps/desktop/scripts/build-identity.mjs';
function repository() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-commits-'));
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  const commit = (subject) => {
    git(['commit', '--allow-empty', '-qm', subject]);
    return git(['rev-parse', 'HEAD']);
  };
  commit('initial');
  git(['tag', 'v1.0.0']);
  commit('beta <script> & [link]');
  git(['tag', 'v1.1.0-beta.1']);
  const head = commit('hotfix');
  return { cwd, head };
}
const published = [
  { tag_name: 'v1.0.0', draft: false, prerelease: false },
  { tag_name: 'v1.1.0-beta.1', draft: false, prerelease: true },
];
test('stable and prerelease notes choose the correct published ancestor and escape titles', () => {
  const { cwd, head } = repository();
  const stable = generateReleaseCommits({ cwd, commit: head, tag: 'v1.1.0', published });
  assert.equal(stable.base, 'v1.0.0');
  assert.match(stable.body, /&lt;script&gt; &amp; \\\[link\\\]/u);
  assert.match(stable.body, /hotfix/u);
  assert.doesNotMatch(stable.body, /initial/u);
  const beta = generateReleaseCommits({ cwd, commit: head, tag: 'v1.1.0-beta.2', published });
  assert.equal(beta.base, 'v1.1.0-beta.1');
  assert.doesNotMatch(beta.body, /script/u);
  const first = generateReleaseCommits({ cwd, commit: head, tag: 'v1.1.0', published: [] });
  assert.match(first.body, /initial/u);
  const short = generateReleaseCommits({
    cwd,
    commit: head,
    tag: 'v1.1.0',
    published: [],
    limit: 350,
  });
  assert.equal(short.truncated, true);
  assert.match(short.body, /COMMITS.md/u);
  assert.match(short.full, /initial/u);
});
test('only the official tagged workflow creates self-updating build identity', () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'YAQMC/YAQMC',
    GITHUB_WORKFLOW: 'YAQMC release',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: 'v1.0.0',
    YAQMC_PACKAGE_ARCH: 'arm64',
  };
  assert.equal(officialBuildIdentity(env, '1.0.0').source, 'official-release');
  assert.equal(
    officialBuildIdentity({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, '1.0.0').source,
    'official-release',
  );
  for (const patch of [
    { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch' },
    { GITHUB_REPOSITORY: 'fork/YAQMC' },
    { GITHUB_REF_TYPE: 'branch' },
    { GITHUB_REF_NAME: 'v1.0.1' },
  ])
    assert.equal(officialBuildIdentity({ ...env, ...patch }, '1.0.0').source, 'source');
  assert.equal(officialBuildIdentity({}, '1.0.0').source, 'source');
  for (const channel of ['beta', 'nightly']) {
    const version = `1.1.0-${channel}.1`;
    assert.equal(
      officialBuildIdentity(
        { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: `v${version}` },
        version,
      ).source,
      'official-release',
    );
    assert.equal(
      officialBuildIdentity(
        { ...env, GITHUB_WORKFLOW: 'Build artifacts', GITHUB_REF_NAME: `v${version}` },
        version,
      ).source,
      'source',
    );
  }
  assert.equal(
    officialBuildIdentity({ ...env, GITHUB_REF_NAME: 'v1.0.0+ci.7' }, '1.0.0+ci.7').source,
    'official-release',
  );
});

test('legal build metadata is preserved in tags and release baselines', () => {
  const { cwd, head } = repository();
  execFileSync('git', ['tag', 'v1.0.0+ci.1', 'v1.0.0'], { cwd });
  const notes = generateReleaseCommits({
    cwd,
    commit: head,
    tag: 'v1.1.0+ci.2',
    published: [{ tag_name: 'v1.0.0+ci.1', draft: false, prerelease: false }],
  });
  assert.equal(notes.base, 'v1.0.0+ci.1');
  assert.match(notes.body, /YAQMC v1\.1\.0\+ci\.2/u);
  assert.doesNotMatch(notes.body, /initial/u);
});
test('NSIS metadata binds each architecture to its full installer and SHA-512', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-updater-metadata-'));
  for (const arch of ['x64', 'arm64']) {
    const name = `YAQMC-windows-${arch}-setup.exe`;
    writeFileSync(path.join(dir, name), `fixture-${arch}`);
    const file = writeAppUpdateMetadata(dir, '2.0.0-beta.1', arch);
    const body = readFileSync(path.join(dir, file), 'utf8');
    assert.match(body, new RegExp(name));
    assert.match(body, /version: "2.0.0-beta.1"/u);
    assert.match(body, /sha512: [A-Za-z0-9+/]{86}==/u);
  }
});
