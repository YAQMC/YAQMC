# Audio quality classification

> [简体中文](zh-CN/audio-quality.md) | **English**

Quality resolution evaluates three axes separately: account entitlement, track resource/vkey availability, and
client decoder support. A candidate is playable only when all three permit it. `Unknown` is preserved instead of
being misreported as “not entitled” or “unsupported”.

Automatic chooses the highest proven playable full source and falls back through lower qualities, then an official
preview. A per-track PlayerBar choice applies only to that song; advancing the queue returns to the persisted
Settings preference. The UI reports the requested quality, resolved quality, and typed fallback reason without
exposing a media URL, vkey/ekey, cookie, or request body.

Encrypted QMC/MFLAC input is accepted only after local decryption yields the FLAC magic bytes and Rodio can construct
a decoder. The user-supplied `test_raw.mflac` and `test_ekey.txt` were not present in the Downloads directory during
this checkpoint, so no result for that exact sample is claimed.
