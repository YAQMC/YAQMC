# Authenticated cross-platform beta design

Date: 2026-08-11

Status: approved by the maintainer's authenticated-beta product brief and autonomy directive. The inspected brief is
`pasted-text-1.txt`, SHA-256
`BE165D1673C421A4FF9484D45F867B1531ADCC91CBA54F1200141C07CE931E11`. This document records the implementation
interpretation before code changes; it does not broaden the product scope.

## Evidence and constraints

- The latest Arch/Hyprland archive, SHA-256
  `FD8D672EA8A2D62E608B5BB1EA0AFCEAB489586E31B9454332CA38D08971DE00`, confirms a raw
  `wayland-native` main-window handle with no explicit backend override. Its timestamp/behavior are consistent with
  commit `0e299f1`, but build identity is only inferred because the bundle has no Git SHA or AppImage digest. Audible
  playback, lyric-overlay interaction, controller behavior, and action-specific performance are unknown. The full
  confirmed/inferred/unknown evidence ledger and acceptance gate are in `docs/linux-acceptance.md`.
- The current Lyrics surface is one mounted React overlay driven by the authoritative native player clock. Preserving
  that component instance is the safest way to retain scroll, follow state, playback, and click-to-seek across layout
  changes.
- `applemusic-like-lyrics` currently redirects to `amll-dev/applemusic-like-lyrics`; its repository and published
  packages are AGPL-3.0-only. YAQMC will use it only as a product/architecture research reference. No package, source,
  CSS, shader, asset, DOM structure, or animation parameter will be copied or distributed.
- QQ interoperability research inspected `L-1124/QQMusicApi` at
  `108617ffe80abefec6358717b9f4d3677550db10` (2026-08-05, GPL-3.0-or-later) and independently corroborated selected
  request behavior with `wxuyu/QQMusicApi` at `44c3b26c8741521266c63002844564392a1fa38c` (2026-08-04, MIT) and
  `RethinkQAQ/allmusic-qqmusicapi` at `a828f1f2d2dc8416bd1a549ee4c14efbb8ba4974` (2026-08-07, LGPL-3.0 metadata
  with upstream provenance caveats). These are protocol observations, not code sources. A date/commit/license/
  endpoint ledger and README acknowledgement are required before Checkpoint D closes.
- QQ Music account behavior is an interoperability boundary. Endpoint details must be date-pinned and independently
  implemented from current observable behavior. Account credentials must never reach React, logs, fixtures, ordinary
  configuration, SQLite, cache keys, or third-party services.
- YAQMC itself currently has no selected root license. The resolved runtime closure has permissive direct frontend
  dependencies plus MPL-2.0 files through `mpris-server` and `rodio`/`symphonia`; release work must select a project
  SPDX license and ship appropriate third-party notices before calling the repository distribution-ready.

## Alternatives considered

### Lyrics presentation

1. **CSS-only enlarged overlay.** Smallest change, but cannot provide native fullscreen state, external fullscreen
   exit synchronization, or an honest acceptance boundary.
2. **One mounted Lyrics overlay with presentation states and a main-window adapter.** Retains the current renderer and
   player subscription while letting the shell reflow and the Tauri main window enter real fullscreen. This is the
   selected approach.
3. **Dedicated Lyrics route or second window.** Cleaner route semantics in isolation, but remounting duplicates state
   and risks resetting manual scroll/follow state. A second window would also add another WebKit process on Linux.

### Account integration

1. **Frontend-owned cookies and polling.** Rejected because it exposes secrets to the WebView and complicates expiry,
   cancellation, logging, and secure persistence.
2. **Rust-owned authorization/session service extending `QQMusicService`.** Selected. React receives only a sanitized
   state projection and QR image/expiry metadata. The native layer owns request construction, bounded polling, session
   validation, secure storage, and account cache invalidation.
3. **Unrelated authenticated provider.** Rejected because it would split normalization, playback source selection,
   caching, and entitlement into guest/account forks.

## Lyrics presentation architecture

Lyrics has three presentation levels over the same mounted component:

```text
Normal Lyrics     sidebar visible, persistent PlayerBar visible
Lyrics Focus      sidebar hidden, recovered width reflows artwork/lyrics, PlayerBar visible
Native Fullscreen sidebar and normal chrome hidden, compact transient transport controls
```

`lyricsOpen` remains the panel lifetime switch. `lyrics.focusSidebarCollapsed` is a Lyrics-only persisted preference;
it never alters Home/Search/Library layout. Fullscreen is transient application state. Entering fullscreen remembers
the focus preference without overwriting it, and leaving fullscreen restores the same normal/focus layout.

The shell and Lyrics overlay use explicit data attributes instead of duplicate markup or hard-coded JavaScript
measurements. Focus changes the shell from two columns to one, hides the Sidebar, moves the PlayerBar into the single
column, and sets the overlay's left edge to zero. Fullscreen additionally sets the overlay bottom edge to zero and
hides normal shell chrome. Artwork/metadata and lyrics remain a responsive two-column layout at desktop widths and
collapse intentionally at constrained aspect ratios.

A compact top-left cluster always contains the sidebar toggle and fullscreen toggle. The sidebar recovery button is
rendered in both states, has localized tooltip/accessible text, and is not hover-dependent. Fullscreen also has an
explicit exit button. `Esc` priority is: exit native fullscreen; otherwise leave Lyrics Focus; otherwise close Lyrics.
`F11` toggles fullscreen only while Lyrics is open. These transitions never issue player commands or reload lyrics.

The Tauri capability boundary is split: only `main` receives `core:window:allow-set-fullscreen`; auxiliary lyric
windows retain their existing minimal window/drag permissions. A frontend adapter owns a monotonically increasing
request generation. It calls `setFullscreen`, confirms with `isFullscreen`, and discards confirmations from older
generations. Native `onResized` events are only wake-ups: they are coalesced and followed by `isFullscreen` rather
than treated as fullscreen evidence themselves. Failure leaves the last confirmed state intact and surfaces a
localized, nonfatal message. Native acceptance covers UI, F11, Esc, and compositor/window-manager exits.

In fullscreen, the large persistent PlayerBar is replaced visually by a small transport surface containing track
identity, previous/play-pause/next, and progress. Its state is `visible`, `idle`, or `focus-pinned`: pointer/touch/
keyboard activity enters visible; playing without focus enters idle after 2.4 seconds; focus pins it; pause keeps it
visible; unmount/fullscreen exit cancels the timer. Reduced-motion mode changes visibility without a fade. Space
remains the authoritative play/pause shortcut. No second playback engine or clock is created.

Focus defaults to false for existing preference documents and normalizes invalid/missing values without a schema
reset. Closing and reopening Lyrics restores only that Lyrics-specific preference. `display: none` removes the hidden
Sidebar from focus order, the persistent top-left recovery control keeps focus, and narrow layouts retain the same
keyboard-accessible recovery path.

## Lyrics rendering and performance

The existing normalized `LyricDocument` and authoritative player time remain unchanged. Product ideas retained from
the AMLL audit are generic: distinguish timeline focus from transport, retain manual-scroll mode until explicitly
resumed, and limit work outside the useful lyric viewport. Implementation remains original.

- Replace the full-rate cursor scan with scheduling against the next known line/word boundary. Track/seek/pause/resume
  discontinuities increment a lightweight timeline revision and wake the scheduler immediately; stale timers are
  cancelled by generation. A defensive maximum wake interval corrects clock drift without making every frame scan
  the entire document. Tests bound focus-transition latency after seek and track change.
- Keep smooth progress only for the active word, throttle style writes on Linux, and suspend them when paused or the
  document is hidden.
- In reduced-motion mode, use discrete current/complete word states rather than a continuously moving mask.
- Add CSS paint/layout containment and `content-visibility` where visual tests show it does not break centering.
- Preserve the existing Linux policy that removes the largest live blur/backdrop costs. Fullscreen adds no WebGL,
  animated artwork field, or always-running background effect.
- Recenter after focus/fullscreen/resize only when auto-follow is active. A user's manual scroll position is never
  overwritten by a layout transition.

The next diagnostic bundle will label idle, playback, scroll, Focus, fullscreen, Desktop Lyrics, and Lyrics Island
phases. This converts the previous aggregate CPU evidence into comparable workloads without claiming a root cause in
advance.

## Authentication and session model

The native state machine is explicit:

```text
Guest
  -> RestoringSession
  -> StartingLogin
  -> WaitingForScan
  -> WaitingForConfirmation
  -> Authenticated
  -> SessionExpired / ReauthenticationRequired

Starting/Waiting states may also end in Cancelled, Expired, Rejected, NetworkError, ProtocolError, or
SecureStoreUnavailable.
```

`QQMusicAuthService` is owned by `QQMusicService` rather than a second provider. One login attempt exists at a time,
identified by an opaque attempt ID plus an internal generation. Starting returns only the opaque ID, an ephemeral QR
display image, expiry, and poll hint. The image is rendered in Rust from the challenge into path-only SVG/PNG data;
React never receives the raw QR URL/token, polling key, cookie, signature, authorization header, or callback URL. The
display image is cleared on cancel, expiry, terminal state, dialog close, and unmount and is excluded from logs,
telemetry, crash reports, fixtures, and documentation screenshots.

Native polling uses bounded intervals, stops on terminal state/cancellation, rejects late results whose generation
is no longer active, and never regenerates automatically while no owner is present. React can refresh an expired QR
explicitly. A successful flow validates the session with a lightweight account call, writes the secure record, reads
it back, then publishes `Authenticated`; storage failure deletes any partial record and leaves the prior session/state
unchanged. Logout increments the generation before cancelling work and deleting the session so a late success cannot
resurrect it. Startup enters `RestoringSession`; unavailable storage produces `SecureStoreUnavailable`, malformed or
expired material produces `ReauthenticationRequired`, and valid material is verified before account projections load.

The secure record contains only the minimum session material needed by allowlisted Tencent/QQ Music requests plus
expiry metadata when known. Ordinary persistence may contain a provider-scoped account cache key, masked identity,
avatar URL, entitlement projection, and fetch timestamps. Logout cancels login/poll work, deletes the secure record,
clears authenticated caches and mutation state, and leaves appearance, playback preferences, and guest browsing
intact. Invalid-session responses transition to `ReauthenticationRequired`; public read operations may still use
guest behavior, but writes never silently downgrade.

The Account settings surface displays sanitized avatar, nickname, masked identity, account state, membership summary,
and sign-in/re-authenticate/sign-out actions. The QR dialog covers generation, waiting, scanned/confirming, expiry,
refresh, rejection, cancellation, and network/protocol errors. The real acceptance run pauses exactly once for the
owner to scan a valid QR after deterministic tests pass.

## Account library and mutations

Provider-independent domain types gain paged Favorite Songs, owned/collected playlists, remote Recently Played, and
stable playlist capabilities (`canAddTracks`, `canRemoveTracks`, `canRename`, `canDelete`, `canReorder`). Raw QQ DTOs
stay in the Rust adapter. `MusicProvider` remains the catalog base contract and gains a narrow account-capability
extension rather than provider-specific response types in components.

Authenticated Library loads useful summaries first and paginates larger track lists. It renders explicit loading,
empty, account-required, stale-cache, reauthentication, and retry states. Remote account history is labeled separately
from local playback history and is never ambiguously merged.

Navigation keeps Home/Search/Explore unchanged and exposes Favorites, My Playlists, and Recently Played under Your
Music. Guest routes render a restrained sign-in state, not a generic catalog error. One normalized account-library
cache owns favorite IDs and playlist summaries; successful/reconciled mutations update that projection so song rows,
album/playlist tracks, PlayerBar, and Library agree. Logout drops provider-account projections while keeping local
playback history and guest catalog caches separate.

Favorite and playlist writes are typed native operations. Per-entity mutation keys and client operation IDs suppress
duplicates. The frontend may update optimistically only after recording a rollback snapshot. A definite upstream
rejection restores the snapshot; a success commits normalized server state; timeout/disconnect after send is
`outcome-unknown` and triggers a bounded read-after-write reconciliation before the UI converges. Create/rename/
add/remove/delete each has an operation-specific reconciliation query, and an unknown create never blindly retries.
Playlist actions are derived from per-playlist capabilities, so collected playlists never expose owner-only controls.
Acceptance mutations use a clearly temporary `YAQMC Integration Test` playlist and clean it up; no existing playlist
is renamed or deleted.

## Entitlement and playback

Account entitlement is normalized into tier/membership state, expiry when available, permitted quality classes, and
feature restrictions. UI code does not parse provider marketing strings. Each playback request follows one path:

```text
preferred quality
  -> track availability + account entitlement
  -> ordered legitimate source candidates
  -> existing ResolvedPlaybackSource / HttpRangeSource / AudioEngine
```

The resolver requests the preferred legitimate candidate, falls back in documented order when unavailable, and
reports whether fallback resulted from source availability, account rights, or preview-only access when the upstream
response distinguishes them. It retains one-time expiring-URL re-resolution. Cookies, keys, UIN material, and signed
URLs never appear in logs or cache keys. Login does not fork the audio engine or regress QRC/LRC normalization,
translation, romanization, word timing, Desktop Lyrics, or Lyrics Island.

The deterministic candidate contract is: Automatic = highest entitled available full source, then standard, then
official preview; Standard = standard full source then official preview; High = high then standard then preview;
Lossless = lossless then high then standard then preview. A catalog item marked entitlement-required without an
official preview remains unplayable. A missing source and insufficient account right are distinct typed reasons.
Settings shows preferred quality separately from the account's currently observed maximum and does not probe every
visible song independently.

## Errors, security, and observability

Provider failures remain stable typed codes: offline, timeout, rate-limited, authentication-expired,
authorization-rejected, entitlement-unavailable, not-found, malformed-response, schema-changed, and storage failure.
Only offline/timeout/rate-limit classes receive bounded retries. Every authenticated host is HTTPS and allowlisted;
redirect destinations are revalidated. Request diagnostics log operation, sanitized status, duration, retry count, and
response-shape version—not cookies, headers, QR tokens, signed URLs, personal playlist names, or raw bodies.

Research captures remain under ignored `output/` paths. Any committed fixture is shape-preserving but removes session
material, real identity, private names, and expiring URLs. A secret-pattern regression test scans tracked fixtures and
documentation for known credential field/value forms.

Redaction tests are separate from the repository scan. Unit tests feed positive/negative examples for `Cookie`,
`qm_keyst`, UIN-linked credential fields, QR/poll tokens, authorization headers, and signed media URLs through the
logger/redactor and assert only stable placeholders remain. The tracked-file scan uses an allowlist for field names
mentioned in security documentation, rejects token-like assigned values, and reports a path/line for manual false-
positive adjudication.

## Verification and delivery

- Component tests cover Focus toggle/recovery, persisted Lyrics-only preference, fullscreen UI/F11/Esc exit paths,
  external fullscreen exit synchronization, adapter failure, resize/follow behavior, track changes, and click-to-seek.
- Rust tests cover auth transitions, QR expiry/cancellation, secure-store round trips, session restore/expiry/logout,
  account normalization/pagination, favorite rollback inputs, playlist capability derivation/mutations, entitlement
  fallback, typed errors, redaction, and sanitized fixtures.
- Existing frontend, Rust, streaming, media cache, PlayerService, local API, lyric-surface, tray, MPRIS, and SMTC tests
  remain mandatory.
- Native visual acceptance covers 1000x680, 1280x800, and fullscreen on Windows across English/Chinese, light/dark,
  default/custom-color/custom-image/artwork backgrounds, Normal/Focus/Fullscreen, click-to-seek while hidden,
  track-change while fullscreen, and resize after exit. Linux separately records Auto/native-Wayland/forced-X11
  backend evidence, AppImage SHA, phase-tagged CPU/RSS, audio stream, MPRIS, and lyric-surface interaction.

## Checkpoint gates

| Checkpoint | Local gate                                                          | Evidence/document                                  | Permitted external remainder               |
| ---------- | ------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------ |
| A          | ZIP safety/hash and report reconciliation                           | `docs/linux-acceptance.md`                         | none                                       |
| B–C        | component tests, typecheck/lint/build, Windows rendered matrix      | `docs/lyrics.md`, ignored screenshots              | Arch native fullscreen retest              |
| D          | current endpoint/provenance and dependency-license inventory        | `docs/qqmusic-provider.md`, README acknowledgement | none                                       |
| E          | auth/state/secure-store tests                                       | `docs/authentication.md`                           | none                                       |
| F          | valid QR generated after deterministic tests                        | sanitized state transcript                         | owner scan/confirmation                    |
| G–H        | account reads/mutations and temporary-playlist reconciliation tests | `docs/account-library.md`                          | live account acceptance after scan         |
| I          | entitlement/source matrix and resolver tests                        | `docs/entitlement.md`                              | live account quality evidence after scan   |
| J          | complete frontend/Rust/local API/media integration suite            | command transcript                                 | physical media-key behavior where required |
| K          | Windows native visual/release acceptance                            | ignored screenshots/checklist and artifact hashes  | none                                       |
| L          | GitHub AppImage build plus diagnostic bundle                        | run URL, SHA-256, tester instructions              | friend Arch physical retest                |
| M          | clean tree, docs, notices, 27-point report                          | `output/goal-progress.md` and final report         | only the explicit F/L human gates          |

Locally verifiable work stops only after all checks and artifacts pass. If the only remaining account step is the
owner's QR scan, the goal pauses at that exact state. If the only remaining Linux step is the friend's physical retest,
the final report distinguishes that external acceptance from implementation completeness.
