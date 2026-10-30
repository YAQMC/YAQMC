# Release requirements

Audit reports, source-provenance reviews and release-gate records remain on the
maintainer's machine. They are ignored by Git and must not be committed or pushed,
including through earlier unpublished commits. Public release instructions and
the license and copyright records remain in the repository.

Provenance, provider-readiness and corresponding-source checks remain mandatory.
Private inputs retain their local `docs/release/` paths. On a clean checkout of
the exact release commit, run:

```sh
npm run release:check:local -- --commit <FULL_SHA> --tag <VERSION_TAG>
```

Missing private inputs or a blocked gate stop this command; absence does not
grant approval or waive a soak. Never copy actual reports into test fixtures,
Actions artifacts, GitHub secrets, release notes or source archives. Ordinary CI
tests the validators using synthetic data.

In GitHub **Settings → Environments → release-signing**, configure **Required
reviewers**. Before approving a deployment, its reviewer must run the local
command above for that deployment's exact SHA and check that it passed. The
workflow verifies this protection exists and that the latest CI for that SHA on
`main` passed; GitHub then waits for review. Approval is a maintainer attestation,
not cloud-side verification of the private reports. A solo maintainer may be the
reviewer with self-review allowed; enable prevention of self-review when a
separate release reviewer is available.

The public schema-v3 source manifest contains source identities, licenses and
archive hashes. The source packager excludes private report paths, and assembly
rejects any such files that remain. See the CI guide for beta/nightly publication.

- [Licensing consent](../../LICENSING_CONSENT.md) and its machine-readable
  [consent record](licensing-consent-record.json) preserve the recorded approvals.
- [Third-party notices](../../THIRD_PARTY_NOTICES.md) preserve applicable copyright
  statements and license notices.
- [Corresponding-source policy](../../CORRESPONDING_SOURCE_POLICY.md) specifies the
  exact source and license set required for a binary distribution.
- [CI documentation](../ci.md) describes the build and packaging commands.
