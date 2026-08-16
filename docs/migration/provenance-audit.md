# Copyright, contributor, and source provenance audit

Status: **BLOCKED**. This is an evidence inventory and release gate, not a legal conclusion or a substitute for
copyright permission. The machine-readable record is
[provenance-ledger.json](provenance-ledger.json); run `node scripts/validate-provenance-ledger.mjs` to reproduce the
report. `--enforce` intentionally exits non-zero until every blocker is resolved.

## Scope and method

The audit covers the full YAQMC Git history, root import, identified contributors, imported/generated/binary asset
groups, current third-party notices, qm-api-rs, and every named upstream or official-client source. A record is only
release-clear when it has an immutable source revision, applicable license or authorization, a target mapping, and a
rights holder/contributor basis. A maintained `LICENSE` or a corresponding-source archive does not repair missing
copyright permission.

The validator checks evidence-reference structure only; it does not perform network, Git-signature, hash-content, or
authorization verification. A verified source needs a revision-bound `git-object:<40-hex>`,
`signed-commit:<40-hex>`, or `git-revision-url:https://.../<40-hex>/...` record. For a revision URL, the validator
requires HTTPS, the same host as `source.origin`, the same normalized repository path prefix (trailing slash and an
optional `.git` suffix are normalized), and the exact source revision as a later URL-path segment. Verified contributor
consent, asset proof, and proprietary authorization need a typed `git-object:<40-hex>`, `signed-commit:<40-hex>`,
`sha256:<64-hex>`, or `github-comment:https://github.com/<owner>/<repo>/(issues|pull)/<number>#issuecomment-<id>`
reference. Arbitrary strings and ordinary URLs are not evidence. Human review must still establish that each
well-formed reference exists and proves the claimed rights.

The capture is at YAQMC `67bcc81265a70a9c23d3d1e09ecce5a814ee4d95` (171 commits): the historical base
`11ab586e8450356eb67e3fb6a6cee58b43641449` has 167 commits (136 Mai-xiyu, 31 Osilvfe), 23 Cursor co-author trailers,
and 167 unsigned commits. Four migration commits precede the capture. The root import
`a4d1ee31708a55cf6f933778e5653b88ba74ed03` added 239 files and 42,769 text lines and has 87 Git numstat binary
matches. That import's file, asset, and contributor provenance remains unresolved.

The qm-api-rs audit target is private revision `a7430a831a256bb15212291f11a055d801e31648`: six unsigned commits
(five Osilvfe, one Mai-xiyu). Its committed tree has no tracked `Cargo.lock`; a local clone may have an ignored build
artifact named `Cargo.lock`, which is not evidence about the audited source tree. The project declares L-1124 ports
and official desktop-client ASAR references, so it cannot be treated as independently clear merely because it is in
the same organization.

## Rights-holder rule

Mai-xiyu and Osilvfe remain **Pending** in [LICENSING_CONSENT.md](../../LICENSING_CONSENT.md). Their approvals can
cover only rights each actually controls. They do not clear unattributed root-import material, other contributors,
third-party ports, binary assets, or proprietary-client extraction. Each independently copyrightable contribution or
imported asset needs proven licensing/relicensing authority, contributor consent, or rewrite/removal. `NOASSERTION`,
unknown revisions, missing mappings, and missing authorization are blockers.

## Source ledger summary

| Source                  | Immutable evidence                                                                                                                        | Mapping / finding                                                                                                                                                                               | Status                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| L-1124/QQMusicApi       | [`108617f` license](https://github.com/L-1124/QQMusicApi/blob/108617ffe80abefec6358717b9f4d3677550db10/LICENSE); `tripledes.py` `0b808a5` | GPL-3.0-only `tripledes.py`; declared map covers qm-api-rs `tripledes.rs` and 16 module basenames                                                                                               | verified source record                      |
| WXRIW/QQMusicDecoder    | [`0837a3a` license](https://github.com/WXRIW/QQMusicDecoder/blob/0837a3a1281e58f6db3e3e1dcb1d5441fb0ac268/LICENSE)                        | MIT, Copyright 2023 WXRIW; transitive DESHelper/Decrypter notice chain                                                                                                                          | verified source record                      |
| mzj3920/qqmusic-decrypt | [`a5755c7` tree](https://github.com/mzj3920/qqmusic-decrypt/tree/a5755c7cb26c8e9a53d39435e85ab034ca8d358c); relevant file `fbeb3a1`       | qm-api-rs `qmc.rs`; no license metadata/license file established at the audited source                                                                                                          | **blocked — NOASSERTION**                   |
| gongjiehong/QMCDecode   | [`aea7630` license](https://github.com/gongjiehong/QMCDecode/blob/aea76301a08678100ec677cb61a8458bc75662ec/LICENSE)                       | MIT, Copyright (c) 2019 程序猿老龚 gjh.me; `crates/yaqmc-core/src/qmc.rs` adaptation lacks required file/range/transformation record                                                          | **blocked**                                 |
| Unlock Music            | `986e02f182c1f8f30101568a8246cd5f30785378`                                                                                                | `crates/yaqmc-core/src/qmc.rs` EncV2 wrapper; exact-source license was not independently retrievable (DovGit/archival access failures)                                                          | **blocked — NOASSERTION**                   |
| AynaLivePlayer/miaosic  | observed upper-bound `c509534bd7bbc9c4094ec6c2663901cb67fec342`                                                                           | MIT observation is not the historical source pin; provider mapping/revision remain unknown                                                                                                      | **blocked**                                 |
| QQ Music Electron ASAR  | `qqmusic_1.1.8-1.asar`, no acquisition hash or immutable extraction record                                                                | `lib`, album/comment/song/songlist/user have explicit textual ASAR references; helper/private_message raw API documentation and sign/context `musics.fcg` use need acquisition-to-file evidence | **blocked — proprietary-client extraction** |

The ASAR record does not assert that every listed file was directly copied. It records the declared or textual linkage
and the missing acquisition hash, extracted-file manifest, license, and authorization. Distribution remains blocked
unless authorization exists or the affected content is independently rewritten or removed.

## Asset and notice gaps

The audit explicitly includes the root-import binary/generated path group and `src-tauri/icons/**`. The branding logo
`assets/yaqmc-logo.png` is a separate source-chain record: it was first added as a 609,661-byte binary in
`c77f63df9b38990e8171d3f28bd992332d9c7922`, not in the root import. Its creator, commission/source chain, license,
and distribution rights are unresolved. `THIRD_PARTY_NOTICES.md` contains useful notice text but does not yet provide
complete immutable source revision plus destination file/range/transformation coverage; it is not a release clearance
record.

## Release decision and resolution evidence

The release decision is `block`. To change it, retain immutable source/license/authorization evidence, target
mappings, contributor-rights evidence, and asset provenance in the ledger; update notices as required; and run the
validator in enforcement mode. Release source manifests must also carry the ledger's SHA-256 digest and the evidence
references required by [CORRESPONDING_SOURCE_POLICY.md](../../CORRESPONDING_SOURCE_POLICY.md).
