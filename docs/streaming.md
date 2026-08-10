# Progressive HTTP Range streaming

## Data path

```text
provider-aware stable cache key
        |
complete cache hit? ---- yes ---> local file decoder
        |
resolve signed URL
        |
GET Range: bytes=0-524287, Accept-Encoding: identity
        |
  206 --------------------------> sparse seekable file + decoder
   |                                  |
   |                                  +--> requested segment has priority
   |                                  +--> three-segment read-ahead
   |                                  +--> complete file promoted atomically
   |
  200 / valid 416 ----------------> bounded full-download fallback
```

HTTP behavior is isolated in `streaming.rs`; Rodio receives a `Read + Seek` source and does not know about HTTP.
Segments are 512 KiB, with three segments (1.5 MiB) of read-ahead. This avoids tiny decoder-driven requests while
allowing decoding after the initial range rather than after the whole song. The per-file limit is 128 MiB and the
complete media cache remains bounded to 256 MiB.

## Correctness properties

- Every 206 response must provide an exact, non-inverted `Content-Range` with the same total length.
- A server that ignores a later range with 200 is accepted only if it returns the exact complete source.
- Initial 200 or a valid bounded 416 selects the existing full-download path.
- One worker owns downloads; overlapping readers cannot duplicate an in-flight segment.
- Seek queues the missing segment ahead of background prefetch and blocks only for that segment, for at most 20 s.
- Sparse partial files use random names and are deleted when the last source/reader is released.
- Completion copies through a random staging file, atomically promotes it, records the stable provider key, then
  enforces the normal cache limit. The expiring signed URL is never the cache identity.
- Replacing a track drops the source and cancels the worker. A signed URL that expires during a later range is
  resolved once, the decoder is rebuilt at the actual previous position, and further expiry does not loop.
- `loading`, `buffering`, `playing`, `paused`, `ended` and recoverable error are driven by native engine state.

## Deterministic tests

A local TCP HTTP fixture covers exact 206 data, initial 200 fallback, 416 validation, overlapping reads, uncached
seek, cancellation, sparse-part cleanup, complete-cache promotion and later 403 expiry classification. Player tests
cover bounded source re-resolution and stale-load generation rejection. Tests never call QQ Music.

Real time-to-first-audio and remote-seek latency require the Arch/normal-network run. The structured
`stream.range`/`stream.buffer` logs record initial response and first-buffer time so that result can be compared to
the prior full-download build without guessing.
