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

## Authorized mflac path

When QQ Music returns an encrypted URL plus ekey for the active account, the same sparse Range source stores only
the encrypted `.mflac` bytes. `QmcReader<Read + Seek>` applies the offset-addressable map/segmented-RC4 transform on
each decoder read, so Rodio sees a normal seekable FLAC stream without producing a plaintext cache file. Encrypted
sources may use the full 256 MiB cache bound; clear sources retain the 128 MiB per-file bound.

The ekey is held in a zeroizing, redacted native type, never serialized into `PlayerSnapshot`, never used as a cache
identity, and never written to diagnostics. Session replacement/logout invalidates the source epoch and cancels
pending Range work. The implementation does not invent account access. Without a successful account-bound EVkey
response, it falls through to another permitted source or reports a typed entitlement/source error.

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

An ignored local interoperability test can be pointed at an externally supplied `.mflac` and ekey file. It streams
through the production reader, verifies FLAC decoding and duration, then seeks to 90 seconds. Neither fixture is
stored in the repository.

The 2026-08-10 Arch baseline recorded a 206 response for bytes 0-524287 in 195 ms and a 512 KiB initialized buffer in
334 ms for a 960,887-byte source. This proves progressive initialization before the full source is required. It is
not audible time-to-first-audio: the report did not timestamp source resolution, decoder readiness or the first
device callback, and it contains no prior-build measurement. Remote-seek latency and a before/after audible result
therefore remain pending.
