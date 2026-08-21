# P14 qm-api-rs crate provenance gate

Status: **BLOCKED for distribution** at pinned revision
`56db511cfc98d2f860e48da4805d878ec3c2061e`. The remaining blocker is the
incomplete L-1124 port record described below. This is an evidence inventory,
not a legal conclusion. Local opt-in verification may continue, but a binary
that links `qqmusic-api` must not be distributed until this record is closed.
The default YAQMC backend remains **`intree`**.

The in-tree YAQMC provenance PASS deliberately excludes this crate. Supplying
GPL corresponding source is a separate obligation and does not replace an
immutable source-to-target record.

## Captured crate facts

- Repository: `https://github.com/YAQMC/qm-api-rs`; pin
  `56db511cfc98d2f860e48da4805d878ec3c2061e` (also `origin/main` on
  2026-08-21).
- The history contains nine commits: eight authored by Osilvfe and one by
  Mai-xiyu. The initial import is
  `a2ce8c2d2e6e48a480252b3cb56d9d26d9b0a421` (66 files, 14,460 inserted
  lines).
- The repository declares `GPL-3.0-or-later`. `LICENSE` is blob
  `f288702d2fa16d3cdf0035b15a9fcbc552cd88e7`.
- Current immutable blobs include `Cargo.toml`
  `c33a18ab77288cb199385545b5f614d06bfee3d8`, `README.md`
  `dff484b331e82800347aa5a8669246f4538ff3ce`, `src/lib.rs`
  `130a19f3cf930528cf4f5249085262ba90d0d999`, `src/tripledes.rs`
  `c61097918476b461700dc8c1a9c96e3484523a53`, and `src/qmc.rs`
  `6f6ebefba47a958702b79581cca86ee071acdb6b`.

## Source records

| Source                | Evidence at the pin                                                                                                                                                                                                                                                                                                                                             | State / required decision                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gongjiehong/QMCDecode | `THIRD_PARTY_NOTICES.md` blob `5da3af9b4161cb7324735c148dd7825a6b036753` records revision `aea76301a08678100ec677cb61a8458bc75662ec`, exact Map/RC4/key target mappings, copyright, and the complete MIT text. Commit `56db511` replaces the former QMC implementation.                                                                                         | **PASS.**                                                                                                                                                                           |
| L-1124/QQMusicApi     | `Cargo.toml`, `README.md`, and `src/lib.rs` describe the crate as ported from L-1124; `src/tripledes.rs` says it is a direct port of `algorithms/tripledes.py`. Both projects declare GPL-3.0-or-later. YAQMC's research pin `108617ffe80abefec6358717b9f4d3677550db10` confirms that license but does not prove it was the revision used for the crate import. | **BLOCKED.** Record the actual immutable upstream revision, copyright holder and notice, plus file/range/transformation mappings from that revision into every ported crate module. |

## Removed source claims

- `mzj3920/qqmusic-decrypt` is not a source at this pin. Commit `56db511`
  replaced `src/qmc.rs`; no current source, manifest, notice, or documentation
  names it.
- The maintainer confirms that official QQ Music Electron ASAR source was not
  used directly. Commit `56db511` removes the former ASAR source wording and
  records the desktop protocol paths as independently implemented
  interoperability. No current source or documentation names an ASAR artifact.

These removals close the former QMC and ASAR provenance blockers. They do not
license or authorize any future reintroduction of those materials.

## Acceptable closure paths

1. Evidence path: add the actual L-1124 source revision, copyright/notice,
   exact source-to-target mappings, and immutable evidence to qm-api-rs.
2. Code path: independently replace every L-1124-derived module, remove the
   port claims, and record reviewable clean-room inputs and mappings.
3. Non-distribution path: keep `qmapi` opt-in for local verification, retain
   `intree` as the packaged backend, and do not publish a linked binary.

Maintainer approval covers only code the maintainer controls. It cannot by
itself complete the upstream L-1124 record.

## Gate state

| Gate                                           | State   |
| ---------------------------------------------- | ------- |
| Exact qm-api-rs pin                            | PASS    |
| Crate authors/history captured                 | PASS    |
| Crate GPL-3.0-or-later declaration             | PASS    |
| QMCDecode revision, mapping, and notice        | PASS    |
| Former `mzj3920` / ASAR source claims removed  | PASS    |
| L-1124 immutable revision, mapping, and notice | BLOCKED |
| Distribution with `qmapi`                      | BLOCKED |

Do not mark this gate PASS solely because `cargo test`, LIVE VERIFY, the
three-day soak, or YAQMC's in-tree `npm run provenance:enforce` passes.
