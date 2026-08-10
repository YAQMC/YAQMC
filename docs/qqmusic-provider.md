# QQ Music provider

This document records the compatibility surface validated on 2026-08-10. It is an engineering record, not a
claim that the endpoints below are a supported public SDK contract.

## Official versus compatibility surface

Tencent's public [Open Platform](https://open.tencent.com/) did not expose a general QQ Music catalog/playback API
for this desktop use case. Tencent Cloud's published music material is a separate commercial product rather than a
drop-in authorization and playback contract for a third-party QQ Music client. No approved third-party account
login flow was identified.

The implemented guest provider therefore uses the same public web compatibility surfaces currently reachable by
QQ Music pages. They are undocumented/unstable from this application's perspective and may change without notice.
Account password entry, cookie scraping, DRM bypass, entitlement bypass, and private first-party client secrets are
out of scope.

## Current endpoint map

| Capability      | Compatibility surface                                     | Normalized result           |
| --------------- | --------------------------------------------------------- | --------------------------- |
| song search     | `c.y.qq.com/soso/fcgi-bin/client_search_cp`               | paginated songs             |
| album search    | the same search surface with album type                   | paginated album summaries   |
| album detail    | `c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg`          | album and tracks            |
| playlist detail | `c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg` | playlist and tracks         |
| current toplist | `u.y.qq.com/cgi-bin/musicu.fcg`                           | home feed/toplist tracks    |
| QRC lyrics      | `musicu.fcg`, `GetPlayLyricInfo`                          | word-timed `LyricDocument`  |
| LRC fallback    | `c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg`       | line/plain lyrics           |
| playback source | `musicu.fcg` vkey response                                | allowlisted HTTPS media URL |
| artwork         | `y.gtimg.cn` / `qpic.y.qq.com`                            | cached data URI             |

Search currently normalizes songs and albums. Playlist discovery is supplied through the home/toplist and direct
playlist lookup paths; search does not fabricate a playlist block when the upstream response omits one.

Requests use a five-second connect timeout and fifteen-second total timeout. Retryable transport/rate-limit cases
are retried at most once. Partial DTOs use explicit defaults, but missing identity or impossible response structure
becomes `schema-changed`/`malformed-response` rather than guessed data.

## Identity and entitlement

Stable normalized IDs are prefixed by entity type, for example `qqmusic:track:<MID>` and
`qqmusic:album:<MID>`. The provider also retains numeric song/album IDs and the media MID inside an opaque native
reference. UI code must never substitute one for another.

The provider separates catalog availability from playback capability:

- free/public play permission -> full playback candidate chain
- paywalled item with an official try segment -> preview with explicit start/end bounds
- paywalled item without a try segment -> entitlement required and not playable

Preferred source order is:

- Automatic: 320 kbps MP3, 128 kbps MP3, AAC/M4A, official preview
- Standard: 128 kbps MP3, AAC/M4A, official preview
- High: 320 kbps MP3, 128 kbps MP3, AAC/M4A, official preview
- Lossless: FLAC, then the High chain

The vkey response, not filename construction alone, decides whether a candidate exists. Resulting URLs must be
HTTPS and end in an allowlisted `qqmusic.qq.com` or `tc.qq.com` host. URLs, cookie headers, and vkeys are never
logged or persisted as stable cache keys. A 401/403/404/410 media response triggers one fresh resolution.

## Lyrics

Encrypted QRC is decrypted in Rust using the Apache-2.0 `lyrics-crypto` crate, parsed into line/word timing, and
aligned by timestamp with translation and romanization when present. XML-embedded QRC and HTML entities are
decoded before normalization. Legacy LRC is the fallback; missing timestamps produce unsynchronized lyrics rather
than invented timing.

Normalized lyric cache keys include a parser revision (`v2`) so parser fixes invalidate malformed cached documents
without clearing unrelated media.

## Session foundation

The domain supports `guest`, `authenticated`, `reauthentication-required`, and `secure-store-unavailable`. A future
approved authorization callback can store a serialized session in the OS credential store, add the appropriate
cookie header only in native HTTP, mask account labels, detect expiry, and delete the session on sign-out.

Today the provider advertises `account: false`; the Settings page explains guest mode and deliberately presents no
password form. See [authentication](authentication.md).

## Stability and verification

Metadata responses are cached for 15 minutes (home/search) or 24 hours (entities), lyrics for 30 days, with stale
metadata fallback during an outage. Live ignored tests verify search, album, toplist, lyrics, artwork, source
resolution, download, decode, actual clock advance, pause, seek, and native output. Sanitized fixtures protect core
normalization and entitlement rules from upstream availability.

If an endpoint changes, update the boundary DTO/parser and its sanitized fixture; do not push raw compatibility
fields into React.
