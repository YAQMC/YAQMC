import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateReleaseApproval(environment, runs, commit) {
  const review = environment?.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  if (
    environment?.name !== 'release-signing' ||
    !Array.isArray(review?.reviewers) ||
    !review.reviewers.length
  ) {
    throw new Error(
      'Configure Required reviewers on release-signing before releasing; review the exact commit and run release:check:local before approving.',
    );
  }
  const matching = (runs?.workflow_runs ?? [])
    .filter(
      (run) =>
        run.head_sha === commit &&
        run.head_branch === 'main' &&
        ['push', 'workflow_dispatch'].includes(run.event),
    )
    .sort(
      (left, right) =>
        Number(right.run_number ?? 0) - Number(left.run_number ?? 0) ||
        Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? ''),
    );
  const latest = matching[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
    throw new Error(
      'The latest CI run for this exact commit on main must pass before release. Push main, wait for CI, then retry.',
    );
  }
}

export async function checkReleaseApproval(env = process.env, fetcher = globalThis.fetch) {
  if (env.GITHUB_REPOSITORY !== 'YAQMC/YAQMC' || !/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? '')) {
    throw new Error('Release approval requires the official repository and a full commit SHA.');
  }
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN is required to check release protection and CI.');
  const api = async (endpoint) => {
    const response = await fetcher(`https://api.github.com/repos/YAQMC/YAQMC/${endpoint}`, {
      signal: globalThis.AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok)
      throw new Error(
        `Cannot verify release approval (GitHub HTTP ${response.status}); no release is authorized.`,
      );
    return response.json();
  };
  const [environment, runs] = await Promise.all([
    api('environments/release-signing'),
    api(`actions/workflows/ci.yml/runs?head_sha=${env.GITHUB_SHA}&per_page=30`),
  ]);
  validateReleaseApproval(environment, runs, env.GITHUB_SHA);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkReleaseApproval();
    process.stdout.write('Release environment requires review; exact-commit CI has passed.\n');
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Before approving release-signing, run \`npm run release:check:local -- --commit ${process.env.GITHUB_SHA}\` locally. Private reports stay on the maintainer machine.\n`,
      );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
