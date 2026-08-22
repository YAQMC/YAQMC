# Corresponding Source Policy

YAQMC binary and executable releases are distributed under GPL-3.0-or-later. For every such release, the release
manager must provide the complete corresponding source to every recipient on terms that satisfy GPLv3 section 6.
The source offering must be published with the release and retained as required by that license; private dependency
access alone is not a source offering.

Every release source manifest must identify the exact YAQMC commit, the SHA-256 digest of
`docs/migration/provenance-ledger.json`, the accompanying provenance-audit evidence references, and the result of
`node scripts/validate-provenance-ledger.mjs --enforce`. Do not publish while that enforcement is blocked. Delivering
complete corresponding source does not cure missing copyright permission, missing relicensing authority, or an
unresolved proprietary extraction; those remain separate release blockers.

## Before P14

Until the P14 provider migration is complete, the source archive must contain the complete YAQMC source for the
exact released commit, including all tracked build, packaging, and release scripts, manifests, lockfiles, generated
source required to build, and the `LICENSE` and third-party notices.

## After P14

Once a release links the `qm-api-rs` dependency, its source delivery must additionally include the exact YAQMC
source for the released commit and the exact `qm-api-rs` source resolved by the pinned revision
`476b37e3135560dff132e9ba8996e068af706458` (or the revision recorded in that release's lockfile). Include the
dependency's license files, manifests, lockfiles, and build scripts, together with YAQMC's manifests, lockfiles, and
build/packaging/release scripts. The release notes or a source manifest must identify the YAQMC commit, the
`qm-api-rs` revision, the provenance-ledger SHA-256 digest, evidence references, and hashes of the delivered
archives.

Do not publish a binary release if the required corresponding source is unavailable.
