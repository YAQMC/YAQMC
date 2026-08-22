# Copyright, contributor, and source provenance audit

Status: **PASS** for the frozen in-tree YAQMC audit snapshot identified below;
the current linked `qm-api-rs` pin is recorded as a separate dependency
overlay. This is an evidence inventory and release gate, not a legal conclusion
or a substitute for copyright permission. The machine-readable record is
[provenance-ledger.json](provenance-ledger.json); run `node scripts/validate-provenance-ledger.mjs` to reproduce the
report. `--enforce` exits zero only when the ledger is fully resolved and declares a pass decision.

The linked private `qm-api-rs` (`qqmusic-api`) has a separate crate-level PASS
record at the pinned revision. Distribution must also satisfy the corresponding-
source policy for that exact revision; this in-tree inventory is not a legal
conclusion or a substitute for copyright permission.

## Scope and method

The audit covers the YAQMC Git history, root import, identified contributors, imported/generated/binary asset groups,
current third-party notices, and named upstream sources that actually contributed in-tree behavior. Names that only
appear in the separately audited `qm-api-rs` crate, or that were recorded without a file mapping, are not in-tree sources.

A record is only release-clear when it has an immutable source revision, applicable license or authorization, a target
mapping, and a rights holder/contributor basis. A maintained `LICENSE` or a corresponding-source archive does not
repair missing copyright permission.

The validator checks evidence-reference structure only; it does not perform network, Git-signature, hash-content, or
authorization verification. A verified source needs a revision-bound `git-object:<40-hex>`,
`signed-commit:<40-hex>`, or `git-revision-url:https://.../<40-hex>/...` record. For a revision URL, the validator
requires HTTPS, the same host as `source.origin`, the same normalized repository path prefix (trailing slash and an
optional `.git` suffix are normalized), and the exact source revision as a later URL-path segment. Verified contributor
consent, asset proof, and proprietary authorization need a typed `git-object:<40-hex>`, `signed-commit:<40-hex>`,
`sha256:<64-hex>`, or `github-comment:https://github.com/<owner>/<repo>/(issues|pull)/<number>#issuecomment-<id>`
reference. Arbitrary strings and ordinary URLs are not evidence. Human review must still establish that each
well-formed reference exists and proves the claimed rights.

The original capture was at YAQMC `67bcc81265a70a9c23d3d1e09ecce5a814ee4d95` (171 commits). The frozen in-tree
clearance snapshot is `aa1c10dce2662593391afc1adc1741d0d0529e3c` (331 commits); the current dependency
overlay below does not advance that audit head or claim to re-audit later YAQMC
commits. The historical base
`11ab586e8450356eb67e3fb6a6cee58b43641449` has 167 commits (136 Mai-xiyu, 31 Osilvfe), 23 Cursor co-author trailers,
and 167 unsigned commits. Cursor trailers do not create a separate copyright interest; the human authors own that
output. The root import `a4d1ee31708a55cf6f933778e5653b88ba74ed03` added 239 files and 42,769 text lines and has 87 Git
numstat binary matches. Those binaries are maintainer screenshots, branding, and later-generated example plugins, not
third-party assets.

The separate qm-api-rs audit target and unconditional Cargo pin are
`476b37e3135560dff132e9ba8996e068af706458`. Production Core links the crate. See
[p14-qm-api-rs-provenance.md](p14-qm-api-rs-provenance.md); that crate audit is not part of this in-tree PASS.

## Rights-holder rule

Mai-xiyu and Osilvfe are recorded as **approved** in [LICENSING_CONSENT.md](../../LICENSING_CONSENT.md) with digest
`sha256:92e5f1990f8b36992da9de37667492ef6807912aa8a55ec6edc30556382c178b`. Their approvals cover only rights each
actually controls. They do not by themselves clear third-party MIT adaptations
or the separately audited, linked `qm-api-rs` material.

## Source ledger summary

| Source                  | Immutable evidence                                                                                                                    | Mapping / finding                                                                                                                       | Status                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| YAQMC root import       | `git-object:a4d1ee31708a55cf6f933778e5653b88ba74ed03`                                                                                 | Original Mai-xiyu import; current tree is GPL-3.0-or-later maintainer work                                                              | verified                    |
| Branding logo           | `git-object:c77f63df9b38990e8171d3f28bd992332d9c7922`; file `sha256:6ab743851934b0d634e4e74b74dd272a647910a37c74a38bbaec7a8d36159e9b` | `assets/yaqmc-logo.png` first added by Mai-xiyu                                                                                         | verified                    |
| L-1124/QQMusicApi       | [`108617f` license](https://github.com/L-1124/QQMusicApi/blob/108617ffe80abefec6358717b9f4d3677550db10/LICENSE)                       | Protocol-behavior reference only; no GPL implementation copied                                                                          | verified research reference |
| gongjiehong/QMCDecode   | [`aea7630` license](https://github.com/gongjiehong/QMCDecode/blob/aea76301a08678100ec677cb61a8458bc75662ec/LICENSE)                   | Independent Rust rewrite in pinned `qm-api-rs@476b37e` `src/qmc.rs`; YAQMC's `src/qmc.rs` is now only the provider adapter boundary     | verified                    |
| mzj3920/qqmusic-decrypt | —                                                                                                                                     | Not an in-tree YAQMC source; the former qm-api-rs claim was removed at pin `56db511`                                                    | **removed — unused**        |
| AynaLivePlayer/miaosic  | —                                                                                                                                     | Protocol corroboration only; no file mapping and no reused implementation                                                               | **removed — unused**        |
| QQ Music Electron ASAR  | —                                                                                                                                     | Not extracted into YAQMC; the former qm-api-rs source wording was removed at pin `56db511`                                              | **removed — unused**        |
| WXRIW/QQMusicDecoder    | —                                                                                                                                     | Not an incorporated source; the former transitive/direct-port wording was removed from the independently implemented `qm-api-rs` record | **removed — unused**        |

## Asset and notice coverage

Current branding and icons live at `assets/yaqmc-logo.png` and `apps/desktop/resources/**` (`src-tauri/icons/**` was
retired with the legacy host). Visual-QA screenshots under `artifacts/` are maintainer captures of this application.
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) mirrors the pinned
crate's QMCDecode file/range/transformation map and records the YAQMC adapter
boundary (`sha256:6a95666edbaf48cea17b168c980dc22e325b6ee88b685ccdd347098cd3b8281d`).
miaosic is acknowledged only as corroboration in [ACKNOWLEDGEMENTS.md](../../ACKNOWLEDGEMENTS.md).

## Release decision and resolution evidence

The release decision for the YAQMC tree is `pass`. Retain the immutable source/license/authorization evidence, target
mappings, contributor-rights evidence, and asset provenance in the ledger. Release source manifests must also carry
the ledger's SHA-256 digest and the evidence references required by
[CORRESPONDING_SOURCE_POLICY.md](../../CORRESPONDING_SOURCE_POLICY.md). Distributing a build linked with `qm-api-rs`
requires its separate crate-level provenance pass.
