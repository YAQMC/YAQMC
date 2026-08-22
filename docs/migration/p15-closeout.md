# P15 cleanup closeout

Status: **IMPLEMENTATION CANDIDATE; PHASE NOT COMPLETE**.

P15 source and documentation cleanup is prepared on
`feat/electron-migration`. Final acceptance, GitHub issue filing, and the final
tag remain separate gates and are not claimed by this record.

## Task state

| Task     | State                 | Evidence / remaining action                                                                                                                                                                                                                       |
| -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLEAN-01 | IMPLEMENTED-CANDIDATE | Current public architecture, development, CI, logging, deep-link, Linux, support, and data-location guidance is linked from the documentation indexes. Terra/manual review and Pages CI remain required.                                          |
| CLEAN-02 | BLOCKED-AUTH          | Five bounded drafts are in [`follow-up-issues.md`](follow-up-issues.md). File them with an authorized GitHub identity and record real URLs; none are fabricated here.                                                                             |
| CLEAN-03 | PENDING-TERRA/HUMAN   | [`acceptance-final.md`](acceptance-final.md) is 0/20 signed. Run the final clean-clone, CI, Windows, Linux, packaged-app, LIVE, soak, and HUMAN matrix against one pushed SHA.                                                                    |
| CLEAN-04 | IMPLEMENTED-CANDIDATE | `CONTRIBUTING*`, `README*`, [`development.md`](../development.md), and [`data-locations.md`](../data-locations.md) cover the exact toolchains, private dependency access, build, data retention, and uninstall behavior. Review remains required. |
| CLEAN-05 | BLOCKED-CLEAN-03      | Migration evidence is promoted as a retained historical archive. Do not create `electron-migration-complete` until CLEAN-03 is 20/20 and §47 is signed.                                                                                           |

## Archive policy

`docs/migration/` is retained because it contains immutable phase evidence,
waivers, provenance decisions, soak records, and command history needed for
audit and rollback. It is not the contributor-facing source of current setup
or runtime guidance. Historical files receive P15 overlays where their old
instructions could be mistaken for current behavior; current guidance lives
in the public bilingual documentation.

Generated release output and private source checkouts remain ignored under
`corresponding-source/` and `.corresponding-source/`; they are produced only by
the release job. Linux x64 package jobs separately produce a flat,
identity-verified tester artifact so the documented no-checkout acceptance
procedure has a real producer. The retired `src-tauri` tree and executable
Tauri setup are absent. Historical prose and test fixtures remain only under
the maintained allowlist in
[`p13-static-allowlist.md`](p13-static-allowlist.md).

## Decision

- P14-C implementation gate: ready to be independently rechecked.
- P15 implementation cleanup: ready to be independently rechecked.
- HUMAN final acceptance: **NO**.
- Final completion tag: **NOT AUTHORIZED**.
