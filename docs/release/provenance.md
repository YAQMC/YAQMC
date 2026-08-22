# Source provenance

Status: **PASS** for the YAQMC in-tree provenance ledger. The linked
`qm-api-rs` dependency has a separate review at the exact production pin.
This page is an evidence inventory and release gate, not legal advice.

The authoritative machine-readable record is
[provenance-ledger.json](provenance-ledger.json). Run:

```text
npm run provenance:enforce
```

The validator requires immutable source revisions, applicable license or
authorization evidence, target mappings, contributor-rights evidence, and
asset provenance. It validates the structure of those references; human review
must still establish that each reference exists and supports the recorded
claim.

The ledger covers the YAQMC Git history and root import, named contributors,
branding and generated asset groups, current third-party notices, and sources
that contributed in-tree behavior. It records a frozen in-tree audit snapshot
plus the current linked dependency overlay.

Maintainer approvals cover only rights each maintainer controls. Third-party
notices remain governed by [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md),
and linked distribution must also satisfy the
[corresponding-source policy](../../CORRESPONDING_SOURCE_POLICY.md) and the
[qm-api-rs provenance record](qm-api-rs-provenance.md).
