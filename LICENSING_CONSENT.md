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

The complete audit state and blocker inventory are in
[docs/migration/provenance-ledger.json](docs/migration/provenance-ledger.json) and
[docs/migration/provenance-audit.md](docs/migration/provenance-audit.md).

## Maintainer records

The entries below remain required evidence for rights the named maintainers actually control. They do **not** by
themselves clear external contributors, unattributed imports, upstream ports, assets, or proprietary-client material.
Record an immutable evidence reference (for example, a signed commit or GitHub issue/PR comment URL) and date beside
each approval.

| Required approver | Status  | Evidence reference | Recorded date | Limited scope                               |
| ----------------- | ------- | ------------------ | ------------- | ------------------------------------------- |
| Mai-xiyu          | Pending | None               | Not recorded  | Only rights actually controlled by Mai-xiyu |
| Osilvfe           | Pending | None               | Not recorded  | Only rights actually controlled by Osilvfe  |

## Current status

**Blocked: do not distribute a release or integrate P14 until the full provenance ledger passes enforcement.** No
maintainer approval has been recorded, and an approval would not resolve the independent blockers recorded in the
ledger.
