# Release and compliance records

This directory contains the small set of records required to review and
reproduce a YAQMC release. It is not a project diary or a migration archive.

- [Provider readiness](provider-readiness.md) documents the production QQ Music
  provider boundary, the exact dependency pin, and the maintainer soak waiver.
- [YAQMC provenance](provenance.md) explains the in-tree provenance gate and
  links its machine-readable [ledger](provenance-ledger.json).
- [qm-api-rs provenance](qm-api-rs-provenance.md) records the separately
  reviewed linked dependency.
- [Licensing consent record](licensing-consent-record.json) mirrors the
  maintainer approvals described in [LICENSING_CONSENT.md](../../LICENSING_CONSENT.md).

The release workflow packages the exact YAQMC, `qm-api-rs`, and AMLL revisions as
corresponding-source archives. See
[CORRESPONDING_SOURCE_POLICY.md](../../CORRESPONDING_SOURCE_POLICY.md) and
[CI documentation](../ci.md) for commands and artifact rules.

Electron packages include the AGPL-licensed AMLL dependency. Assembly verifies its exact preferred-source archive,
package manifests, license, revision, and hash before a draft can be created.
