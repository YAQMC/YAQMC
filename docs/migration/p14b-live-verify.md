# P14-B LIVE VERIFY (real QQ Music account)

Status: **the Linux auto, §2 dual-write, §3 HUMAN in-app, and G mutation ticks
below are historical evidence from pin `dcddabc`**. Current target pin
`56db511` passes the J Map/RC4 synthetic comparison, but its exact-pin LIVE and
real-file checks have not been rerun. This is not a production module swap, not P14-C, and not a 3-day soak.
Default production backend stays **`intree`**. With `YAQMC_CORE_FEATURES=qqmusic-qmapi`,
non-test builds use library lyric HTTP, clear vkey HTTP, and VIP fetch
(in-tree fallback). QMC decrypt also routes to the library adapter in `qmapi`
non-test builds (row-J live candidate); encrypted evkey, QR/OAuth, and
mutations stay in-tree.

Maintainer-only. Do **not** paste cookies, `musickey`, QR payload, UIN, session
JSON, vkey, ekey, or keyring bodies into chat, logs, or this file.

## What this pass is

Per-module comparison of optional `--features qmapi` adapters against a real
session, in the plan order (J is offline-only here):

1. L lyrics (unsigned library `get_lyric` mapped through in-tree parsers, compared
   to an in-tree-shaped `musicu.fcg` fetch on **line count and start/end ms**)
2. A/B transport+sign (Android `GetDislikeList` on `musics.fcg` + `zzc`; production
   encrypted vkey still uses MD5 `zzb`)
3. I vkey (`MediaSource` through the in-tree CDN allowlist)
4. C/D session (`qqmusic-session` → library `Credential`; dual-write is a
   separate Core boot with `qqmusic-qmapi`)
5. H VIP (`vip_login_base` → in-tree `normalize_account_entitlement`)
6. K home feed CGI (`get_recommend_feed` only; wire `HomeFeed` stays in-tree)
7. G mutations, J QMC decrypt, QR/OAuth: HUMAN / golden only — not in the
   ignored cargo test

A green ignored test does **not** flip production paths. Flip a module only
after the corresponding box is signed and the overlay records the swap.

## 0. Login (intree Core)

Use the real provider, not `?provider=fake`:

```bash
npm run dev:desktop
```

QR: [ACCT-02](acct02-qr-session.md). OAuth popup: ACCT-01. Confirm a masked
authenticated account snapshot. Leave `YAQMC_CREDENTIAL_DIR` unset so Core
writes `org.yaqmc.desktop` / `qqmusic-session`.

## 1. Read-only library comparison (ignored cargo test)

CI never passes `--ignored`. Unset `YAQMC_CREDENTIAL_DIR`. Run from a desktop
session with Secret Service / the same OS user that just logged in:

```bash
unset YAQMC_CREDENTIAL_DIR CARGO_TARGET_DIR
export YAQMC_QMAP_LIVE=1
export YAQMC_ALLOW_PRODUCTION_ATTACH=1
export CARGO_NET_GIT_FETCH_WITH_CLI=true
cargo test -p yaqmc-provider-qqmusic --features qmapi --locked -- \
  --ignored --nocapture \
  qmapi::live::qmapi_live_verify_session_lyrics_sign_vkey_vip_and_feed
```

Expected stderr lines (no secrets):

```text
LIVE VERIFY C/D: session converted
LIVE VERIFY L: lines=<n> via in-tree HTTP
LIVE VERIFY L: lines=<n> via get_lyric mid
LIVE VERIFY L: compared lines=<n> first_ms=<ms> last_ms=<ms>
LIVE VERIFY A/B: zzc accepted on GetDislikeList
LIVE VERIFY I: playable=true host=<cdn> encrypted=false
LIVE VERIFY H: tier=<...> membership=<...>
LIVE VERIFY K: home_feed ok
```

2026-08-21: forcing Web `GetPlayLyricInfo` onto `musics.fcg` + `zzc` returned
CGI **24001**. That is not a lyric-mapper fail. In-tree and library lyrics stay
on unsigned `musicu.fcg`. A/B now uses the library's real signed read
(`GetDislikeList`). The harness continues later rows if one row fails.

Row I may print `playable=false entitlement=unavailable` for a Free account
(`104003`). That is expected when VIP is expired. SuperVip + Active + `104003`
is a fail.

Expired VIP does **not** explain lyric CGI **24001**. After SuperVip LIVE
VERIFY, A/B/I/H/K passed and L still returned 24001 for both library
`get_lyric` and a library `songMID` CGI. That is an API/`GetPlayLyricInfo`
problem, not membership. In-tree lyrics use guest `musicu.fcg`, `req_1`,
`comm.ct=24,cv=0`, `songMID`, and `Referer`/`Origin`. Pin `dcddabc` writes those
browser headers and Credential cookies on library CGI; `get_lyric` is unsigned
Web and sends `songMID`/`songMid` (numeric id → `songID`). YAQMC transport still
fills Referer/Origin if missing.

Do not run `like_song` / playlist writes in this step.

| Row | Auto check                                                       | Linux |
| --- | ---------------------------------------------------------------- | ----- |
| C/D | `qqmusic-session` converts to `Credential`                       | [x]   |
| L   | in-tree HTTP and `get_lyric` map to the same line timings        | [x]   |
| A/B | Android `GetDislikeList` used `musics.fcg` + `zzc` and succeeded | [x]   |
| I   | URL allowlisted or `EntitlementUnavailable`                      | [x]   |
| H   | `vip_login_base` maps to in-tree entitlement                     | [x]   |
| K   | `get_home_feed` succeeds                                         | [x]   |

Linux auto 2026-08-21 (pin `dcddabc`): L compared 63 lines, `first_ms=0`
`last_ms=262863`; I `isure.stream.qqmusic.qq.com` `encrypted=false`; H
`SuperVip` / `Active`. No secrets logged. Maintainer reported §2 dual-write
and §3 in-app HUMAN pass the same day. Maintainer reported G like/playlist
writes persist; later the same day, play + lyrics also worked with
`YAQMC_CORE_FEATURES=qqmusic-qmapi` (library L/I). These ticks predate the
`56db511` QMC replacement and must not be treated as exact-pin evidence.

## 2. Dual-write Core (still intree production paths)

Optional. Confirms restore dual-writes `qqmusic-credential-v2` through the
injected YAQMC store. With `qqmusic-qmapi`, lyric HTTP, clear vkey HTTP, and
VIP fetch use the library; QR, encrypted evkey, and mutations remain in-tree.

```bash
YAQMC_CORE_FEATURES=qqmusic-qmapi npm run dev:desktop
```

Boot should restore the existing session without scanning again. Do not dump
the v2 slot.

| Step                                     | Linux |
| ---------------------------------------- | ----- |
| Restores `qqmusic-session` without re-QR | [x]   |
| Dual-write path did not replace QR/OAuth | [x]   |

## 3. HUMAN in-app (default Core still intree)

The first 2026-08-21 ticks below were against **intree** production paths.
Library L/I play + lyrics was ticked the same day after
`YAQMC_CORE_FEATURES=qqmusic-qmapi`. The account dialog was re-checked with
the same Core feature after the H VIP-fetch swap.

| Check                                            | Linux |
| ------------------------------------------------ | ----- |
| Play a track; lyrics overlay matches in-app      | [x]   |
| Account dialog shows masked identity + VIP       | [x]   |
| Home/discover still render (in-tree feed)        | [x]   |
| QR still in-tree; OAuth still Electron           | [x]   |
| G like / playlist writes persist on restart      | [x]   |
| Play + lyrics with `qqmusic-qmapi` (library L/I) | [x]   |
| Account VIP with `qqmusic-qmapi` (library H)     | [x]   |

## 4. J QMC golden (offline)

The automatic gate `qmapi_qmc_matches_intree_map_and_rc4` requires both cipher
families to be byte-identical. It passes on pin `56db511`. An ekey-backed real
encrypted file must also decrypt, seek, and decode through the library adapter.

| Check                                                        | Linux |
| ------------------------------------------------------------ | ----- |
| Intree and qmapi QMC decrypt match on map + RC4 fixtures     | [x]   |
| Library adapter decrypts, seeks, and decodes a real QMC file | [x]   |

Run the dual-path golden with a real encrypted file and its ekey:

```bash
YAQMC_QMC_SAMPLE=/path/to/sample.mflac YAQMC_QMC_EKEY_FILE=/path/to/ekey.txt \
  cargo test -p yaqmc-provider-qqmusic --features qmapi -- \
  library_adapter_matches_intree_on_a_real_qmc_file --ignored
```

2026-08-21 (pin `56db511`): the row was ticked by live playback in a
`YAQMC_CORE_FEATURES=qqmusic-qmapi` client build. The log records a real
encrypted `lossless-mflac` source (`encrypted=true ekey_present=true
resolution_path="evkey"`), playback continuing, and seeks settled at 205s /
143s / 108s. Production QMC routing in `qmapi` builds is hard-wired to the
library adapter with no in-tree fallback, so successful decrypt + FLAC decode +
random seek proves the adapter path. The offline byte-identical harness
(`library_adapter_matches_intree_on_a_real_qmc_file`) and the in-tree-only
harness (`decrypts_external_mflac_sample`) remain available as optional extra
checks for maintainers who have a local encrypted sample. Default builds stay
on the in-tree decryptor until cutover.

## Rollback

Leave each module on `intree`. Do not enable default `qmapi`. Do not drop
`qqmusic-session`. Do not start P14-C or a 3-day soak from this document.

Related: [`p14b-qmapi-backend.md`](p14b-qmapi-backend.md),
[`p14-entry-gates.md`](p14-entry-gates.md),
[`acct02-qr-session.md`](acct02-qr-session.md).
