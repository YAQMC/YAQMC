# Playback entitlement

YAQMC treats catalog metadata, account rights, source availability, and playback authorization as separate inputs.
The QQ Music adapter normalizes account data to provider-independent `AudioQuality`,
`AudioQualityPreference`, and `PlaybackSourceSelection` contracts. Components never infer rights from membership
marketing strings or from a provider quality label.

Authenticated validation reads the provider's direct `VipLogin.VipLoginInter/vip_login_base` response through the
same allowlisted, cancellable transport used by the account runtime. The normalizer consumes only numeric membership
flags and expiry time. If this medium-confidence endpoint is unavailable or changes shape, login remains usable but
the entitlement becomes `unknown` and playback is restricted to Standard; cancellation is never converted into that
fallback. Guest playback is likewise treated conservatively as free/Standard until a source is proven available.

## Deterministic selection

| Preference | Candidate order                                                             |
| ---------- | --------------------------------------------------------------------------- |
| Automatic  | Highest entitled full source, descending to Standard, then official preview |
| Standard   | Standard, then official preview                                             |
| High       | High, Standard, then official preview                                       |
| Lossless   | Lossless, High, Standard, then official preview                             |

Automatic selecting Standard for a free account is the requested outcome, not a fallback. For explicit preferences:

- `account-rights` means the track offers the requested quality but the current account does not permit it.
- `source-unavailable` means the requested quality is permitted but no matching format/vkey is currently available.
- `preview-only` means only the provider's normalized official preview is playable.

An excluded paid quality is removed before the single batched vkey request. Missing rights and a missing source remain
distinct native errors when no lower or preview source can be selected.

## Authorization boundary

Account cookies and entitlement are captured with an `(auth generation, opaque account scope)` epoch. The resulting
guard is attached to the resolved source and moved unchanged through the existing cache/progressive preparation and
audio engine. Auth generation invalidation is fail-closed:

1. cancel the old generation token;
2. clear or replace the shared epoch under a synchronous write lock;
3. reject pending preparation/load/play/commit work;
4. stop and clear any loaded source whose retained guard is stale;
5. publish a sanitized stopped snapshot without a provider/network error toast.

Guest/public sources use an unrestricted lifecycle guard while retaining the conservative free/Standard rights
projection. The one-time expired URL refresh, progressive Range reader, full-download cache fallback, Rodio engine,
queue, and lyric clock are unchanged.
