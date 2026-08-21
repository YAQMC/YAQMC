# P14-B qmapi backend

Status: **production since the P14-C cutover on 2026-08-21**. The maintainer
LIVE VERIFY harness is [`p14b-live-verify.md`](p14b-live-verify.md). Linux auto
boxes were ticked 2026-08-21; §2 dual-write, §3 HUMAN in-app, G mutations, and
library L/I play + lyrics and H account VIP (`qqmusic-qmapi`) were ticked the
same day after maintainer pass on `dcddabc`. At current pin `ffcc86c` (code
unchanged from `56db511`), J QMC
synthetic Map/RC4 parity passes; production routes to the library adapter after
the real-file playback evidence (see `p14b-live-verify.md` §4).
A/B production `zzb` stays Keep. Under `qmapi` in non-test builds, lyric HTTP,
clear vkey HTTP, and VIP fetch use the library with in-tree fallback.

## Landed

- Optional Cargo git pin `qqmusic-api` at
  `ffcc86cec2993b79ccf34faf25c1eba6c0d995ca`. Feature `qmapi` is not default.
  Core forwards it as `qqmusic-qmapi` and does not enable it.
- `YaqmcReqwestTransport` implements `ApiTransport` with YAQMC reqwest
  **0.13.4** (timeout, host allowlist, cancellation, retry class, validated
  redirects). The library's private reqwest 0.12 client is not used by this
  wrapper.
- Package and release jobs pass `QM_API_RS_TOKEN` into `setup-packaging` so
  Cargo can fetch the pin. Missing token still skips `insteadOf`; default
  intree compile must not require the crate in the Core resolve graph.
- Row J (QMC): comparison adapter compiles under `qmapi`. The in-tree and pinned
  library QMCDecode Map/RC4 implementations are byte-identical on synthetic
  fixtures. Production `EncryptedMedia::create_decryptor` stays in-tree until
  the real-file golden passes.
- Row L (lyrics): `qrc_decrypt` matches `lyrics-crypto` on the library
  reference vector. `GetLyricResponse` maps through in-tree QRC/LRC parsers
  (library `lyric_parser` is not the wire document). Under `qmapi` in a
  non-test build, `QQMusicClient::lyrics` calls library `get_lyric` and
  falls back to in-tree HTTP on failure.
- Row I (vkey): `MediaSource` URL/ekey maps through the in-tree CDN allowlist
  (including the library fallback host `isure.stream.qqmusic.qq.com`).
  Under `qmapi` in a non-test build, clear vkey HTTP uses library
  `get_song_urls` (`UrlGetVkey`) with in-tree `CgiGetVkey` fallback.
  Encrypted evkey and `choose_source` stay in-tree (`zzb`).
- Rows A/B (transport+sign): recording `ApiTransport` shows library CGI uses
  `musics.fcg` + `zzc` (length 44) when `sign=true`, and `musicu.fcg` without
  that query when unsigned. `QmError` maps into `QQMusicError`. Production
  `send_json` / `QqTransport` / MD5 `zzb` on `musics.fcg` stay in-tree (Keep).
  Do not add `zzb` to qm-api-rs. 2026-08-21: Web `GetPlayLyricInfo` forced
  onto `zzc`/`musics.fcg` returned CGI **24001**. That is a harness mismatch,
  not a `get_lyric` defect. Lyrics stay unsigned. Pin `dcddabc` writes
  Credential Cookie and y.qq Referer/Origin on every CGI. A/B live still uses
  Android `GetDislikeList` as the signed-read probe (`comm.authst` plus Cookie).
- Rows C/D (session): `SessionRecord` cookie header (`qm_keyst` /
  `qqmusic_key` / `tmeLoginType`) converts to library `Credential`. Successful
  restore/promote dual-writes account `qqmusic-credential-v2` through the
  injected YAQMC `CredentialStore` (`org.yaqmc.desktop`, file sandbox, or
  memory) and library `CredentialStore::add` via `KeyringCredentialPersist`.
  That is not a second keyring client. Staging remains
  `qqmusic-session-staging`. Production QR and Electron OAuth stay in-tree
  (Keep until P14-C). Library `get_qq_qr` is probed through injected
  transport only.
- Rows G/H (account/entitlement hybrids): library `songlist`/`user` CGI is
  probed over a recording `ApiTransport` (`like_song`/`unlike_song` on dirId
  201, create/delete/add, `GetPlaylistByUin`, `vip_login_base`). Library VIP
  JSON maps through in-tree `normalize_account_entitlement`. Under `qmapi` in
  a non-test build, `fetch_entitlement` calls library `get_vip_info` and
  falls back to in-tree HTTP. Production mutations, `client_operation_id`
  reconciliation, rename/collect, and `choose_source` stay in-tree.
- Row K (discover/home/category, PROV-04): overlapping CGI
  (`get_recommend_feed`, `get_radio_track`, `GetRadarSong`,
  `GetRecommendFeed`, `get_new_song_info`, `CgiGetDiss`) is probed over a
  recording `ApiTransport`. Library toplist (`music.musicToplist.Toplist`)
  and MV list (`GetAllocMvInfo`) diverge from in-tree
  `musicToplist.ToplistInfoServer` / `GetNewMv`. `encArea` categories, area
  home, podcasts, and featured cards have no typed library API. Production
  `build_home` / `build_discover` / `area_home` and wire feed mapping stay
  in-tree.

## Row K coverage (PROV-04)

| YAQMC surface                           | In-tree CGI                                         | Library                                       | Disposition      |
| --------------------------------------- | --------------------------------------------------- | --------------------------------------------- | ---------------- |
| Recommended songlists / new-song card   | `RecommendFeed/get_recommend_feed`                  | `recommend.get_home_feed`                     | Hybrid           |
| Guess you like                          | `MbTrackRadioSvr/get_radio_track`                   | `get_guess_recommend` (num fixed at 5)        | Hybrid           |
| Radar                                   | `TrackRelationServer/GetRadarSong`                  | `get_radar_recommend` (empty `EntranceSongs`) | Hybrid           |
| Guest songlists                         | `PlaylistSquare/GetRecommendFeed`                   | `get_recommend_songlist`                      | Hybrid           |
| Guest new songs                         | `NewSongServer/get_new_song_info` type 5            | `get_recommend_newsong`                       | Hybrid           |
| Daily 30 / new-song diss                | `DissInfo/CgiGetDiss`                               | `songlist.get_detail`                         | Hybrid           |
| Toplist                                 | `musicToplist.ToplistInfoServer/GetDetail`          | `music.musicToplist.Toplist/GetDetail`        | Divergent — Keep |
| New MVs                                 | `MvInfoProServer/GetNewMv`                          | `GetAllocMvInfo`                              | Divergent — Keep |
| Categories / area / podcasts / featured | `CategoryArea`, `AreaHome`, `longRadio`, `GetFocus` | none                                          | Keep             |

## Still deferred

- Encrypted evkey swap; A/B production HTTP/`zzb` (Keep); C/D production
  QR/session replace (drop `qqmusic-session` only in P14-C); G production
  mutation swap; K production home/discover swap.
- Staging slot, Electron OAuth popup, `provider_cache`/artwork, wire DTO
  mapping, mutation reconciliation stay in-tree forever.
- P14-C default `qmapi`, deleting replaced in-tree modules, dropping the old
  keyring entry.
- [Crate-level provenance](p14-qm-api-rs-provenance.md) for the remaining
  L-1124 port records. Linking the optional feature
  into a distributed binary is a separate rights decision from the YAQMC-tree
  ledger pass.

## Commands

```powershell
node scripts/ci/qm-api-rs-access.mjs --check
npm run ci:verify-workspace
cargo test -p yaqmc-provider-qqmusic --features qmapi --locked
```

Ignored LIVE VERIFY (`cargo test -- --ignored`, `YAQMC_QMAP_LIVE=1`) is
maintainer-only; see [`p14b-live-verify.md`](p14b-live-verify.md). CI must not
pass `--ignored` to the test harness.

Do not run `--configure-git` on a maintainer workstation. Electron stays
**43.4.0**. The 32 MiB protocol hard cap is unchanged.
