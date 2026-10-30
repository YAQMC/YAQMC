import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAndroidReleaseTag, rootVersion } from './ci/android-version.mjs';
import { syncVersions } from './sync-version.mjs';

export function checkLocalRelease({ root, commit, tag, run = execFileSync }) {
  const git = (args) =>
    run('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const head = git(['rev-parse', '--verify', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(head) || (commit && commit !== head))
    throw new Error('Requested release commit must match the checked-out HEAD.');
  if (git(['status', '--porcelain=v1', '--untracked-files=no']))
    throw new Error('Commit tracked source changes before checking a release.');
  const { versionName } = rootVersion(root);
  if (tag) assertAndroidReleaseTag(versionName, tag);
  syncVersions({ repoRoot: root, check: true });
  // These inputs are deliberately private and must never be supplied to Actions.
  for (const file of [
    'docs/release/provenance-ledger.json',
    'docs/release/provider-readiness.json',
  ])
    readFileSync(path.join(root, file));
  for (const args of [
    ['scripts/validate-provenance-ledger.mjs', '--enforce'],
    ['scripts/ci/p14c-readiness.mjs', '--enforce'],
  ]) {
    run(process.execPath, args, { cwd: root, stdio: 'inherit' });
  }
  if (
    git(['rev-parse', 'HEAD']) !== head ||
    git(['status', '--porcelain=v1', '--untracked-files=no'])
  )
    throw new Error('Source changed while checking the release; repeat validation.');
  return { commit: head, tag: `v${versionName}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length % 2 ||
      args.some((value, index) => index % 2 === 0 && !['--commit', '--tag'].includes(value))
    )
      throw new Error(
        'Usage: npm run release:check:local -- [--commit <SHA>] [--tag <version-tag>]',
      );
    const options = Object.fromEntries(
      args.reduce(
        (pairs, value, index) =>
          index % 2 ? pairs : [...pairs, [value.slice(2), args[index + 1]]],
        [],
      ),
    );
    const result = checkLocalRelease({ root: path.resolve(import.meta.dirname, '..'), ...options });
    process.stdout.write(
      `Private release checks passed locally: ${result.tag} ${result.commit}\nApprove only the matching release-signing deployment. No tag, push or publication was performed.\n`,
    );
  } catch (error) {
    process.stderr.write(`Local release checks failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
