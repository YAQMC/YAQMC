# Corresponding Source Policy

YAQMC binary and executable releases are distributed under GPL-3.0-or-later. For every such release, the release
manager must provide the complete corresponding source to every recipient on terms that satisfy GPLv3 section 6.
The source offering must be published with the release and retained as required by that license; private dependency
access alone is not a source offering.

Every release source manifest must identify the exact YAQMC commit, dependency revisions,
licenses and hashes of the delivered source archives. Source-provenance reviews, audit
reports and release-gate records remain private on the maintainer's machine; neither their
contents nor their hashes belong in the public manifest or archives. Run
`npm run release:check:local -- --commit <FULL_SHA> --tag <VERSION_TAG>` locally
before approving that exact commit in the protected `release-signing` environment.
Do not publish while either private enforcement gate is blocked. Delivering
complete corresponding source does not cure missing copyright permission, missing relicensing authority, or an
unresolved proprietary extraction; those remain separate release blockers.

## Required source set

The source delivery must include:

- the exact YAQMC source for the released commit;
- the exact linked `qm-api-rs` source resolved by revision
  `bab630d44901f80cae47dd0f09314950d0028e23` (or the revision recorded in that release's lockfile); and
- the preferred source form for the shipped `@applemusic-like-lyrics/core` and
  `@applemusic-like-lyrics/react` packages. Version `0.5.2` maps to upstream commit
  `fd7ec2d597daa2a66a37ca5f3214d6757ec17cfa` (`core-bundle@0.5.2`) and is licensed
  `AGPL-3.0-only`.

Include each dependency's license files, manifests, lockfiles, and build scripts, together with YAQMC's manifests,
lockfiles, and build/packaging/release scripts. The release notes or source manifest must identify the YAQMC commit,
the `qm-api-rs` revision, the AMLL version and source revision, the applicable licenses,
and hashes of all delivered archives.

Do not publish a binary release if the required corresponding source is unavailable.

The release workflow requires passing CI for the exact commit on `main` and
configured Required reviewers on `release-signing` before desktop and Android
packaging. Approval attests that the maintainer ran the private provenance and
provider-readiness gates locally on that commit. This is a human review boundary;
Actions does not receive or independently inspect the private evidence. Missing
local inputs or a failed gate prevent local approval; missing environment protection
fails the workflow. Ordinary CI tests the validators with synthetic fixtures.

The assembly job checks out the exact `qm-api-rs` and AMLL revisions with
`persist-credentials: false`, runs
`scripts/ci/corresponding-source.mjs`, and refuses to create a draft unless all
three revision-bound source archives and `CORRESPONDING-SOURCE-MANIFEST.json`
are present and hash-valid. Source generation rejects dirty YAQMC, `qm-api-rs`, or AMLL checkouts. The manifest
uses schema version 3 and records only public source identities, licenses and archive
hashes. Assembly reads ZIP entries back, rejects private report paths, and checks
the required build inputs, dependency manifests, source entry points and license entries.
Assembly also requires downloaded package artifact directories to carry the
same 40-character YAQMC commit as the source manifest and recomputes every
file hash declared by their platform-specific build identity. The archive step
uses `git archive`, so checkout metadata and authentication configuration are
never included. A lockfile entry or link to an upstream repository is not a replacement for conveying the required
corresponding source.
