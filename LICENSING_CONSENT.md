# GPL-3.0-or-later licensing consent and provenance record

## Scope

This record covers YAQMC's GPL-3.0-or-later adoption, repository LICENSE, package/crate metadata, corresponding-source
policy, and every contribution or imported asset distributed with the work. It is a release and P14 integration gate;
it is not proof that any person has approved, owns, or may relicense any contribution.

## Full rights audit requirement

A GPL license decision cannot be cleared by two maintainer approvals alone. Each independently copyrightable
contribution, imported code path, generated output, and binary asset needs one of:

- immutable license and source evidence establishing the required distribution rights;
- explicit contributor/relicensing authorization from a person who controls those rights; or
- a documented independent rewrite or removal.

Unknown origin, NOASSERTION, missing immutable revision, incomplete target mapping, pending consent, and proprietary
extraction without authorization are release blockers. Corresponding-source delivery is necessary where GPL applies,
but it does not cure missing copyright permission.

The complete audit state is in
[docs/migration/provenance-ledger.json](docs/migration/provenance-ledger.json) and
[docs/migration/provenance-audit.md](docs/migration/provenance-audit.md).
The typed maintainer-approval digest is
[docs/migration/licensing-consent-record.json](docs/migration/licensing-consent-record.json).

This YAQMC-tree record does **not** authorize a Cargo link of the private `qm-api-rs` (`qqmusic-api`) crate.

## Maintainer records

The entries below remain required evidence for rights the named maintainers actually control. They do **not** by
themselves clear external MIT notices or unlinked private crates. Record an immutable evidence reference (for example, a
signed commit or GitHub issue/PR comment URL) and date beside each approval.

| Required approver | Status   | Evidence reference                                                        | Recorded date | Limited scope                               |
| ----------------- | -------- | ------------------------------------------------------------------------- | ------------- | ------------------------------------------- |
| Mai-xiyu          | approved | `sha256:92e5f1990f8b36992da9de37667492ef6807912aa8a55ec6edc30556382c178b` | 2026-08-21    | Only rights actually controlled by Mai-xiyu |
| Osilvfe           | approved | `sha256:92e5f1990f8b36992da9de37667492ef6807912aa8a55ec6edc30556382c178b` | 2026-08-21    | Only rights actually controlled by Osilvfe  |

## Current status

**In-tree ledger: pass.** `npm run provenance:enforce` is the machine check for this tree. Unused names that were
previously recorded as ports (miaosic, `mzj3920/qqmusic-decrypt`, official QQ Music Electron ASAR, and the unlinked
`qm-api-rs` crate) are out of this ledger. QMCDecode remains as an independent MIT adaptation with file/range
mappings in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
