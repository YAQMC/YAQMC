# Corresponding Source Policy

YAQMC binary and executable releases are distributed under GPL-3.0-or-later. For every such release, the release
manager must provide the complete corresponding source to every recipient on terms that satisfy GPLv3 section 6.
The source offering must be published with the release and retained as required by that license; private dependency
access alone is not a source offering.

Every release source manifest must identify the exact YAQMC commit, the SHA-256 digest of
`docs/release/provenance-ledger.json`, the accompanying provenance evidence references, and the result of
`node scripts/validate-provenance-ledger.mjs --enforce`. Do not publish while that enforcement is blocked. Delivering
complete corresponding source does not cure missing copyright permission, missing relicensing authority, or an
unresolved proprietary extraction; those remain separate release blockers.

## Required source set

The source delivery must include:

- the exact YAQMC source for the released commit;
- the exact linked `qm-api-rs` source resolved by revision
  `006d149e59250122e77019e34a1a48340b20a1c3` (or the revision recorded in that release's lockfile); and
- the preferred source form for the shipped `@applemusic-like-lyrics/core` and
  `@applemusic-like-lyrics/react` packages. Version `0.5.2` maps to upstream commit
  `fd7ec2d597daa2a66a37ca5f3214d6757ec17cfa` (`core-bundle@0.5.2`) and is licensed
  `AGPL-3.0-only`.

Include each dependency's license files, manifests, lockfiles, and build scripts, together with YAQMC's manifests,
lockfiles, and build/packaging/release scripts. The release notes or source manifest must identify the YAQMC commit,
the `qm-api-rs` revision, the AMLL version and source revision, the provenance-ledger SHA-256 digest, evidence
references, and hashes of all delivered archives.

Do not publish a binary release if the required corresponding source is unavailable.

The Electron release workflow enforces provider readiness and provenance before
packaging. Its assembly job checks out the exact `qm-api-rs` and AMLL revisions with
`persist-credentials: false`, runs
`scripts/ci/corresponding-source.mjs`, and refuses to create a draft unless all
three revision-bound source archives and `CORRESPONDING-SOURCE-MANIFEST.json`
are present and hash-valid. Source generation rejects dirty YAQMC, `qm-api-rs`, or AMLL checkouts. The manifest
records and validates both AMLL package manifests and hashes the provider readiness record,
provenance ledger, and provenance evidence exactly as stored in the YAQMC
archive; assembly reads those ZIP entries back, verifies their hashes and
release decisions, and checks every dependency manifest, source entry point, and license entry.
Assembly also requires downloaded package artifact directories to carry the
same 40-character YAQMC commit as the source manifest and recomputes every
file hash declared by their platform-specific build identity. The archive step
uses `git archive`, so checkout metadata and authentication configuration are
never included. A lockfile entry or link to an upstream repository is not a replacement for conveying the required
corresponding source.
