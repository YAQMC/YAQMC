# P14-B LIVE VERIFY (real QQ Music account)

Status: **maintainer re-verified the hybrid set on pin `56db511` on
2026-08-21**; the cutover pin `ffcc86c` was a docs-only descendant. Current pin
`476b37e` changes clear-vkey parsing; that affected row and production lyrics
were rechecked on 2026-08-22, while unaffected evidence carries forward. The
`dcddabc` ticks below remain historical.
The pre-cutover comparison harness and commands below are retained as a
historical record; its removed `qmapi` feature switches must not be copied into
new commands. `qmapi` is the production backend since the 2026-08-21 cutover:
lyric HTTP, clear-vkey HTTP, VIP fetch, QMC decrypt, and raw
favorite/playlist writes use the library. Encrypted evkey, QR/OAuth, and
mutation reconciliation stay in-tree as intentional Keep responsibilities.

Maintainer-only. Do **not** paste cookies, `musickey`, QR payload, UIN, session
JSON, vkey, ekey, or keyring bodies into chat, logs, or this file.

## 2026-08-22 cutover regression recheck

At pin `476b37e`, the maintainer desktop recheck passed after renewing a key
that QQ Music had authoritatively rejected:

- restart restored `credential-v2` and published `authenticated` only after an
  online profile validation;
- guest clear-vkey resolved a standard MP3 through library `UrlGetVkey`, and
  the same production service parsed 36 lyric lines;
- three authenticated lossless sources resolved through encrypted evkey and
  the library QMC adapter; both RC4 and map streams initialized progressive
  playback, and a seek settled at 34.353 seconds;
- the production LIVE_ACCOUNT test confirmed a favorite removal and restoration
  before continuing to live source resolution. The library client retained the
  previously verified account-write `comm`; its default Web read envelope had
  produced `DelSonglist` code `80105` with nested `retCode=0`. Unknown write
  acceptance is now reconciled by one safe read, and the test always attempts
  restoration before evaluating either result;
- no credential, media key, signed URL, or account identifier was recorded.

The clear-vkey regression had two independent causes. First, the pinned
library's `UrlinfoItem` required `vkey` and `ekey`, although normal clear-vkey
responses omit them; `476b37e` makes those response fields tolerant. Second, a
normal guest batch contains `M500`, `C400`, and `RS02`, while the YAQMC adapter
initially rejected the `RS02` preview filename before network I/O. The adapter
now maps `RS02` to `SpecialSongFileType::Try` and correlates returned URLs by
response filename rather than response position.
The earlier lyric `24001` probe used a synthetic fixture MID; valid live MIDs
continue to return lyrics through the library request.

## Historical pre-cutover comparison pass

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

## 1. Historical read-only library comparison

The former multi-row `qmapi_live_verify_*` harness was retired at cutover. CI
never passes `--ignored`. Current read-only production-path equivalents are:

```bash
export CARGO_NET_GIT_FETCH_WITH_CLI=true
cargo test -p yaqmc-provider-qqmusic --locked \
  live_public_catalog_search_and_lyrics -- --ignored --nocapture
cargo test -p yaqmc-provider-qqmusic --locked \
  live_authenticated_source_resolves_without_secret_output -- --ignored --nocapture
```

The historical harness emitted these sanitized lines:

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

## 2. Credential dual-write

Current Core restore synchronizes `qqmusic-credential-v2` and the bounded
legacy migration slot through the injected YAQMC store. The backend feature
switch no longer exists.

```bash
npm run dev:desktop
```

Boot should restore the existing session without scanning again. Do not dump
the v2 slot.

| Step                                     | Linux |
| ---------------------------------------- | ----- |
| Restores `qqmusic-session` without re-QR | [x]   |
| Dual-write path did not replace QR/OAuth | [x]   |

## 3. HUMAN in-app (historical: default Core was intree)

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
(The current pin `476b37e` adds tolerant clear-vkey parsing only.)

| Check                                                        | Linux |
| ------------------------------------------------------------ | ----- |
| Intree and qmapi QMC decrypt match on map + RC4 fixtures     | [x]   |
| Library adapter decrypts, seeks, and decodes a real QMC file | [x]   |

The removed dual-path golden is retained in Git history. Current acceptance is
the authenticated production-path test above plus the in-app encrypted
playback/seek evidence; the repository no longer carries an alternate in-tree
QMC implementation to compare at runtime.

2026-08-21 (pin `56db511`): the row was ticked by live playback in a
`YAQMC_CORE_FEATURES=qqmusic-qmapi` client build. The log records a real
encrypted `lossless-mflac` source (`encrypted=true ekey_present=true
resolution_path="evkey"`), playback continuing, and seeks settled at 205s /
143s / 108s. Production QMC routing in `qmapi` builds is hard-wired to the
library adapter with no in-tree fallback, so successful decrypt + FLAC decode +
random seek proves the adapter path. The former offline byte-identical and
in-tree-only harnesses were retired with the cutover; production builds now use
the library decryptor unconditionally.

## Rollback

Since the P14-C cutover, `qmapi` is the production backend. The pre-cutover
commit and pin `ffcc86c` are the rollback anchors; do not drop `qqmusic-session`
until validated migration.

Related: [`p14b-qmapi-backend.md`](p14b-qmapi-backend.md),
[`p14-entry-gates.md`](p14-entry-gates.md),
[`acct02-qr-session.md`](acct02-qr-session.md).
