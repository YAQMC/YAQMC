# QQ Music artwork resolution

This document records the artwork behavior used by YAQMC's centralized
`ArtworkResolver`. It is an interoperability observation, not a permanent QQ Music API
guarantee.

## Selection policy

Provider code supplies one `Artwork` object containing a normal source and, when the source
identity is known, measured variants. UI components select a variant by context:

| Context      | Target edge | Typical surfaces                          |
| ------------ | ----------: | ----------------------------------------- |
| `small`      |      150 px | player bar, queue, compact lyrics island  |
| `medium`     |      300 px | media cards, account playlist cards       |
| `large`      |      500 px | album and playlist detail heroes          |
| `fullscreen` |      800 px | fullscreen Lyrics and artwork backgrounds |

The resolver chooses the smallest known variant that satisfies the target. If none is large
enough, it uses the largest measured variant. If the provider source has no trustworthy size
metadata, YAQMC preserves that source and does not synthesize a larger URL.

Album artwork takes priority over chart banners or unrelated MV artwork. QQ Music provider
code owns URL construction; pages must not construct CDN URLs independently.

## Live verification

Verified on 2026-08-14 against public QQ Music catalog responses and image responses, without
account credentials. Requests used HTTPS, a browser user agent, and `https://y.qq.com/` as the
referrer. Pixel dimensions were read from the decoded JPEG, not inferred from the URL.

Canonical album pattern:

```text
https://y.gtimg.cn/music/photo_new/T002R{size}x{size}M000{albumMid}.jpg?max_age=2592000
```

Observed samples:

| Catalog sample | Album MID | 150 | 300 | 500 | 800 | 1000 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| G.E.M. — 新的心跳 | `003c616O2Zlswm` | 150×150 | 300×300 | 500×500 | 800×800 | HTTP 404 |
| 周杰伦 — 七里香 | `003DFRzD192KKD` | 150×150 | 300×300 | 500×500 | 800×800 | not requested |

The 2026-08-14 public “飙升榜” response exposed a 500×500 `headPicUrl`. YAQMC records this as
one measured playlist/chart variant rather than rewriting the `T003` URL. Its first track,
“Broken Trust”, exposed album MID `003eNAcG12WfIs`; canonical 500×500 and 800×800 album images
both decoded at the requested dimensions.

These observations justify the current 800 px ceiling. A future provider change must be
verified with response status, image MIME type, and decoded dimensions before changing the
candidate table.

## Cache and security boundary

Each selected variant is cached under its own URL-derived key. The existing native artwork
cache remains bounded and validates the response MIME type. Remote artwork is accepted only
from the exact HTTPS hosts `y.gtimg.cn` and `qpic.y.qq.com`; credentials are not attached to
artwork requests.
