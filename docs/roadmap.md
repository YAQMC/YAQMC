# Next feature roadmap

> [简体中文](zh-CN/roadmap.md) | **English**

This is the engineering plan for song sharing, recommendation continuation, listening statistics, categorized
Discover tabs, and Provider plugins. It defines dependencies, boundaries, acceptance criteria, and risks; it is not a
release-date commitment. A feature may be described as complete in release notes only after its acceptance criteria
are met.

## Implementation status

- [x] P0 — composable provider capabilities, runtime-safe provider IDs, and typed `qm-api-rs` recommendation APIs.
- [x] P1 — accessible Discover tabs plus provider-neutral sharing and fail-closed Electron deep links.
- [x] P2 — Core-owned guess/radar continuation with bounded prefetch, retry, deduplication, and stale-response guards.
- [x] P3 — local listening statistics.
- [x] P4/P5 — sandboxed Provider plugin runtime and lifecycle/UI integration.
- [x] P6 automatic closure — reproducible Windows-local plus native Linux/Windows CI evidence.

Checked items have passed their automatic implementation gates. They do not imply release readiness,
production-account, GUI, LIVE, packaging, or final maintainer acceptance. The exact-pin three-day provider soak is
still `not-started`; see [Provider Component v3 automatic closure](release/provider-component-v3.md).

## 1. Goals and non-goals

This roadmap delivers five capabilities:

1. Share song metadata, provider public links, and YAQMC deep links.
2. Run **Guess you like** and **Because you listen to** on one reliable continuous-recommendation session model.
3. Measure actual local listening instead of treating a resolved source as a completed play.
4. Present Discover as accessible, keyboard-operable category tabs.
5. Let plugins supply custom music platforms, playback sources, lyrics, and accounts within an explicit security
   boundary.

The following are out of scope:

- A browser product or browser extension. YAQMC remains an Electron desktop application.
- Cloud statistics, cloud sync, social activity, or public listener profiles.
- A plugin marketplace, automatic remote updates, or publisher trust infrastructure.
- Native `dll`/`so`, arbitrary subprocess, or unrestricted shell plugins.
- Autoplay, automatic login, or silent account mutation from a shared link.
- New QQ Music upstream URLs, module names, or method names implemented inside YAQMC.

## 2. Non-negotiable engineering boundaries

### 2.1 Network and provider boundary

- QQ Music network protocols must be exposed as typed APIs, DTOs, and contract tests by `qm-api-rs`. YAQMC's QQ
  adapter only invokes those APIs, normalizes domain values, and maps errors.
- If a required operation is missing, add and test it in `qm-api-rs` first, then pin YAQMC to an exact commit.
- Existing recommendation route strings in YAQMC must move back to `qm-api-rs` before continuation work starts;
  their current presence does not justify extending them in place.
- Third-party platforms do not go through `qm-api-rs`. They can only call HTTPS, credential, storage, and other
  capabilities explicitly granted by Extension Host.

### 2.2 State ownership

- Core `PlayerService` is the sole source of truth for queue state, the current track, the playback clock, EOS, and
  recommendation sessions.
- React/Zustand keeps projections and transient interaction state; it cannot decide whether a native playback
  session remains active.
- Electron Main handles windows, operating-system protocols, file dialogs, and platform integration. It does not
  implement music-platform APIs.
- Credentials, signed URLs, sensitive authentication headers, and cookies never enter the renderer, logs, statistics, or share
  text.

### 2.3 Compatibility and privacy

- Plugin API v1/v2 and existing style, lyrics-scene, and script plugins remain supported. Provider plugins use a new
  manifest and API version.
- Listening statistics stay local by default and are never telemetry. Users can export and erase them.
- External URIs, plugin packages, plugin return values, and provider identifiers are untrusted input.
- Automated tests never use a maintainer production account. Real-account, GUI, LIVE, and final release acceptance
  require separate maintainer authorization after the implementation report.

## 3. Baseline captured before implementation

- Sharing: there is no song-share action or custom URI scheme. The current `shell.openExternal` bridge only accepts
  fixed product links.
- Guess continuation: `useGuessContinuation` watches renderer `ended` state and appends five songs. In native command
  paths, early returns make the renderer-only `guessSessionActive` reset unreliable.
- Radar recommendations: Home renders **Because you listen to**, but that list does not start a continuation session.
- Statistics: `playback_history` stores snapshots of recently resolved songs. It cannot represent pauses, skips,
  completion, or active listening time.
- Discover: one `DiscoverFeed` already contains every section, but the page lays them all out vertically.
- Plugins: manifest v1 / API v2 supports styles, lyrics scenes, isolated scripts, safe UI slots, and scoped HTTPS.
  `provider`, `account`, `native`, and `filesystem` remain reserved and rejected.
- Providers: Rust `MusicProvider` requires playback, catalog, and account together and registry IDs are
  `&'static str`. The frontend also exposes only one active `MusicProvider`. Both block dynamic platforms and
  providers without accounts.

## 4. Target architecture

```text
React UI
  -> typed Renderer/Core protocol
  -> Core services
       - PlayerService (queue, clock, EOS)
       - ContinuationService (recommendation sessions, prefetch, deduplication)
       - ListeningStatisticsService (event recording, aggregation, export)
       - ProviderRegistry (dynamic capabilities and instances)
       - ExtensionHost (plugin lifecycle and capability sandbox)
            -> built-in QQMusic Provider -> qm-api-rs
            -> WASM Provider Component -> restricted Host capabilities
  -> Electron Main (deep links, windows, system dialogs)
```

The monolithic provider contract is migrated incrementally into composable capabilities:

- `CatalogProvider`: search, songs, albums, artists, playlists, and Discover content.
- `PlaybackSourceProvider`: playable-source resolution; sensitive URLs and headers remain inside Core.
- `RecommendationProvider`: guess, radar, and subsequent batches.
- `LyricsProvider`: regular, word-timed, and translated lyrics.
- `AccountProvider`: sign-in, account snapshots, favorites, and account playlists; this capability is optional.
- `ShareProvider`: normalized public links and shareable metadata.

A compatibility adapter maps the current built-in QQ `MusicProvider` to those capabilities during migration. The old
monolithic interface is removed only after protocol consumers move, avoiding an all-at-once rewrite of playback,
accounts, and test fixtures.

`ProviderRegistry` moves to validated runtime string IDs and distinguishes:

- Provider type, such as built-in `qqmusic` or a platform supplied by a plugin.
- Provider instance, which combines a plugin, configuration, and storage domain.
- Account profile, which belongs to one provider instance. The first version may store multiple profiles while
  allowing one active profile per instance.

Every queued song retains `providerId + trackId`, so a queue can contain multiple providers. If a provider is
disabled, its songs become explicitly unavailable and are skipped safely; YAQMC must not silently substitute a
same-named song from another platform.

## 5. Workstream A: song sharing

### 5.1 Contract

Add a provider-neutral share result:

```text
ShareTarget
  providerId
  entityKind = song
  entityId
  title
  artists[]
  album?
  canonicalHttpsUrl?
```

The QQ Provider owns QQ public-link resolution. If it needs a network read or upstream field, that capability is
added to `qm-api-rs` first. React never assembles platform domains or upstream routes.

### 5.2 User experience

The first version exposes two explicit actions:

- **Copy public link** prefers the provider's canonical HTTPS URL. It is disabled with a reason when no public link
  exists.
- **Copy YAQMC link** writes `yaqmc://catalog/<provider>/song?id=<percent-encoded-id>` for machines with YAQMC
  installed.

Share actions appear on Song Page, the Player Bar overflow menu, Lyrics Page, and a song's TrackList context menu.
The existing notification system reports copy success or failure. Providers without links can expose **Copy song
info** as plain `Title — Artist` text, but that text is never presented as a clickable URL.

### 5.3 Deep-link handling

- Electron registers the `yaqmc` scheme and reuses the single-instance mechanism.
- Windows/Linux `second-instance` and macOS `open-url` feed one pure parser.
- The parser accepts only `catalog/song`, caps total URI, provider ID, and entity ID length, and rejects userinfo,
  ports, fragments, unknown query parameters, control characters, and duplicate required parameters.
- A parsed link becomes only a typed “open song detail” navigation command. It never becomes a shell argument,
  filesystem path, SQL, HTML, or arbitrary IPC.
- A deep link focuses the main window and opens details. It does not play, authenticate, or open auxiliary lyrics
  windows.
- Registration failure does not prevent startup. Settings reports protocol registration and lets the user disable it.

Electron documents the platform-specific second-instance handling in
[Electron Deep Links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app).

### 5.4 Acceptance criteria

- All four UI entries produce consistent text, and entity IDs with special characters round-trip.
- Cold and already-running launches produce one main window and the correct song route.
- Fuzz tests cover long URIs, duplicate parameters, broken encoding, and injection-shaped input.
- Links never trigger playback, account mutation, an external shell, or sensitive output.
- Missing public-link support degrades explicitly without inventing a URL.

## 6. Workstream B: guess and radar continuation

### 6.1 Core recommendation session

Replace renderer `guessSessionActive` with a Core `ContinuationService`. A session records at least:

- `sessionId`, `providerId`, `kind` (`guess` or `radar`), and the account generation at creation.
- Radar seed songs or guess context, provider cursor/page, and request generation.
- Seen `providerId + trackId` keys, consecutive empty batches, and current request state.

These actions start a session:

- Playing/opening the Guess-you-like card.
- Playing the **Because you listen to** section or selecting one of its songs. Selection starts at that song and keeps
  the section's subsequent songs.

These actions end a session:

- Replacing the queue from another page, switching provider/account, signing out, disabling the provider, or an
  explicit stop.
- The provider reports completion, or three consecutive batches are empty after deduplication.

Pause, resume, seek, queue reorder, and manual queue append do not end a session. Repeat One does not fetch a batch;
Repeat All controls current queue traversal without disabling recommendation prefetch.

### 6.2 Prefetch, deduplication, and errors

- Core asynchronously prefetches a five-song batch when only two playable recommended songs remain after the current
  song.
- A response must match session ID, request generation, provider, and account generation; stale responses are
  discarded unconditionally.
- Deduplicate on `providerId + trackId` within the session and cap the seen set at 500 IDs. End the session at the cap
  to keep memory bounded.
- Network/rate-limit errors use jittered `1s / 3s / 8s` retries. Existing queue content keeps playing; exhaustion ends
  the session and emits one non-blocking notice.
- Authentication, schema, entitlement, and unsupported errors are not blindly retried.
- Append is atomic and never clears user queue content. Core's EOS transition remains responsible for the actual
  next-track action.

### 6.3 `qm-api-rs` prerequisites

`qm-api-rs` already exposes guess and radar entry points, but their parameters are insufficient. YAQMC also still
contains `get_radio_track` and `GetRadarSong` route strings. Before implementing continuation:

1. Add typed guess requests with `limit/from/cursor`, and radar requests with `page/entranceSongs/credential`, to
   `qm-api-rs`.
2. Add `qm-api-rs` contract tests for success, empty results, non-zero codes, and response-shape drift.
3. Update YAQMC's exact `rev` and provenance record.
4. Remove the corresponding module/method names, raw JSON requests, and duplicate DTO parsing from YAQMC's QQ
   Provider.

### 6.4 Acceptance criteria

- Native playback crosses at least three batches without a renderer `ended` race or repeated first song.
- Guess and radar use one Core state machine while preserving distinct seeds/cursors.
- Deterministic tests cover next, seek, Repeat One/All, shuffle, queue edits, account switches, and sign-out.
- Delayed responses cannot mutate a new session; duplicates, empty batches, and provider failures cannot loop forever.
- Guest fallback is declared by provider capability, not guessed in UI.

## 7. Workstream C: local listening statistics

### 7.1 Definitions

Core accumulates active listening from the playback engine clock, not wall-clock estimates:

- `listenedMs` increases only while the same `sessionId` is `Playing` and engine position advances normally.
- Pause, buffering, seek jumps, and error-recovery waits do not add time.
- A qualified play reaches `min(30 seconds, 50% of known playable duration)`; unknown duration uses 30 seconds.
- `completed`: authoritative EOS.
- `qualified`: threshold reached before Next, a queue jump, stop, or queue replacement.
- `skipped`: explicit Next or queue jump before the threshold.
- `stopped`: stop, shutdown, or queue replacement before the threshold.
- `error`: unrecoverable failure before the threshold. A later failure after the threshold remains `qualified` with
  an error flag.
- Repeat One finalizes one record at each EOS and starts a new one. Preview uses its actual playable duration.

### 7.2 Storage

Add a dedicated `listening_sessions` table; preserve `playback_history` for recent-play snapshots. Each record contains:

- Opaque session ID, provider/track/album/artist identifiers, and a normalized display snapshot.
- Start/end timestamps, listened milliseconds, playable duration, outcome, and source context.
- Requested quality, resolved quality, and preview status. It never contains URLs, headers, cookies, account tokens,
  or raw upstream JSON.

An active record accumulates in memory and checkpoints transactionally every 15 seconds and on each track/playback
state transition, bounding crash loss to one checkpoint interval. Startup finalizes orphaned `in_progress` records as
`stopped`. The first version retains all records for exact all-time results and displays database use. Introduce a
versioned rollup later only if measured data shows aggregation becoming slow.

Indexes cover end time, `provider + track`, album, and artist. Each clock update is O(1) in memory; a checkpoint is
O(log n) because of indexed database writes. Range aggregation is O(n) in the worst case and uses indexes and paged
result limits in v1.

### 7.3 UI and protocol

Add a **Statistics** sidebar page with rolling 7-day, 30-day, 365-day, and all-time ranges:

- Qualified listening time, qualified play count, completions, and skip rate.
- Top songs, artists, and albums.
- Daily listening trend, quality distribution, and provider distribution.
- JSON/CSV export, database use, and a confirm-before-delete clear action.

Renderer invokes typed Core methods such as `statistics_snapshot(range)`, `statistics_export(format)`, and
`statistics_clear()`. Electron's save dialog and Core cooperate on output location so plugins and auxiliary windows
do not gain arbitrary-path access. Core publishes `statistics.changed`; UI refresh is throttled and never queries at
playback-clock frequency.

### 7.4 Acceptance criteria

- Deterministic clock tests cover pause, buffering, seek, next, previous, repeat, preview, errors, and crash recovery.
- UI, JSON, and CSV totals match for the same scripted playback history.
- Clear is atomic and cannot delete queue, cache, account, or recent-search data.
- Statistics work offline and network capture shows no statistics upload.
- Common range queries remain interactive with 100,000 sessions on the target machine. If they do not, a rollup or
  query optimization is required before delivery.

## 8. Workstream D: categorized Discover tabs

The first version adds no network API and leaves `DiscoverFeed` caching unchanged. It only reorganizes existing data:

- **Featured**: featured cards and popular songlists.
- **Charts**: charts.
- **New songs**: new songs.
- **New albums**: new albums.
- **Categories**: areas/categories.
- **MVs**: new MVs.
- **Podcasts**: podcasts.

Only non-empty categories produce tabs. If refresh removes the active category, selection falls back to the first
available one. Selection is remembered per provider for the current application session, not persisted as a long-term
preference. Narrow windows scroll the tab strip horizontally instead of shrinking labels to unreadable sizes.

Reuse Artist/Search accessibility behavior: `tablist`, `tab`, `tabpanel`, `aria-selected`, `aria-controls`, roving
`tabIndex`, and Left/Right/Home/End. The current feed is preloaded, so focus movement may activate instantly. If a
future plugin category becomes slow and lazy-loaded, use Enter/Space manual activation so network latency does not
block keyboard focus. Follow the
[W3C WAI-ARIA Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/).

Acceptance criteria:

- Initial load still makes one Discover request; periodic refresh and stale-content retention are unchanged.
- Mouse, keyboard, and screen-reader relationships are complete, and hidden panels are not focusable.
- Tests cover empty categories, category changes after refresh, narrow windows, errors, and stale cache.
- Existing Play/Open semantics remain intact; changing tabs does not reset playback or the whole-app scroll position.

## 9. Workstream E: Provider plugins v3

### 9.1 Runtime choice

Provider plugins do not execute in a renderer Worker and do not load native dynamic libraries. Plugin API v3 uses
WebAssembly Component Model hosted by Wasmtime, initially pinned to WASI 0.2 and a versioned custom WIT world. Version
0.2 is chosen for a stable, pinnable toolchain; WASI 0.3 is considered only after compatibility and Rust tooling are
validated.

WIT explicitly declares component exports and imports. A capability that is not granted does not exist in the
instance. The Component Model describes worlds as strict import/export boundaries; see
[Component Model Worlds](https://component-model.bytecodealliance.org/design/worlds.html).

### 9.2 Manifest and capabilities

Add `manifestVersion: 2`, `apiVersion: 3`, and a component entry point. A plugin may compose:

- `provider.catalog`: platform catalog, search, entities, and Discover content.
- `provider.playback`: source matching and resolution.
- `provider.recommendation`: Home recommendations and continuation.
- `provider.lyrics`: lyrics source.
- `provider.account`: sign-in, account state, and account library for that plugin's provider.

Account capability is bound to the same plugin provider instance. It cannot read or replace the built-in QQ account
and cannot become a global credential proxy. A source component returns an opaque source handle or Host request
recipe; signed URLs, headers, and tokens are consumed inside Core and never enter React.

Existing manifest v1 / API v1-v2 keeps current limits. Component-bearing v3 packages use separate limits: 32 MiB
compressed, 96 MiB expanded, 32 MiB per component, and 512 files. Higher limits do not relax zip-slip, symlink,
duplicate-path, or expansion-bomb checks.

### 9.3 Host capabilities and default denial

A WASM instance receives no filesystem, environment, shell, subprocess, raw socket, arbitrary IPC, or host
credentials by default. Manifest declaration plus user consent may grant:

- Exact-origin HTTPS proxy. Every redirect repeats scheme, DNS, and private/loopback-address validation.
- Plugin-private credential handles. Only that plugin can reference them in Host requests; it cannot enumerate or
  read other domains.
- 4 MiB plugin KV settings, 64 MiB managed cache, monotonic clock, randomness, and redacted logging.
- Restricted account-auth window. It loads only manifest allowlisted origins and accepts callbacks bound to a random
  state value.

Default resource budgets are 64 MiB memory per instance, four concurrent Host requests, 4 MiB per response, a
15-second operation deadline, and independent CPU fuel/epoch interruption. Three consecutive sandbox faults open a
session circuit breaker and explain why the plugin stopped. Added network/account permissions or origins require new
consent on update.

Provider plugins are local sideloads marked **unverified publisher** in the first version. There is no marketplace,
remote update, or signing trust yet. Plugins cannot add arbitrary HTML settings; settings remain declarative schemas
and safe UI slots.

### 9.4 Delivery order

1. Complete dynamic `ProviderRegistry`, capability decomposition, and a behavior-preserving built-in QQ adapter.
2. Define and freeze WIT v0.1 with a Rust example component and contract fixtures.
3. Deliver a read-only catalog plugin: search, song, album, and artist.
4. Deliver a source plugin: opaque handles, Core-internal streaming, cancellation, and entitlement errors.
5. Deliver an account plugin: auth window, plugin credential domain, sign-in/out, and account switching.
6. Open recommendation, Discover, and lyrics capabilities only after each gains its own permission and example.

### 9.5 Acceptance criteria

- Windows/Linux x64 and arm64 run the same component package without platform-native binaries.
- An example platform plugin can search, open entities, and play; an example account plugin sees only its credentials.
- Malformed components, timeout, OOM, redirect SSRF, DNS rebinding, and zip bombs are isolated and cannot terminate
  Core.
- Disabling/uninstalling a provider produces deterministic unavailable queue/page state; re-enabling can recover.
- Existing Plugin API v1/v2 examples and user data remain compatible.
- Install/update UI explains each permission, and revocation takes effect immediately.

## 10. Delivery phases

### P0: contracts and upstream debt

- Add a compatibility façade for provider capabilities and dynamic IDs without changing user-visible behavior.
- Complete typed recommendation parameters in `qm-api-rs` and remove matching upstream routes from YAQMC.
- Extend protocol fixtures, error models, and provenance while keeping built-in QQ and fake-provider tests green.

Exit: repository scanning no longer finds the migrated module/method strings in YAQMC's QQ adapter, and existing
playback/account matrices have no regression.

### P1: low-risk user interface

- Deliver Discover tabs.
- Deliver ShareTarget, copy-public-link, and plain-text fallback.
- Keep deep-link parsing and Electron registration in a separately revertible commit.

Exit: docs, i18n, accessibility, unit tests, and local Electron deep-link integration tests pass.

### P2: Core continuous recommendations

- Add `ContinuationService`, a Core protocol projection, and migrate Guess.
- Add radar sessions, prefetch, deduplication, retries, and account generation.
- Remove renderer session truth and the old continuation Hook.

Exit: native deterministic player matrix and local fake-provider E2E pass. LIVE acceptance remains maintainer-gated.

### P3: local statistics

- Add schema migration, Core recorder/aggregator, export/clear protocol, and Statistics Page.
- Benchmark a large local dataset and decide whether v1 needs rollups.

Exit: clock semantics, migration/crash recovery, privacy scan, and the 100,000-session performance gate pass.

### P4: Plugin v3 foundation

- Complete the Wasmtime spike, WIT freeze, package v2, consent UX, and resource limits.
- Publish only a read-only catalog example first; do not promise playback or accounts yet.

Exit: security tests and cross-platform component fixtures pass. If sandbox, size, or startup budgets fail, stop
expansion rather than opening source permissions.

### P5: platform, source, and account plugins

- Open playback, account, recommendation, Discover, and lyrics capabilities in that order.
- Add a separate example, threat model, recovery policy, and update re-consent test for each capability.

Exit: end-to-end examples, cross-provider queues, account isolation, circuit breaking, and v1/v2 compatibility pass.

### P6: release closure

- Update bilingual user/developer docs, OpenAPI/protocol fixtures, third-party licenses, and release provenance.
- Complete the local Windows automatic matrix plus native Linux and Windows CI matrices, and produce reproducible
  evidence.
- The implementer reports automated results and unexecuted HUMAN/LIVE items first. The maintainer then decides whether
  to authorize real-account, GUI, LIVE, packaging, and final HUMAN acceptance.

Automatic closure evidence: [Provider Component v3](release/provider-component-v3.md). Release readiness remains
blocked by the exact-pin three-day provider soak; no GUI, LIVE, real-account, packaging, or HUMAN result is implied.

## 11. Test and quality gates

Each phase includes at least:

- TypeScript unit/component tests, Rust unit/integration tests, and protocol golden fixtures.
- Deterministic fake-provider flows. Test data must not enter the release renderer or production package.
- Core restart, cancellation, stale-response, empty-result, error-mapping, and concurrency-race tests.
- Electron E2E may use Playwright only as an Electron automation driver. It does not create a browser product target,
  and its harness is not packaged.
- `cargo fmt`, MSRV `cargo check/clippy/test`, TypeScript, ESLint, Prettier, public-doc checks, and secret scan.
- Plugin phases additionally run manifest/package fuzzing, WASM resource exhaustion, SSRF, redirects, DNS rebinding,
  credential isolation, and recovery tests.

Performance budgets:

- Discover tab changes make no network request and render in linear time relative only to the active section.
- Recommendation batch processing is O(b); seen-key lookup is amortized O(1) per song and capped at 500 keys.
- Statistics clock ticks remain O(1) regardless of history size.
- Plugin memory, concurrency, response size, and deadlines are bounded; plugin failure cannot block the player clock
  or main window.

## 12. Principal risks and trade-offs

- Provider plugins are the largest scope and highest security risk. They must follow capability decomposition and the
  Wasmtime gate and cannot be trusted like style plugins.
- Deep links improve sharing but expand external input. They therefore navigate only and never express commands.
- Statistics definitions are product policy. This roadmap freezes v1 semantics; later changes must be versioned and
  must not silently reinterpret history.
- Recommendation APIs can depend on account state, rate limits, and upstream shape. Prefetch reduces gaps but makes
  extra requests and must cancel immediately when a session ends.
- Cross-provider queues improve extensibility while exposing disabled providers. Explicit unavailable state is safer
  and more predictable than automatic cross-platform matching.
- WASM adds binary size and startup cost but provides portability and capability isolation. If the spike exceeds
  budget, retain v2; do not replace it with an unsafe Node/native design.

## 13. Definition of done

A feature is complete only when all of the following are true:

- Production code uses the correct Core/Provider/Host boundary, with no renderer upstream API or new QQ route string.
- Normal, empty, error, cancellation, stale-response, restart, and permission-revocation paths are tested.
- Bilingual user docs, developer contracts, privacy, and security guidance are updated together.
- Release builds contain no fake data, test entry points, Playwright harness, fixtures, or debug switches.
- Automated evidence and unexecuted HUMAN/LIVE work are reported accurately; a waiver is not reported as PASS.
- The maintainer explicitly authorizes final acceptance after the implementation report. Production accounts and
  releases remain untouched until then.
