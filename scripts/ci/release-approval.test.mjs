import assert from 'node:assert/strict';
import test from 'node:test';
import { checkReleaseApproval, validateReleaseApproval } from './release-approval.mjs';
const commit = 'a'.repeat(40);
const protectedEnvironment = {
  name: 'release-signing',
  protection_rules: [
    { type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] },
  ],
};
const success = {
  head_sha: commit,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
};
test('requires protected release approval and successful CI for the exact main commit', () => {
  assert.doesNotThrow(() =>
    validateReleaseApproval(protectedEnvironment, { workflow_runs: [success] }, commit),
  );
  for (const protection_rules of [[], [{ type: 'required_reviewers', reviewers: [] }]]) {
    assert.throws(
      () =>
        validateReleaseApproval(
          { ...protectedEnvironment, protection_rules },
          { workflow_runs: [success] },
          commit,
        ),
      /Required reviewers/u,
    );
  }
  for (const patch of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'branch' },
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { event: 'pull_request' },
  ]) {
    assert.throws(
      () =>
        validateReleaseApproval(
          protectedEnvironment,
          { workflow_runs: [{ ...success, ...patch }] },
          commit,
        ),
      /CI run/u,
    );
  }
  assert.throws(
    () =>
      validateReleaseApproval(
        protectedEnvironment,
        {
          workflow_runs: [
            { ...success, run_number: 10 },
            { ...success, run_number: 11, conclusion: 'failure' },
          ],
        },
        commit,
      ),
    /CI run/u,
  );
  assert.doesNotThrow(() =>
    validateReleaseApproval(
      protectedEnvironment,
      {
        workflow_runs: [
          { ...success, run_number: 11 },
          { ...success, run_number: 10, conclusion: 'failure' },
        ],
      },
      commit,
    ),
  );
});
test('fails closed on unavailable GitHub policy without exposing credentials', async () => {
  const env = { GITHUB_REPOSITORY: 'YAQMC/YAQMC', GITHUB_SHA: commit, GH_TOKEN: 'synthetic-token' };
  await assert.rejects(
    checkReleaseApproval(env, async () => new globalThis.Response('{}', { status: 403 })),
    (error) => /HTTP 403/u.test(error.message) && !error.message.includes(env.GH_TOKEN),
  );
  await assert.rejects(
    checkReleaseApproval({ ...env, GITHUB_REPOSITORY: 'fork/project' }),
    /official repository/u,
  );
  const requested = [];
  await checkReleaseApproval(env, async (url) => {
    requested.push(url);
    return new globalThis.Response(
      JSON.stringify(
        url.includes('/environments/') ? protectedEnvironment : { workflow_runs: [success] },
      ),
    );
  });
  assert.equal(requested.length, 2);
});

test('requires a local private-gate attestation before publishing a tagged release', async () => {
  const env = {
    GITHUB_REPOSITORY: 'YAQMC/YAQMC',
    GITHUB_SHA: commit,
    GITHUB_REF_TYPE: 'tag',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    YAQMC_PUBLISH: 'true',
    GH_TOKEN: 'synthetic-token',
  };
  const fetcher = async (url) =>
    new globalThis.Response(
      JSON.stringify(
        url.includes('/environments/') ? protectedEnvironment : { workflow_runs: [success] },
      ),
    );
  await assert.rejects(checkReleaseApproval(env, fetcher), /YAQMC_PRIVATE_GATES_CONFIRMED=true/u);
  await assert.doesNotReject(
    checkReleaseApproval({ ...env, YAQMC_PRIVATE_GATES_CONFIRMED: 'true' }, fetcher),
  );
});
