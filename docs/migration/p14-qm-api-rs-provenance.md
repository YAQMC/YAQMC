# P14 qm-api-rs crate provenance gate

Status: **PASS at pinned revision `476b37e3135560dff132e9ba8996e068af706458`**
(tolerant clear-vkey parsing on top of the `ffcc86c` record).
The crate is recorded as an independent Rust implementation with no
incorporated upstream source, and the former L-1124 port claims were removed.
This is an evidence inventory, not a legal conclusion. YAQMC links the crate
unconditionally after the P14-C cutover; distributing a linked binary
additionally requires corresponding-source delivery for the exact pin.

The in-tree YAQMC provenance PASS deliberately excludes this crate. Supplying
GPL corresponding source is a separate obligation and does not replace an
immutable source-to-target record.

## Captured crate facts

- Repository: `https://github.com/YAQMC/qm-api-rs`; pin
  `476b37e3135560dff132e9ba8996e068af706458` (also `origin/main` on
  2026-08-22). It adds tolerant clear-vkey parsing on top of the docs-only
  `ffcc86c` descendant of `56db511`.
- `PROVENANCE.md` blob
  `5d57147c353ca3de2f6f7a8ef207499999bdd9b8` records the maintainer
  attestation and reference inputs.
- The history contains 11 commits: 10 authored by Osilvfe and one by
  Mai-xiyu. The initial import is
  `a2ce8c2d2e6e48a480252b3cb56d9d26d9b0a421` (66 files, 14,460 inserted
  lines).
- The repository declares `GPL-3.0-or-later`. `LICENSE` is blob
  `f288702d2fa16d3cdf0035b15a9fcbc552cd88e7`.
- Current immutable blobs include `Cargo.toml`
  `ea7ce8928bfe0e29eb0ce55aa0ebd7d99eef7ca4`, `README.md`
  `4d03e811c365e7b78b18106c437fff6ea7de91d4`, `src/lib.rs`
  `a68c8f281621779212b354bee3cc8d13d8b0b8d3`, `src/tripledes.rs`
  `ded9f273a47e7ef59ca096b2491d534ba31f6b54`, and `src/qmc.rs`
  `6f6ebefba47a958702b79581cca86ee071acdb6b`. The pin-specific
  `src/models/song.rs` blob is
  `d0e63a362ea1b054422a0cd3b352a809f63f043b`.

## Source records

| Source                | Evidence at the pin                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | State / required decision                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| gongjiehong/QMCDecode | The pinned crate's `THIRD_PARTY_NOTICES.md` blob `5da3af9b4161cb7324735c148dd7825a6b036753` records revision `aea76301a08678100ec677cb61a8458bc75662ec`, exact Map/RC4/key target mappings, copyright, and the complete MIT text. YAQMC mirrors that mapping plus its adapter boundary in root notice blob `d65164bc2948b26352124f6a9bf7a4cbe00f20e3` (`sha256:6a95666edbaf48cea17b168c980dc22e325b6ee88b685ccdd347098cd3b8281d`). Commit `56db511` replaces the former QMC implementation. | **PASS.**                                                                                                                                       |
| L-1124/QQMusicApi     | At pin `ffcc86c`, `README.md` (blob `4d03e811c365e7b78b18106c437fff6ea7de91d4`), `Cargo.toml` (blob `ea7ce8928bfe0e29eb0ce55aa0ebd7d99eef7ca4`), and `src/lib.rs` no longer claim a port. `PROVENANCE.md` attests that no upstream source file or file content was incorporated; L-1124 was a protocol/API-shape reference only. Both projects declare GPL-3.0-or-later, so no license conflict exists either way.                                                                          | **PASS.** Independent implementation recorded via the code path; the inaccurate port wording and `tripledes.py` direct-port claim were removed. |

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
   **Used**: the maintainer attested on 2026-08-21 that no upstream file was
   incorporated, the port claims were removed at `ffcc86c`, and
   `PROVENANCE.md` records the reference inputs.
3. Historical non-distribution path: keep `qmapi` opt-in for local
   verification and do not publish a linked binary. This path was not selected;
   P14-C completed after the code-path record closed.

Maintainer approval covers only code the maintainer controls. It cannot by
itself complete the upstream L-1124 record.

## Gate state

| Gate                                           | State                                                         |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Exact qm-api-rs pin                            | PASS                                                          |
| Crate authors/history captured                 | PASS                                                          |
| Crate GPL-3.0-or-later declaration             | PASS                                                          |
| QMCDecode revision, mapping, and notice        | PASS                                                          |
| Former `mzj3920` / ASAR source claims removed  | PASS                                                          |
| L-1124 immutable revision, mapping, and notice | PASS                                                          |
| Linked distribution                            | ALLOWED after corresponding-source delivery for the exact pin |

Do not mark this gate PASS solely because `cargo test`, LIVE VERIFY, the
three-day soak, or YAQMC's in-tree `npm run provenance:enforce` passes.
