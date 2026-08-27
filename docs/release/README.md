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

The release workflow packages the exact YAQMC and `qm-api-rs` revisions as
corresponding-source archives. See
[CORRESPONDING_SOURCE_POLICY.md](../../CORRESPONDING_SOURCE_POLICY.md) and
[CI documentation](../ci.md) for commands and artifact rules.

Electron packages also include the AGPL-licensed AMLL dependency. The current
workflow does not yet attach its exact preferred-source archive, so generated
Electron drafts must not be published until that requirement is automated and
verified.
