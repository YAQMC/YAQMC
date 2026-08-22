# P14 entry gates (YAQMC-side)

Status: **P14-C cutover complete; `qqmusic-api` is an unconditional production
dependency**. The former `qmapi`/`intree` backend feature split has been
removed. The completed P14-C scope and evidence are recorded in
[`p14c-readiness.md`](p14c-readiness.md).

## Met before the cutover; still required before distributing a linked binary

- [Crate-level provenance](p14-qm-api-rs-provenance.md): the L-1124 record was
  closed at `ffcc86c` via the independent-implementation attestation; the
  QMCDecode mapping and notice are complete, and ASAR and `mzj3920` are not
  implementation sources. Shipping a linked `qqmusic-api` binary still requires
  corresponding-source delivery.
- Per-module golden / LIVE VERIFY (order: J qmc → L lyrics → I vkey → A/B
  transport+sign → C/D login/session → G/H hybrids). Maintainer harness:
  [`p14b-live-verify.md`](p14b-live-verify.md). Linux auto, §2 dual-write,
  §3 HUMAN in-app, G mutations, library L/I play + lyrics, and library H
  account VIP ticked 2026-08-21 on the former pin. Current pin `476b37e`
  passes J synthetic parity; exact-pin LIVE and the real-file QMC playback
  evidence are recorded in `p14b-live-verify.md`.
  Since the cutover, lyric HTTP, clear vkey HTTP, VIP fetch, QMC decrypt, and
  raw favorite/playlist writes use the library. Production `zzb`, QR, and
  mutation reconciliation stay Keep.
- Three-day soak at the `ffcc86c` cutover baseline was waived by the maintainer
  on 2026-08-21, and the maintainer reissued that waiver for the current pin
  `476b37e` on 2026-08-22 as a maintainer-authorized skip. No three-day soak
  ran at either pin; the exact-pin LIVE and real-file playback evidence in
  `p14b-live-verify.md` plus the 2026-08-22 favorite remove/restore LIVE round
  trip are the substitute evidence.

Upstream `ApiTransport`, MSRV metadata, and hiding `reqwest` from the public
crate API landed in qm-api-rs at this pin. YAQMC injects reqwest **0.13.4**
and must not compensate with a logging wrapper or upgrade the library to
reqwest 0.13 merely for version uniformity. Rows A/B are an **offline CGI/sign
probe** (`zzc` on `musics.fcg` via recording transport). That is not LIVE
VERIFY and does not replace in-tree HTTP or MD5 `zzb`. Rows C/D dual-write
`qqmusic-credential-v2` through the injected YAQMC `CredentialStore`; they do
not replace production QR or drop `qqmusic-session`. Rows G/H probe library
songlist/user CGI and map VIP through in-tree `normalize_account_entitlement`.
Non-test `qmapi` builds fetch VIP via library `get_vip_info`. They do not
replace mutation reconciliation or `choose_source`. Row K audits
home/discover/area CGI coverage; missing and divergent endpoints stay
in-tree.

## Landed in YAQMC

| Gate                          | Record                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License file / crate metadata | Root `LICENSE` and workspace `GPL-3.0-or-later` already match qm-api-rs. YAQMC-tree maintainer consent is recorded; it still does not clear this crate.                                                                   |
| Pin                           | `476b37e3135560dff132e9ba8996e068af706458` at `https://github.com/YAQMC/qm-api-rs.git` (tolerant clear-vkey parsing on top of the `ffcc86c` independent-implementation record)                                            |
| Cargo                         | Unconditional `qqmusic-api` git dependency. The former `qmapi`/`intree` feature split and Core `qqmusic-qmapi` opt-in have been removed; the production Core resolve contains the exact pin.                              |
| Local sibling                 | If `../qm-api-rs` exists, `node scripts/ci/qm-api-rs-access.mjs --check` requires that HEAD                                                                                                                               |
| CI insteadOf                  | `rust-quality` and `setup-packaging` run `--configure-git` when `CI=true` and `QM_API_RS_TOKEN` is set. A clean private-pin build requires that token; use `CARGO_NET_GIT_FETCH_WITH_CLI=true` so Git honors `insteadOf`. |

## Commands

```powershell
node scripts/ci/qm-api-rs-access.mjs --check
npm run ci:verify-workspace
```

Do not run `--configure-git` on a maintainer workstation. It writes git config and is
CI-only (`CI=true` or `YAQMC_QM_API_RS_CONFIGURE_GIT=1`).

Do not dispatch GitHub Actions from this scaffolding. YAML on disk is not live-green
evidence (Actions quota remains **BLOCKED-EXTERNAL**).

Electron stays **43.4.0**. The 32 MiB protocol hard cap is unchanged.
