# QQ Music Authenticated Account Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing QQ Music guest provider into a secure, account-aware provider with Rust-owned QR authorization, paged account library reads, safe favorite/playlist mutations, and entitlement-aware playback while preserving guest Home and the single existing player engine.

**Architecture:** `QQMusicService` remains the only QQ Music provider and composes a Rust-owned auth service, hardened transport, account adapter, account cache, and entitlement resolver. React receives only provider-independent, sanitized projections through main-window-only Tauri commands; raw cookies, QR challenges, signed URLs, and provider DTOs remain native. Account writes use client operation IDs and read-after-write reconciliation, while playback continues through the existing `PlaybackSourceResolver -> ResolvedPlaybackSource -> CachedMediaPreparer -> AudioEngine -> PlayerService` path.

**Tech Stack:** Rust 1.88, Tokio, reqwest 0.13, keyring 4.1, serde/serde_json, rusqlite, Tauri 2 ACL and commands, React 19, TypeScript 6, Zustand 5, Vitest/Testing Library, Cargo test/Clippy/rustfmt, ESLint/Prettier.

## Global Constraints

- Keep `QQMusicService`/`QQMusicProvider` as the single guest-and-account provider; do not introduce a logged-in sibling provider or a second playback engine.
- Preserve public guest Home, Search, Explore, albums, playlists/toplists, lyrics, and legitimate guest playback independently of account restore, account cache, or account endpoint failures.
- Support one active QQ Music session; multi-account management and account switching are outside this phase.
- Implement one current, independently observed QQ QR authorization flow without collecting a QQ password, importing browser cookies, or sending credentials to a proxy/third party.
- The native layer owns QR creation and polling, session validation, secure persistence, account DTOs, authenticated requests, mutation reconciliation, and entitlement decisions.
- React, Tauri events, the local HTTP API, logs, telemetry, crash output, committed fixtures, docs, screenshots, localStorage, ordinary JSON settings, SQLite, and cache keys must never contain a raw QR URL/token, polling key, callback URL, cookie, `qm_keyst`, UIN-linked credential, authorization header, refresh/session token, or signed media URL.
- React may receive only an opaque login-attempt ID, a path-only rendered QR SVG/PNG data URI, expiry/poll metadata, sanitized account/profile/entitlement state, normalized library entities, and typed mutation results.
- Clear the rendered QR image on cancel, expiry, rejection, success, dialog close, component unmount, and refresh; never regenerate or continue polling without an owning main-window dialog.
- Only the `main` WebView may invoke account/auth/library/mutation commands. `lyrics-desktop` and `lyrics-island` receive neither account custom-command permissions nor account events, and every sensitive command also checks `WebviewWindow::label() == "main"` in Rust.
- Every authenticated request uses a dedicated direct/no-proxy HTTPS client and an exact host allowlist. Follow only 301/302/303/307/308, revalidate each redirect hop, cap redirects at three, strip the complete reviewed secret-header set before any cross-origin redirect, and reject cross-origin authenticated/body-preserving 307/308.
- Route synchronous OS keyring operations through `tokio::task::spawn_blocking`; no keyring call may run directly on a Tokio worker.
- Only offline, timeout, and rate-limit classes on explicitly safe reads receive one bounded retry. Never blindly retry a write or a QR poll; a timeout/disconnect after a write may have been sent and must become `outcome-unknown` followed by bounded read-after-write reconciliation.
- A successful login promotion is ordered: validate upstream session -> save a staging credential -> read it back -> validate the readback -> promote the active credential -> read back the active credential -> publish `Authenticated`. Any failure removes staging and preserves the prior active session/projection.
- Logout increments the auth generation before cancelling polling, deletes staging/active credentials, clears only authenticated account caches and pending mutations, and leaves appearance, playback preferences, local playback history, guest catalog caches, and guest browsing intact.
- Restore, promotion, and logout share one lifecycle mutex. Every account read/write captures generation plus opaque account scope and rechecks it around awaits, retries, reconciliation, cache commits, and UI commits; stale work returns typed `cancelled` and cannot affect a replacement login.
- Account cache keys use an opaque random account scope, never UIN/cookie/token material. Remote recent history remains labeled separately from local playback history.
- Playlist actions come only from normalized per-playlist capabilities: `canAddTracks`, `canRemoveTracks`, `canRename`, `canDelete`, and `canReorder`. Collected playlists never expose owner-only controls.
- Live write acceptance may operate only on a newly created playlist whose name begins `YAQMC Integration Test (` and contains the run timestamp; record its returned ID, never rename/delete an existing playlist, and report cleanup failure prominently.
- Entitlement selection is deterministic: Automatic = highest entitled available full source, then standard, then official preview; Standard = standard full source then official preview; High = high then standard then official preview; Lossless = lossless then high then standard then official preview. No paid-rights, DRM, payment, or region authorization bypass is permitted.
- Account login must not regress QRC/LRC normalization, translation, romanization, word timing, lyric cache, Fullscreen Lyrics, Desktop Lyrics, Lyrics Island, Range streaming, local API/SSE, MPRIS, SMTC, tray, media keys, output-device switching, or one-time expiring-URL re-resolution.
- Do not modify `docs/superpowers/plans/2026-08-11-lyrics-focus-fullscreen.md` or fold Lyrics Task 6 work into these commits. Run its affected regression tests as verification only.
- Research captures and live acceptance transcripts stay under ignored `output/`; committed fixtures must be synthetic and shape-preserving.
- Do not advertise account capability until deterministic gates pass; do not claim live verification until the owner QR scan/account acceptance actually succeeds.
- Rust production files use `cargo fmt`; frontend production files use Prettier. Every implementation task follows red-green-refactor, ends in an independently reviewable commit, and preserves unrelated worktree changes.
- Create and edit tracked sources, scripts, fixtures, and docs with `apply_patch`. Shell commands may run tests and reviewed scripts; they must not synthesize tracked file bodies with `Set-Content`, `Out-File`, redirection, or equivalent write tricks.

### Complexity and bounded-work budgets

- Normalize each returned account page in `O(n)` time and `O(n)` output space for that page; cap `n` at 100 and use expected-`O(1)` stable-ID membership maps/sets rather than rescanning all loaded pages per row.
- Keep cursor lookup and completed-operation lookup expected `O(1)` with bounded in-memory maps. Key both by the complete account epoch, clear them on generation/scope change, and cap the current epoch's completed operation IDs at 256.
- Bound mutation reconciliation to three safe reads; never scan an unbounded remote library and never turn reconciliation into a write retry.
- Evaluate playback candidates in `O(q)` time and `O(q)` temporary space, where `q <= 4` normalized qualities. Do not add a second queue, decoder, or playback state machine.
- Account-cache invalidation is `O(k)` in the account-cache rows selected by the existing `(kind, expires_at)` index; it must not scan or delete guest catalog cache kinds, local history, or settings.

### Authoritative implementation references

- Tauri 2 capabilities and custom-command permissions: `https://v2.tauri.app/security/capabilities/` and `https://v2.tauri.app/security/permissions/`
- Tauri command caller injection (`WebviewWindow`): `https://v2.tauri.app/develop/calling-rust/`
- Tokio blocking-boundary contract: `https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html`
- reqwest redirect policy API: `https://docs.rs/reqwest/0.13/reqwest/redirect/struct.Policy.html`

---

## File and Responsibility Map

### Native provider and security

- Modify `src-tauri/build.rs`: register the account command names with the Tauri application ACL manifest.
- Create `src-tauri/permissions/qqmusic-account.toml`: one permission set containing only account/auth/library/mutation commands.
- Modify `src-tauri/capabilities/main-window.json`: grant `qqmusic-account` only to `windows: ["main"]`.
- Leave `src-tauri/capabilities/default.json` account-free: the lyric WebViews retain only their existing minimal core/drag permissions.
- Create `src-tauri/src/command_guard.rs`: defense-in-depth caller-label check shared by every sensitive command.
- Modify `src-tauri/src/credentials.rs`: retain the blocking backend used by startup/local API and add an async `spawn_blocking` adapter for account auth.
- Create `src-tauri/src/qqmusic/clock.rs`: injectable wall clock for expiry, polling, cache freshness, and deterministic tests.
- Create `src-tauri/src/qqmusic/redaction.rs`: secret-key/header/URL redaction plus sanitized request diagnostics.
- Create `src-tauri/src/qqmusic/transport.rs`: dedicated direct/no-proxy account transport with exact HTTPS host allowlist, three-hop manual redirect policy, cross-origin secret stripping, timeout/cancellation/write-uncertainty classification, while preserving the ordinary public/media client.
- Create `src-tauri/src/qqmusic/auth.rs`: auth state machine, single attempt/generation ownership, QR rendering, bounded native polling, session staging/promotion/restore/logout.
- Create `src-tauri/src/qqmusic/account.rs`: account profile/entitlement/library DTO parsing, pagination, normalized reads, mutation requests, and operation-specific reconciliation.
- Create `src-tauri/src/qqmusic/cache.rs`: opaque account scope keys, stale/fresh account projections, and account-only invalidation over `StorageService`.
- Create `src-tauri/src/qqmusic/entitlement.rs`: normalized account rights and deterministic source candidate decision matrix.
- Modify `src-tauri/src/qqmusic.rs`: compose the new modules into the existing service, preserve public methods, split public and account status, and delegate playback candidate selection.
- Modify `src-tauri/src/storage.rs`: delete provider cache entries by exact kind and test that guest metadata/history/settings survive account invalidation.
- Modify `src-tauri/src/media.rs`: carry typed requested/resolved quality, fallback reason, and a nonserializable account-epoch cancellation guard through `ResolvedPlaybackSource`/`PreparedPlaybackSource` without exposing signed URLs.
- Modify `src-tauri/src/audio.rs`: retain and validate the prepared epoch guard immediately before source load and every play/resume without changing decoder ownership.
- Modify `src-tauri/src/player.rs`: validate the guard at preparation/load/play/final-commit boundaries, publish only the sanitized source-selection projection, preserve the ordinary media client, and retain one-time URL refresh behavior.
- Modify `src-tauri/src/commands.rs`: add main-window-guarded auth/account/read/mutation commands and remove account state from the public catalog status command.
- Modify `src-tauri/src/lib.rs`: register/manage the composed service, restore the account session asynchronously, and register the new command names without global account events.

### Frontend contract and UI

- Modify `src/domain/music.ts`: provider-independent account, pagination, playlist capability, mutation, entitlement, and source-selection types.
- Modify `src/providers/music-provider.ts`: keep `MusicProvider` catalog-only and add a narrow `AccountMusicProvider` extension plus type guard.
- Modify `src/providers/qqmusic/qq-music-provider.ts`: main-window IPC adapter implementing the account extension.
- Create `src/application/account-runtime.ts`: sanitized account store, login-dialog ownership, refresh/cancel/logout, pagination, normalized optimistic rollback, reconciliation, and account-cache convergence.
- Create `src/application/account-runtime.test.ts`: IPC-free deterministic state/mutation tests with a fake `AccountMusicProvider`.
- Create `src/components/AccountDialog.tsx` and `src/components/AccountDialog.test.tsx`: accessible QR/auth state UI that never renders raw challenge material.
- Modify `src/pages/SettingsPage.tsx`: account/profile/membership surface and preferred-versus-observed quality display.
- Modify `src/pages/LibraryPage.tsx`; create `src/pages/LibraryPage.test.tsx`: account-required/loading/empty/stale/reauth/retry states, paged Favorites/My Playlists/remote Recently Played.
- Modify `src/pages/PlaylistPage.tsx` and the Task 10-created `src/pages/PlaylistPage.test.tsx`: capability-gated rename/add/remove/delete controls and pending/error states.
- Modify `src/components/Sidebar.tsx`: separate Favorites, My Playlists, and Recently Played destinations while leaving Home/Search/Explore unchanged.
- Modify `src/components/TrackList.tsx`, `src/components/PlayerBar.tsx`, `src/pages/AlbumPage.tsx`: one shared favorite projection and mutation action; display typed source fallback without parsing provider strings.
- Modify `src/application/navigation.ts`, `src/application/provider-root.tsx`, `src/application/provider-context.ts`, `src/App.tsx`: route account pages and mount one account runtime without coupling guest catalog loading to account state.
- Modify `src/application/provider-settings.ts`: catalog connection/cache/quality settings only; consume sanitized account runtime instead of invoking sign-out directly.
- Modify `src/application/player-store.ts` and `src/application/native-player-runtime.ts`: consume the sanitized native source-selection projection.
- Modify `src/providers/fake/fake-music-provider.ts`, `src/providers/fake/fixtures.ts`, and `src/providers/fake/fake-music-provider.test.ts`: prove the catalog-only fake provider remains valid and guest development does not require account methods.
- Modify `src/locales/en-US.ts`, `src/locales/zh-CN.ts`, `src/styles/components.css`, `src/styles/pages.css`: localized accessible states/actions and restrained dialog/library/mutation styling.

### Fixtures, scans, documentation, and gates

- Create sanitized fixtures under `src-tauri/tests/fixtures/qqmusic/account/`: profile, entitlement combinations, favorite pages, owned/collected playlists, recent history, mutation success/rejection/unknown reconciliation, and auth status shapes. Values use `SANITIZED_*` identifiers and non-live URLs only.
- Create `scripts/check-secrets.ps1`: tracked-file scanner with field-name documentation allowlist and assigned-token/value detection.
- Create `scripts/check-secrets.sh`: equivalent Linux/CI scanner.
- Create `scripts/invoke-qqmusic-auth-preflight-command.ps1` and `scripts/run-qqmusic-auth-preflight.ps1`: Windows PowerShell 5.1-safe fixed-ID command harness plus deterministic pre-QR runner.
- Create `scripts/record-qqmusic-live-acceptance.ps1`: fixed-enum, secret-free live-gate recorder that alone writes ignored acceptance evidence.
- Modify `.github/workflows/build.yml`: run both platform-appropriate secret scan and existing test/build gates before packaging.
- Modify `docs/qqmusic-provider.md`, `docs/authentication.md`, `docs/provider-contract.md`, `docs/caching.md`, `docs/playback.md`, `docs/architecture.md`, and `README.md`; create `docs/account-library.md` and `docs/entitlement.md`.
- Store current live protocol captures and human acceptance transcript only under `output/qqmusic-auth-account/`.

### Task 1: Freeze the Current Protocol and Provenance Gate

**Files:**

- Modify: `docs/qqmusic-provider.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: approved design source pins `L-1124/QQMusicApi@108617ffe80abefec6358717b9f4d3677550db10`, `wxuyu/QQMusicApi@44c3b26c8741521266c63002844564392a1fa38c`, and `RethinkQAQ/allmusic-qqmusicapi@a828f1f2d2dc8416bd1a549ee4c14efbb8ba4974`.
- Produces: a dated endpoint ledger in `docs/qqmusic-provider.md` with one row each for QR create, QR status, post-confirmation exchange, session validation/profile, Favorites read/write, playlist summaries/detail/create/rename/add/remove/delete, recent history, entitlement, and playback vkey. Every row records exact HTTPS host/path plus CGI module/method, request class (`public-read`, `account-read`, `auth-poll`, or `account-write`), sanitized request-key names/pagination controls, conceptual secret inputs, every exact secret-bearing request header name (or literal `none`), result-code literals, exact corroborating repository/commit/path, live-observation date/status, and confidence.
- Produces: a factual `README.md` acknowledgement stating the three repositories were protocol references and no source was copied; account capability remains described as pending until the deterministic and live gates pass.

- [ ] **Step 1: Verify the pinned source objects and licenses without copying them into the tracked tree**

Run the read-only API checks:

```powershell
$headers = @{ 'User-Agent' = 'YAQMC-interoperability-audit' }
$sources = @(
  @{ Repo = 'L-1124/QQMusicApi'; Sha = '108617ffe80abefec6358717b9f4d3677550db10' },
  @{ Repo = 'wxuyu/QQMusicApi'; Sha = '44c3b26c8741521266c63002844564392a1fa38c' },
  @{ Repo = 'RethinkQAQ/allmusic-qqmusicapi'; Sha = 'a828f1f2d2dc8416bd1a549ee4c14efbb8ba4974' }
)
foreach ($source in $sources) {
  $commit = Invoke-RestMethod -Headers $headers `
    -Uri "https://api.github.com/repos/$($source.Repo)/commits/$($source.Sha)"
  if ($commit.sha -ne $source.Sha) { throw "Commit mismatch for $($source.Repo)" }
  $license = Invoke-RestMethod -Headers $headers `
    -Uri "https://api.github.com/repos/$($source.Repo)/license?ref=$($source.Sha)"
  $commitEvidence = [pscustomobject]@{
    repository = $source.Repo
    commit = $commit.sha
    committedAtUtc = $commit.commit.committer.date
    githubLicenseSpdx = $license.license.spdx_id
  }
  $commitEvidence | ConvertTo-Json -Compress
}
$l1124Metadata = (Invoke-WebRequest -UseBasicParsing -Headers $headers `
  -Uri 'https://raw.githubusercontent.com/L-1124/QQMusicApi/108617ffe80abefec6358717b9f4d3677550db10/pyproject.toml').Content
if ($l1124Metadata -notmatch 'GNU General Public License v3 or later \(GPLv3\+\)') {
  throw 'Pinned L-1124 license classifier changed'
}
[pscustomobject]@{
  repository = 'L-1124/QQMusicApi'
  metadataClassifier = 'GNU General Public License v3 or later (GPLv3+)'
} | ConvertTo-Json -Compress
```

Expected: each commit API response returns the exact requested 40-character SHA and commit timestamp. Record the pinned license evidence exactly: GitHub classifies `L-1124/QQMusicApi` as `GPL-3.0` while its pinned `pyproject.toml` classifier says GPLv3-or-later, `wxuyu/QQMusicApi` as MIT, and `RethinkQAQ/allmusic-qqmusicapi` as `LGPL-3.0`; preserve the `RethinkQAQ` metadata/provenance caveat rather than upgrading any result to a stronger claim.

- [ ] **Step 2: Inspect only the pinned auth/account implementation paths without saving source bodies**

Run:

```powershell
$headers = @{ 'User-Agent' = 'YAQMC-interoperability-audit' }
$targets = @(
  @{ Repo='L-1124/QQMusicApi'; Sha='108617ffe80abefec6358717b9f4d3677550db10'; Paths=@('qqmusic_api/modules/login.py','qqmusic_api/modules/login_utils.py','qqmusic_api/modules/user.py','qqmusic_api/modules/songlist.py','qqmusic_api/modules/song.py','qqmusic_api/models/request.py') },
  @{ Repo='wxuyu/QQMusicApi'; Sha='44c3b26c8741521266c63002844564392a1fa38c'; Paths=@('src/services/apis/user/getQQLoginQr.ts','src/services/apis/user/checkQQLoginQr.ts','src/services/apis/user/getUserLikedSongs.ts','src/services/apis/user/getUserPlaylists.ts','src/services/apis/user/getUserCollections.ts','src/services/apis/user/getUserDetail.ts','src/services/apis/songLists/songListDetail.ts','src/config/user-info.ts') },
  @{ Repo='RethinkQAQ/allmusic-qqmusicapi'; Sha='a828f1f2d2dc8416bd1a549ee4c14efbb8ba4974'; Paths=@('src/main/java/qqmusicapi/QQMusicLoginHelper.java') }
)
$operationsByPath = @{
  'qqmusic_api/modules/login.py' = @('QR create','QR status','post-confirmation exchange','session validation/profile')
  'qqmusic_api/modules/login_utils.py' = @('QR status','post-confirmation exchange')
  'qqmusic_api/modules/user.py' = @('session validation/profile','Favorites read','Favorites write','recent history','entitlement')
  'qqmusic_api/modules/songlist.py' = @('playlist summaries','playlist detail','playlist create','playlist rename','playlist add','playlist remove','playlist delete')
  'qqmusic_api/modules/song.py' = @('playback vkey','entitlement')
  'qqmusic_api/models/request.py' = @('session validation/profile','Favorites read','Favorites write','playlist summaries','playlist detail','playlist create','playlist rename','playlist add','playlist remove','playlist delete','recent history','entitlement','playback vkey')
  'src/services/apis/user/getQQLoginQr.ts' = @('QR create')
  'src/services/apis/user/checkQQLoginQr.ts' = @('QR status','post-confirmation exchange')
  'src/services/apis/user/getUserLikedSongs.ts' = @('Favorites read','Favorites write')
  'src/services/apis/user/getUserPlaylists.ts' = @('playlist summaries')
  'src/services/apis/user/getUserCollections.ts' = @('playlist summaries')
  'src/services/apis/user/getUserDetail.ts' = @('session validation/profile','entitlement')
  'src/services/apis/songLists/songListDetail.ts' = @('playlist detail')
  'src/config/user-info.ts' = @('session validation/profile')
  'src/main/java/qqmusicapi/QQMusicLoginHelper.java' = @('QR create','QR status','post-confirmation exchange')
}
$index = foreach ($target in $targets) {
  foreach ($path in $target.Paths) {
    $uri = "https://raw.githubusercontent.com/$($target.Repo)/$($target.Sha)/$path"
    $body = (Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $uri).Content
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    $hash = (Get-FileHash -InputStream ([IO.MemoryStream]::new($bytes)) -Algorithm SHA256).Hash.ToLowerInvariant()
    $endpoints = [regex]::Matches($body, 'https://[A-Za-z0-9.-]+/[A-Za-z0-9_./-]*') |
      ForEach-Object Value | Sort-Object -Unique
    $moduleMethods = [regex]::Matches(
      $body,
      '(?i)(?:module|method)\s*[:=]\s*["'']([A-Za-z0-9_.-]+)["'']'
    ) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
    $headerNames = [regex]::Matches(
      $body,
      '(?i)(?:headers?\s*[.\[]|headers?\s*[:=][^{]*\{)[^\r\n]{0,160}?["'']([A-Za-z][A-Za-z0-9-]{1,63})["'']'
    ) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
    $requestKeys = [regex]::Matches(
      $body,
      '["'']([A-Za-z_][A-Za-z0-9_]{1,63})["'']\s*:'
    ) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
    $paginationKeys = @($requestKeys | Where-Object {
      $_ -match '^(begin|cursor|ein|limit|num|offset|page|pageNo|pageSize|sin|size)$'
    })
    $resultCodes = [regex]::Matches(
      $body,
      '(?i)(?:code|ret|status)\s*(?:==|===|:|=)\s*["'']?(-?[0-9]{1,8}|[A-Za-z][A-Za-z0-9_-]{1,31})'
    ) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
    [pscustomobject]@{
      repository = $target.Repo
      commit = $target.Sha
      path = $path
      sha256 = $hash
      operations = @($operationsByPath[$path])
      endpointConstants = @($endpoints)
      moduleMethods = @($moduleMethods)
      headerNames = @($headerNames)
      requestKeys = @($requestKeys)
      paginationKeys = @($paginationKeys)
      resultCodeLiterals = @($resultCodes)
      corroboration = "$($target.Repo)@$($target.Sha):$path"
    }
  }
}
if ($index.Where({ $_.commit.Length -ne 40 -or $_.sha256.Length -ne 64 })) {
  throw 'A provenance hash was truncated'
}
foreach ($operation in $operationsByPath.Values | ForEach-Object { $_ } | Sort-Object -Unique) {
  if (-not $index.Where({ $_.operations -contains $operation })) {
    throw "No sanitized inspection evidence for operation: $operation"
  }
}
$index | ConvertTo-Json -Depth 6
```

Expected: nontruncating JSON contains each full 40-character commit and 64-character content SHA-256 plus operation tags, path-only endpoint constants, module/method literals, header names, request-key names, pagination-key names, result-code literals, and exact source corroboration. It contains no header/request values, source excerpt, reference source body, response body, cookie, or QR artifact and writes nothing to the repository or `output/`.

- [ ] **Step 3: Corroborate protocol declarations without creating or polling a live QR**

Compare the pinned reference paths against the current static request definitions and existing synthetic public-catalog fixtures. Do not open a login page that auto-generates a challenge, call QR-create/status endpoints, receive QR cookies, poll, or run any ignored/live test. Run only the deterministic public parser/normalization contract checks already present in the repository:

```powershell
$ignored = cargo test --manifest-path src-tauri/Cargo.toml qqmusic::tests::live_ -- --ignored --list
foreach ($name in @(
  'live_search_second_page_contract',
  'live_public_catalog_search_and_lyrics',
  'live_guest_source_downloads_decodes_and_uses_real_audio_clock'
)) {
  if ($ignored -notmatch [regex]::Escape($name)) { throw "Expected ignored test is missing: $name" }
}
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::tests -- --nocapture
```

Expected: the eight current deterministic QQ catalog/lyrics/CDN tests PASS and the three `live_*` tests remain ignored. Auth rows are labeled `reference-correlated; live acceptance pending` until Task 16 performs the first live challenge after Task 15 passes every deterministic gate. Any disagreement is recorded as `endpoint-changed` or `unknown`, never as verified behavior.

- [ ] **Step 4: Write the endpoint/provenance ledger and explicit implementation decision**

Add to `docs/qqmusic-provider.md`:

```markdown
## Authenticated interoperability ledger (observed 2026-08-11)

Each row records current observable protocol behavior, not a supported public SDK. GPL/LGPL sources were used only to locate behaviors for independent observation; YAQMC's Rust implementation is original.

| Operation | Exact host/path + module/method | Class | Request keys/pagination | Secret inputs (conceptual only) | Secret header names | Result codes | Corroboration | Live date/status | Confidence |
| --------- | ------------------------------- | ----- | ----------------------- | ------------------------------- | ------------------- | ------------ | ------------- | ---------------- | ---------- |
```

Populate all operations named in this task from the evidence. Under the table, record the selected single QR flow, exact hosts added to the auth allowlist, unsupported operations, the `reference-correlated; live acceptance pending` status for auth requests, and the rule that current observed behavior overrides reference code. Do not claim a successful auth request before Task 16 completes the post-preflight live gate.

Add to `README.md`:

```markdown
## Acknowledgements and research references

QQ Music interoperability research consulted `L-1124/QQMusicApi`, `wxuyu/QQMusicApi`, and `RethinkQAQ/allmusic-qqmusicapi` at the commits recorded in `docs/qqmusic-provider.md`. They were used as protocol-behavior references; YAQMC does not copy or vendor their implementations, and the projects do not endorse YAQMC.
```

- [ ] **Step 5: Verify completeness, non-claims, and ignored evidence**

Run:

```powershell
$required = @(
  'QR create', 'QR status', 'post-confirmation exchange', 'session validation/profile',
  'Favorites read', 'Favorites write', 'playlist summaries', 'playlist detail',
  'playlist create', 'playlist rename', 'playlist add', 'playlist remove',
  'playlist delete', 'recent history', 'entitlement', 'playback vkey'
)
$doc = Get-Content -Raw 'docs/qqmusic-provider.md'
$lines = $doc -split '\r?\n'
foreach ($operation in $required) {
  $rows = @($lines | Where-Object { $_ -match ('^\|\s*' + [regex]::Escape($operation) + '\s*\|') })
  if ($rows.Count -ne 1) { throw "Ledger row count for ${operation}: $($rows.Count)" }
  $cells = @($rows[0].Trim('|').Split('|') | ForEach-Object Trim)
  if ($cells.Count -ne 10 -or $cells.Where({ [string]::IsNullOrWhiteSpace($_) })) {
    throw "Incomplete ledger row: $operation"
  }
  if ($cells[7] -notmatch '@[0-9a-f]{40}:') { throw "Missing exact corroboration: $operation" }
  if ($cells[8] -notmatch '2026-[0-9]{2}-[0-9]{2}|live acceptance pending') {
    throw "Missing live date/status: $operation"
  }
}
$ignored = cargo test --manifest-path src-tauri/Cargo.toml qqmusic::tests::live_ -- --ignored --list
if (@($ignored | Select-String 'live_').Count -ne 3) { throw 'Live tests are not all explicitly ignored' }
$outputState = @(git status --short --ignored --untracked-files=all -- output/)
if ($outputState -match 'qqmusic-auth-account|qr|cookie|protocol-source') {
  throw "Premature ignored account evidence exists: $($outputState -join ', ')"
}
git diff --check
```

Expected: no missing/incomplete operation, every row has exact corroboration and live status, the diff contains no whitespace errors, and the recursive ignored/untracked `output/` status contains no protocol source body, QR artifact, or premature QQ account evidence.

- [ ] **Step 6: Commit the independently reviewable research gate**

```powershell
git add docs/qqmusic-provider.md README.md
git commit -m "docs: freeze qq music account protocol provenance"
```

### Task 2: Restrict Account Commands to the Main WebView

**Files:**

- Modify: `src-tauri/build.rs`
- Create: `src-tauri/permissions/qqmusic-account.toml`
- Modify: `src-tauri/capabilities/main-window.json`
- Create: `src-tauri/src/command_guard.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: inline unit tests in `src-tauri/src/command_guard.rs`

**Interfaces:**

- Consumes: Tauri injects the invoking `tauri::WebviewWindow` into commands.
- Produces: `pub(crate) fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), ProviderCommandError>`.
- Produces: `pub(crate) fn require_main_window_label(label: &str) -> Result<(), ProviderCommandError>` for deterministic tests.
- Produces: `qqmusic-account` ACL permission containing exactly `qqmusic_account_snapshot`, `qqmusic_auth_start`, `qqmusic_auth_heartbeat`, `qqmusic_auth_cancel`, `qqmusic_auth_refresh`, `qqmusic_sign_out`, `qqmusic_favorite_songs`, `qqmusic_account_playlists`, `qqmusic_account_playlist_tracks`, `qqmusic_account_recently_played`, `qqmusic_set_favorite`, `qqmusic_create_playlist`, `qqmusic_rename_playlist`, `qqmusic_add_playlist_track`, `qqmusic_remove_playlist_track`, and `qqmusic_delete_playlist`.

- [ ] **Step 1: Write the failing pure caller-label tests**

Create `src-tauri/src/command_guard.rs` with the tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_is_authorized_for_account_commands() {
        assert!(require_main_window_label("main").is_ok());
    }

    #[test]
    fn lyric_webviews_are_denied_account_commands() {
        for label in ["lyrics-desktop", "lyrics-island", "untrusted"] {
            let error = require_main_window_label(label).expect_err("caller must be denied");
            assert_eq!(error.code, "caller-not-authorized");
            assert!(!error.retryable);
        }
    }
}
```

Declare `mod command_guard;` in `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run the focused test and verify the missing helper failure**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml command_guard::tests -- --nocapture
```

Expected: FAIL because `require_main_window_label` is not defined.

- [ ] **Step 3: Implement the caller guard**

Add above the tests in `src-tauri/src/command_guard.rs`:

```rust
use crate::qqmusic::ProviderCommandError;

pub(crate) fn require_main_window(
    window: &tauri::WebviewWindow,
) -> Result<(), ProviderCommandError> {
    require_main_window_label(window.label())
}

pub(crate) fn require_main_window_label(label: &str) -> Result<(), ProviderCommandError> {
    if label == "main" {
        return Ok(());
    }
    Err(ProviderCommandError {
        code: "caller-not-authorized".to_owned(),
        message: "This account operation is available only to the main application window.".to_owned(),
        retryable: false,
    })
}
```

- [ ] **Step 4: Generate app-command ACL entries and bind the permission only to `main`**

Replace `src-tauri/build.rs` with:

```rust
const ACCOUNT_COMMANDS: &[&str] = &[
    "qqmusic_account_snapshot",
    "qqmusic_auth_start",
    "qqmusic_auth_heartbeat",
    "qqmusic_auth_cancel",
    "qqmusic_auth_refresh",
    "qqmusic_sign_out",
    "qqmusic_favorite_songs",
    "qqmusic_account_playlists",
    "qqmusic_account_playlist_tracks",
    "qqmusic_account_recently_played",
    "qqmusic_set_favorite",
    "qqmusic_create_playlist",
    "qqmusic_rename_playlist",
    "qqmusic_add_playlist_track",
    "qqmusic_remove_playlist_track",
    "qqmusic_delete_playlist",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(ACCOUNT_COMMANDS)),
    )
    .expect("Tauri build metadata must be generated");
}
```

Create `src-tauri/permissions/qqmusic-account.toml`:

```toml
[[set]]
identifier = "qqmusic-account"
description = "Allows the main application WebView to use sanitized QQ Music account operations."
permissions = [
  "allow-qqmusic-account-snapshot",
  "allow-qqmusic-auth-start",
  "allow-qqmusic-auth-heartbeat",
  "allow-qqmusic-auth-cancel",
  "allow-qqmusic-auth-refresh",
  "allow-qqmusic-sign-out",
  "allow-qqmusic-favorite-songs",
  "allow-qqmusic-account-playlists",
  "allow-qqmusic-account-playlist-tracks",
  "allow-qqmusic-account-recently-played",
  "allow-qqmusic-set-favorite",
  "allow-qqmusic-create-playlist",
  "allow-qqmusic-rename-playlist",
  "allow-qqmusic-add-playlist-track",
  "allow-qqmusic-remove-playlist-track",
  "allow-qqmusic-delete-playlist",
]
```

Append `"qqmusic-account"` to `src-tauri/capabilities/main-window.json` permissions. Do not alter `src-tauri/capabilities/default.json`.

- [ ] **Step 5: Verify both ACL layers**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml command_guard::tests -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
$main = Get-Content -Raw 'src-tauri/capabilities/main-window.json'
$lyrics = Get-Content -Raw 'src-tauri/capabilities/default.json'
if ($main -notmatch 'qqmusic-account') { throw 'main capability is missing qqmusic-account' }
if ($lyrics -match 'qqmusic-account|qqmusic_auth|qqmusic_account') { throw 'lyrics capability exposes account commands' }
```

Expected: caller tests PASS, Tauri ACL generation succeeds, main includes the set, and lyric capabilities exclude it.

- [ ] **Step 6: Commit the independently reviewable command boundary**

```powershell
git add src-tauri/build.rs src-tauri/permissions/qqmusic-account.toml src-tauri/capabilities/main-window.json src-tauri/src/command_guard.rs src-tauri/src/lib.rs
git commit -m "security: restrict qq music account commands to main window"
```

### Task 3: Add a Nonblocking Secure-Store Adapter

**Files:**

- Modify: `src-tauri/src/credentials.rs`
- Test: inline unit tests in `src-tauri/src/credentials.rs`

**Interfaces:**

- Consumes: existing synchronous `CredentialStore::{load, save, delete}` used by `LocalApiService`.
- Produces: `SpawnBlockingCredentialStore::new(inner: Arc<dyn CredentialStore>) -> Self`.
- Produces: async methods `load(&self, account: &str) -> Result<Option<String>, CredentialError>`, `save(&self, account: &str, secret: &str) -> Result<(), CredentialError>`, and `delete(&self, account: &str) -> Result<(), CredentialError>`; every method invokes the blocking backend exclusively inside `tokio::task::spawn_blocking`.
- Produces: `CredentialError::JoinFailed` for a failed blocking task; no plaintext fallback.
- Changes test-only `MemoryCredentialStore` from one `Option<String>` to `Mutex<HashMap<String, String>>`, so active and staging account names are isolated like the platform store.

- [ ] **Step 1: Write the failing async round-trip and nonblocking-progress tests**

Add to the existing `credentials.rs` test module:

```rust
#[tokio::test]
async fn async_store_round_trips_through_the_blocking_adapter() {
    let backend: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
    let store = SpawnBlockingCredentialStore::new(backend);

    assert_eq!(store.load("qqmusic-staging").await.expect("load"), None);
    store.save("qqmusic-staging", "session").await.expect("save");
    assert_eq!(
    store.load("qqmusic-staging").await.expect("load"),
    Some("session".to_owned())
);
assert_eq!(store.load("qqmusic-session").await.expect("active load"), None);
store.delete("qqmusic-staging").await.expect("delete");
    assert_eq!(store.load("qqmusic-staging").await.expect("load"), None);
}

#[tokio::test(flavor = "current_thread")]
async fn blocking_backend_does_not_stall_the_async_executor() {
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let backend: Arc<dyn CredentialStore> = Arc::new(BlockingTestStore {
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
    });
    let store = SpawnBlockingCredentialStore::new(backend);
    let load = tokio::spawn(async move { store.load("qqmusic-session").await });
    tokio::task::spawn_blocking(move || entered.wait())
        .await
        .expect("barrier joins");
    tokio::time::timeout(std::time::Duration::from_millis(50), tokio::task::yield_now())
        .await
        .expect("executor remains responsive");
    tokio::task::spawn_blocking(move || release.wait())
        .await
        .expect("release joins");
    assert_eq!(load.await.expect("load joins").expect("load"), None);
}
```

Define `BlockingTestStore` inside the test module as a `CredentialStore` whose `load` waits on both barriers and whose `save`/`delete` return `Ok(())`.

- [ ] **Step 2: Run the focused tests and verify the adapter is absent**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml credentials::tests -- --nocapture
```

Expected: FAIL because `SpawnBlockingCredentialStore` and `CredentialError::JoinFailed` do not exist.

- [ ] **Step 3: Implement the adapter without changing the synchronous backend contract**

Add to `src-tauri/src/credentials.rs`:

```rust
use std::sync::Arc;

#[derive(Clone)]
pub struct SpawnBlockingCredentialStore {
    inner: Arc<dyn CredentialStore>,
}

impl SpawnBlockingCredentialStore {
    pub fn new(inner: Arc<dyn CredentialStore>) -> Self {
        Self { inner }
    }

    pub async fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
        let inner = Arc::clone(&self.inner);
        let account = account.to_owned();
        tokio::task::spawn_blocking(move || inner.load(&account))
            .await
            .map_err(|_| CredentialError::JoinFailed)?
    }

    pub async fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        let inner = Arc::clone(&self.inner);
        let account = account.to_owned();
        let secret = secret.to_owned();
        tokio::task::spawn_blocking(move || inner.save(&account, &secret))
            .await
            .map_err(|_| CredentialError::JoinFailed)?
    }

    pub async fn delete(&self, account: &str) -> Result<(), CredentialError> {
        let inner = Arc::clone(&self.inner);
        let account = account.to_owned();
        tokio::task::spawn_blocking(move || inner.delete(&account))
            .await
            .map_err(|_| CredentialError::JoinFailed)?
    }
}
```

Add `JoinFailed` with message `the secure credential worker failed` to `CredentialError`. Keep `PlatformCredentialStore` and `LocalApiService` on the existing synchronous trait; only QQ auth receives `SpawnBlockingCredentialStore`.

Update test-only `MemoryCredentialStore::{load, save, delete}` to index its mutex-protected `HashMap` by the supplied `account`; deletion removes only that account. This is required for Task 6's distinct staging and active credential records.

- [ ] **Step 4: Preserve the existing constructor boundary**

Do not change setup or any `QQMusicService::new` call site in this task. Tasks 4 and 6 preserve the existing `Arc<dyn CredentialStore>` constructor parameter, and Task 6 constructs the async adapter internally:

```rust
let account_credentials = Arc::new(SpawnBlockingCredentialStore::new(credentials));
```

This line belongs inside the Task 6 constructor, not `src-tauri/src/lib.rs`. The synchronous backend remains available to `LocalApiService`, and each task remains independently compiling.

- [ ] **Step 5: Verify nonblocking behavior and the existing local API credential lifecycle**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml credentials::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml local_api::tests -- --nocapture
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: credential and local API suites PASS; Clippy reports no blocking-in-async adapter mistakes or warnings.

- [ ] **Step 6: Commit the independently reviewable secure-store adapter**

```powershell
git add src-tauri/src/credentials.rs
git commit -m "refactor: isolate keyring work from async runtime"
```

### Task 4: Inject the Clock and Hardened, Redacting Transport

**Files:**

- Create: `src-tauri/src/qqmusic/clock.rs`
- Create: `src-tauri/src/qqmusic/redaction.rs`
- Create: `src-tauri/src/qqmusic/transport.rs`
- Modify: `src-tauri/src/qqmusic.rs`
- Modify: `src-tauri/src/player.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Test: inline unit tests in the three new Rust modules

**Interfaces:**

- Produces: `pub(crate) trait Clock: Send + Sync { fn now_ms(&self) -> u64; }`, `SystemClock`, and test-only `ManualClock::{new, advance}`.
- Produces: `RetryClass::{SafeRead, AuthPoll, Write}`; only `SafeRead` can retry once.
- Produces: `TransportRequest { operation: &'static str, method: reqwest::Method, url: reqwest::Url, headers: HeaderMap, body: Option<Vec<u8>>, retry: RetryClass, response_shape: &'static str, cancellation: tokio_util::sync::CancellationToken }` with a custom `Debug` that omits headers/body/query values and cancellation internals.
- Produces: `TransportResponse { status: StatusCode, final_url: Url, headers: HeaderMap, body: Vec<u8> }` with a custom `Debug` that prints only status, redacted URL, header names, and byte length.
- Produces: `#[async_trait] pub(crate) trait QqTransport { async fn execute(&self, request: TransportRequest) -> Result<TransportResponse, QQMusicError>; }`, `build_direct_client(timeouts: TransportTimeouts) -> Result<Client, QQMusicError>`, and `ReqwestQqTransport::new(clock: Arc<dyn Clock>) -> Result<Self, QQMusicError>`. The production constructor and test-only `ReqwestQqTransport::new_with_policy(clock, policy, timeouts)` both call the same builder; tests may inject only validation authorities/loopback-HTTP allowance and shorter timeouts, never an arbitrary already-built `Client`.
- Produces: `redact_url`, `redact_headers`, `redact_json`, and `RequestDiagnostic { operation, status, duration_ms, retry_count, response_shape }` whose serialized form contains no request URL/body/header values.
- Consumes later: only Task 1-selected auth/account QQ request builders and their deterministic fake transports; public catalog/media builders stay on `QQMusicClient::http`.
- Adds `tokio-util = { version = "0.7", features = ["rt"] }`. Safe reads and auth polls select cancellation against send, response-body collection, retry delay, and poll delay; a write checks cancellation before dispatch but is not aborted after dispatch, because its result may be outcome-unknown.
- Preserves the existing ordinary `reqwest::Client` as `QQMusicClient::http` and preserves `QQMusicService::http_client() -> reqwest::Client` for `CachedMediaPreparer`, public catalog requests, signed media downloads, and all current proxy/media behavior. The dedicated direct/no-proxy `Arc<dyn QqTransport>` is an additional account/auth field; it does not replace, wrap, or reconfigure the ordinary client.

- [ ] **Step 1: Write failing clock and redaction tests**

Create the modules and start with these assertions:

```rust
#[test]
fn manual_clock_advances_deterministically() {
    let clock = ManualClock::new(1_000);
    assert_eq!(clock.now_ms(), 1_000);
    clock.advance(250);
    assert_eq!(clock.now_ms(), 1_250);
}

#[test]
fn redaction_removes_credentials_and_signed_query_values() {
    let url = reqwest::Url::parse(
        "https://u.y.qq.com/cgi-bin/musicu.fcg?vkey=SECRET&guid=123",
    )
    .expect("URL");
    assert_eq!(
        redact_url(&url),
        "https://u.y.qq.com/cgi-bin/musicu.fcg?vkey=%5BREDACTED%5D&guid=%5BREDACTED%5D"
    );
    let value = serde_json::json!({
        "cookie": "uin=10001; qm_keyst=SECRET",
        "qm_keyst": "SECRET",
        "uin": "10001",
        "nickname": "Synthetic Listener",
        "nested": { "authorization": "Bearer SECRET", "count": 2 }
    });
    let redacted = redact_json(&value);
    assert_eq!(redacted["cookie"], "[REDACTED]");
    assert_eq!(redacted["qm_keyst"], "[REDACTED]");
    assert_eq!(redacted["uin"], "[REDACTED]");
    assert_eq!(redacted["nested"]["authorization"], "[REDACTED]");
    assert_eq!(redacted["nickname"], "Synthetic Listener");
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::clock::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::redaction::tests -- --nocapture
```

Expected: FAIL because the modules/functions are not implemented.

- [ ] **Step 3: Implement the injected clock and stable redaction rules**

Implement `SystemClock` from `SystemTime::now()` and a test `ManualClock` backed by `AtomicU64`. Redact keys case-insensitively when normalized to alphanumeric lowercase and matching:

```rust
const SECRET_KEYS: &[&str] = &[
    "authorization",
    "cookie",
    "cookies",
    "musickey",
    "qmkeyst",
    "qrsig",
    "ptqrtoken",
    "refreshtoken",
    "refreshkey",
    "accesstoken",
    "openid",
    "unionid",
    "uin",
    "musicid",
    "strmusicid",
    "callbackurl",
];
```

`redact_url` must preserve scheme/host/path/query names but replace every query value and fragment with `[REDACTED]`. `redact_headers` must replace values of `Cookie`, `Set-Cookie`, `Authorization`, and `Proxy-Authorization`; it may retain nonsecret header names only.

- [ ] **Step 4: Write failing local transport tests for redirects, retries, and write uncertainty**

Use two loopback Axum listeners and inject their exact IP-and-port authorities through the test-only validation policy with `allow_loopback_http: true`. Construct every fixture transport through `ReqwestQqTransport::new_with_policy(clock, policy, short_timeouts)`, which calls the real `build_direct_client`; do not pass a `Client` into the transport. The exception accepts `http` only when `Url::host()` is the loopback IP literal `127.0.0.1` or `::1` and the exact authority is in the injected set; it is unavailable in non-test construction. Listener A exposes `/cross-host`, `/loop`, `/read-timeout`, and `/write-timeout`; `/cross-host` redirects to listener B. Assert:

```rust
#[tokio::test]
async fn redirect_policy_revalidates_hops_and_strips_secrets_cross_host() {
    let observed = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let transport = fixture_transport(Arc::clone(&observed)).await;
    let response = transport
        .execute(authenticated_fixture_request("/cross-host"))
        .await
        .expect("allowlisted redirect succeeds");
    assert_eq!(response.status, StatusCode::OK);
    let hops = observed.lock().await;
    assert!(hops[0].cookie_present);
    assert!(!hops[1].cookie_present, "cross-host redirect strips Cookie");
}

#[tokio::test]
async fn write_timeout_is_outcome_unknown_and_is_not_retried() {
    let calls = Arc::new(AtomicUsize::new(0));
    let transport = timeout_fixture_transport(Arc::clone(&calls)).await;
    let error = transport
        .execute(write_fixture_request("/write-timeout"))
        .await
        .expect_err("write must not report a definite failure");
    assert!(matches!(error, QQMusicError::OutcomeUnknown));
    assert_eq!(calls.load(Ordering::Acquire), 1);
}

#[tokio::test]
async fn safe_read_retries_once_but_auth_poll_does_not() {
    assert_eq!(run_timeout_case(RetryClass::SafeRead).await, 2);
    assert_eq!(run_timeout_case(RetryClass::AuthPoll).await, 1);
}
```

Also test all of the following: under one process-wide test mutex, save/restore `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`; point all proxy variables at listener A, clear `NO_PROXY`, target listener B, construct the transport through the shared-builder test factory, and assert A receives zero requests while B receives one. This is the no-proxy proof and must not use `Client::new()` or an injected client. Cancel a safe read, its retry delay, and an auth poll and assert `Cancelled` without another request; return `200` plus `Location` and assert it is not followed; follow only 301/302/303/307/308; strip every secret header on a cross-origin hop; and reject a cross-origin authenticated 307/308 when it would preserve any request body. The latter test asserts listener B receives neither request nor body.

- [ ] **Step 5: Run the transport tests and verify the missing behavior**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::transport::tests -- --nocapture
```

Expected: FAIL before `ReqwestQqTransport` and `QQMusicError::OutcomeUnknown` exist.

- [ ] **Step 6: Implement manual redirect and request-class behavior**

Implement `build_direct_client` once with `reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())` and supplied timeouts. Production passes five-second connect/fifteen-second total values; test construction passes bounded short values but the same proxy/redirect configuration. Do not consult `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, system proxy settings, PAC, or user proxy configuration for auth/account endpoints. Permit the strict host set corroborated in Task 1 for the selected QQ QR/account flow:

```rust
const ALLOWED_HOSTS: &[&str] = &[
    "u.y.qq.com",
    "c.y.qq.com",
    "c6.y.qq.com",
    "ssl.ptlogin2.qq.com",
    "xui.ptlogin2.qq.com",
    "graph.qq.com",
    "y.qq.com",
];
```

Production `validate_https_allowlisted` accepts only `https`, one of these exact DNS hosts, and `port_or_known_default() == Some(443)`. The loopback-HTTP branch is compiled under `#[cfg(test)]`, requires `policy.allow_loopback_http`, an IP-literal loopback host, and an exact injected authority including port; never add `localhost`, a wildcard, or a production flag for it.

Task 1 must add a `Secret header names` field to every ledger row. Define one reviewed `AUTH_SECRET_HEADERS` constant containing `Cookie`, `Authorization`, `Proxy-Authorization`, and every provider-specific secret header name present in those rows; if Task 1 observes none, record `none` and keep exactly the three standard request headers. Redaction additionally treats response `Set-Cookie` as secret. Add a test table whose provider-specific entries exactly equal the ledger set so a newly observed custom header cannot be omitted silently.

Only for status 301, 302, 303, 307, or 308 with `Location`:

```rust
if hops == 3 {
    return Err(QQMusicError::Protocol);
}
let next = current.join(location).map_err(|_| QQMusicError::Protocol)?;
validate_https_allowlisted(&next)?;
if current.origin() != next.origin() {
    headers.remove(reqwest::header::COOKIE);
    headers.remove(reqwest::header::AUTHORIZATION);
    headers.remove(reqwest::header::PROXY_AUTHORIZATION);
}
current = next;
```

Treat a scheme, host, or effective-port change as cross-origin and remove every `AUTH_SECRET_HEADERS` entry. Never forward a POST body across a 301/302/303 redirect; convert to GET and clear entity headers/body. A same-origin 307/308 may preserve method/body. Reject a cross-origin 307/308 whenever the original request is authenticated or has a body; do not attempt to sanitize and forward that body. A `Location` header on any other status is ordinary response metadata and is never followed. Emit only `RequestDiagnostic`; do not log `TransportRequest`, `TransportResponse`, raw errors containing URLs, or response bodies.

Add `AuthorizationRejected`, `Protocol`, and `OutcomeUnknown` variants/codes to `QQMusicError`; only the first two map to non-retryable provider errors, while `OutcomeUnknown` is handled only by mutation reconciliation.

- [ ] **Step 7: Add the dedicated account transport without replacing the ordinary client**

Keep the current `QQMusicClient` field and constructor behavior intact, and add the account transport beside it:

```rust
pub struct QQMusicService {
    client: QQMusicClient,
    account_transport: Arc<dyn QqTransport>,
    clock: Arc<dyn Clock>,
    storage: Arc<StorageService>,
    credentials: Arc<dyn CredentialStore>,
    preferred_quality: RwLock<PreferredQuality>,
    fixture_root: PathBuf,
    fixture_guard: AsyncMutex<()>,
    session_invalid: AtomicBool,
}
```

Add `QQMusicService::new_with_runtime(storage: Arc<StorageService>, credentials: Arc<dyn CredentialStore>, fixture_root: PathBuf, account_transport: Arc<dyn QqTransport>, clock: Arc<dyn Clock>) -> Result<Self, QQMusicError>` for deterministic account/auth tests. Keep the existing production signature `QQMusicService::new(storage: Arc<StorageService>, credentials: Arc<dyn CredentialStore>, fixture_root: PathBuf) -> Result<Self, QQMusicError>` and have it construct the ordinary `QQMusicClient` exactly as today, then construct `SystemClock` plus the separate direct `ReqwestQqTransport`. Route only the Task 1-selected auth/account request builders through `account_transport`; existing public `send_json`, `client.http`, `http_client()`, media preparation, and guest cache TTLs remain unchanged.

Add a constructor regression test in `src-tauri/src/qqmusic.rs` that injects a recording account transport, performs one existing public catalog request, and asserts the recording transport has zero calls. Add a `src-tauri/src/player.rs` regression around `CachedMediaPreparer::new(service.http_client(), ...)` proving a synthetic media fixture still downloads/prepares through the ordinary client. The four existing `QQMusicService::new` call sites keep the compatibility signature from Tasks 4/6.

- [ ] **Step 8: Verify safety and guest-provider parity**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::clock::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::redaction::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::transport::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml player::tests::qqmusic_http_client_still_prepares_media -- --nocapture
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: deterministic safety suites and existing QQ normalization/lyrics/CDN/media tests PASS; auth/account calls use the dedicated transport, public/media calls never enter it, `http_client()` remains usable by `CachedMediaPreparer`, and no raw URL/header/body appears in captured logs.

- [ ] **Step 9: Commit the independently reviewable transport foundation**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/qqmusic.rs src-tauri/src/player.rs src-tauri/src/qqmusic/clock.rs src-tauri/src/qqmusic/redaction.rs src-tauri/src/qqmusic/transport.rs
git commit -m "security: harden qq music authenticated transport"
```

### Task 5: Split Public Catalog Status from the Account Contract

**Files:**

- Create: `src-tauri/src/qqmusic/account.rs`
- Modify: `src-tauri/src/qqmusic.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/domain/music.ts`
- Modify: `src/providers/music-provider.ts`
- Modify: `src/providers/qqmusic/qq-music-provider.ts`
- Modify: `src/providers/fake/fake-music-provider.ts`
- Modify: `src/providers/fake/fake-music-provider.test.ts`
- Modify: `src/application/use-catalog.ts`
- Create: `src/application/use-catalog.test.tsx`

**Interfaces:**

- Produces in Rust and TypeScript: `Page<T> { items, nextCursor, total, fetchedAtMs, stale }`, `PlaylistCapabilities`, `PlaylistOwnership`, `AccountPlaylistSummary`, `AccountPlaylistDetail`, `RemotePlayHistoryItem`, `AccountProfile`, `AccountEntitlement`, and the complete `AccountSnapshot` discriminated union.
- Produces: catalog-only `ProviderStatus { providerId, displayName, connection, message, preferredQuality, capabilities: CatalogProviderCapabilities }`; it contains no account state or account capability flags.
- Produces the exact cross-language `ProviderErrorCode` set: retain `offline`, `timeout`, `authentication-expired`, `entitlement-unavailable`, `rate-limited`, `schema-changed`, `song-unavailable`, `malformed-response`, and `provider-failure`; replace the unused `unauthorized` spelling with `authorization-rejected`; add `cancelled`, `not-found`, `invalid-request`, `mutation-in-progress`, and `storage-failure`. `cancelled` is non-retryable and is returned whenever an account operation's captured auth epoch is no longer current. Mutation uncertainty remains `MutationStatus::OutcomeUnknown`, not a generic provider error.
- Produces in TypeScript: `AccountMusicProvider` and `isAccountMusicProvider(provider): provider is MusicProvider & AccountMusicProvider`; `MusicProvider` remains unchanged for `FakeMusicProvider` and browser development.
- Produces: `AccountMusicProvider.getAccountSnapshot`, `startQrLogin`, `cancelQrLogin`, `refreshQrLogin`, `signOut`, the four paged read methods, and the final typed mutation method signatures consumed by Tasks 11–12.
- Preserves: `useCatalog()` calls only `MusicProvider` methods and can reach `ready` even when every account method rejects.

- [ ] **Step 1: Write the failing catalog/account separation tests**

Add to `src/providers/fake/fake-music-provider.test.ts`:

```ts
import { isAccountMusicProvider } from '../music-provider';

it('remains a catalog-only provider', () => {
  expect(isAccountMusicProvider(provider)).toBe(false);
});
```

Create `src/application/use-catalog.test.tsx` with a provider object whose catalog methods resolve and whose extra `getAccountSnapshot()` rejects. Render a probe inside `MusicProviderRoot` and assert:

```ts
await waitFor(() => expect(screen.getByTestId('catalog-status')).toHaveTextContent('ready'));
expect(provider.getHome).toHaveBeenCalledOnce();
expect(provider.getLibrary).toHaveBeenCalledOnce();
expect(provider.getAccountSnapshot).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the focused frontend tests and verify the missing type guard failure**

Run:

```powershell
npm test -- src/providers/fake/fake-music-provider.test.ts src/application/use-catalog.test.tsx
```

Expected: FAIL because `isAccountMusicProvider` does not exist.

- [ ] **Step 3: Define the provider-independent account types once**

Add these exact shapes to `src/domain/music.ts` and mirror them with serde `camelCase` Rust types in `src-tauri/src/qqmusic/account.rs`:

```ts
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number | null;
  fetchedAtMs: number;
  stale: boolean;
  authRevision: number;
}

export interface PlaylistCapabilities {
  canAddTracks: boolean;
  canRemoveTracks: boolean;
  canRename: boolean;
  canDelete: boolean;
  canReorder: boolean;
}

export type PlaylistOwnership = 'owned' | 'collected';

export interface AccountPlaylistSummary {
  id: EntityId;
  title: string;
  description: string;
  owner: PlaylistOwner;
  artwork: Artwork;
  ownership: PlaylistOwnership;
  capabilities: PlaylistCapabilities;
  trackCount: number;
  updatedAtMs: number | null;
}

export interface AccountPlaylistDetail {
  summary: AccountPlaylistSummary;
  tracks: Page<Song>;
}

export interface RemotePlayHistoryItem {
  song: Song;
  playedAtMs: number | null;
  source: 'qqmusic-account';
}

export type EntitlementTier = 'free' | 'music-vip' | 'super-vip' | 'unknown';
export type MembershipState = 'active' | 'expired' | 'inactive' | 'unknown';

export interface EntitlementRestriction {
  feature: 'playback' | 'favorite-write' | 'playlist-write' | 'quality';
  quality?: AudioQuality;
  reason: 'membership-required' | 'region-restricted' | 'upstream-restricted' | 'unknown';
}

export interface AccountEntitlement {
  tier: EntitlementTier;
  membership: MembershipState;
  expiresAtMs: number | null;
  permittedQualities: AudioQuality[];
  observedMaximumQuality: AudioQuality | null;
  restrictions: EntitlementRestriction[];
}

export interface AccountProfile {
  avatarUrl: string | null;
  nickname: string;
  maskedIdentity: string;
}

export interface CatalogProviderCapabilities {
  search: boolean;
  album: boolean;
  artist: boolean;
  playlist: boolean;
  lyrics: boolean;
  wordTimedLyrics: boolean;
  streaming: boolean;
  qualitySelection: boolean;
}

export interface AccountCapabilities {
  qrLogin: boolean;
  favoriteRead: boolean;
  favoriteWrite: boolean;
  playlistRead: boolean;
  playlistWrite: boolean;
  recentHistoryRead: boolean;
}

export type AccountState =
  | { state: 'guest'; profile: null; entitlement: null }
  | { state: 'restoring-session'; profile: null; entitlement: null }
  | {
      state: 'starting-login';
      attemptId: string;
      ownerLeaseId: string;
      pollAfterMs: number;
      profile: null;
      entitlement: null;
    }
  | {
      state: 'waiting-for-scan';
      attemptId: string;
      ownerLeaseId: string;
      qrImageDataUri: string;
      expiresAtMs: number;
      pollAfterMs: number;
      profile: null;
      entitlement: null;
    }
  | {
      state: 'waiting-for-confirmation';
      attemptId: string;
      ownerLeaseId: string;
      expiresAtMs: number;
      pollAfterMs: number;
      profile: null;
      entitlement: null;
    }
  | { state: 'authenticated'; profile: AccountProfile; entitlement: AccountEntitlement }
  | {
      state: 'session-expired' | 'reauthentication-required' | 'secure-store-unavailable';
      profile: AccountProfile | null;
      entitlement: AccountEntitlement | null;
    }
  | {
      state: 'cancelled' | 'expired' | 'rejected' | 'network-error' | 'protocol-error';
      attemptId: string | null;
      profile: null;
      entitlement: null;
    };

export type AccountSnapshot = AccountState & {
  revision: number;
  capabilities: AccountCapabilities;
};

export type MutationStatus = 'applied' | 'rejected' | 'reconciled' | 'outcome-unknown';

export interface FavoriteMutationRequest {
  trackId: EntityId;
  favorite: boolean;
  clientOperationId: string;
}

export interface FavoriteMutationResult {
  clientOperationId: string;
  status: MutationStatus;
  trackId: EntityId;
  favorite: boolean;
  errorCode: ProviderErrorCode | null;
  authRevision: number;
}

export interface CreatePlaylistRequest {
  title: string;
  clientOperationId: string;
}
export interface RenamePlaylistRequest {
  playlistId: EntityId;
  title: string;
  clientOperationId: string;
}
export interface PlaylistTrackMutationRequest {
  playlistId: EntityId;
  trackId: EntityId;
  clientOperationId: string;
}
export interface DeletePlaylistRequest {
  playlistId: EntityId;
  clientOperationId: string;
}

export interface PlaylistMutationResult {
  clientOperationId: string;
  status: MutationStatus;
  playlist: AccountPlaylistSummary | null;
  errorCode: ProviderErrorCode | null;
  authRevision: number;
}
```

The Rust `Debug` implementation for auth-only internal types must be manual or omitted. Only `AccountSnapshot` is serializable.

- [ ] **Step 4: Add the narrow account-provider extension and keep the base provider intact**

Add to `src/providers/music-provider.ts`:

```ts
export interface AccountMusicProvider {
  getAccountSnapshot(signal?: AbortSignal): Promise<AccountSnapshot>;
  startQrLogin(signal?: AbortSignal): Promise<AccountSnapshot>;
  heartbeatQrLogin(
    attemptId: string,
    ownerLeaseId: string,
    signal?: AbortSignal,
  ): Promise<AccountSnapshot>;
  cancelQrLogin(attemptId: string, signal?: AbortSignal): Promise<AccountSnapshot>;
  refreshQrLogin(attemptId: string | null, signal?: AbortSignal): Promise<AccountSnapshot>;
  signOut(signal?: AbortSignal): Promise<AccountSnapshot>;
  getFavoriteSongs(cursor?: string, limit?: number, signal?: AbortSignal): Promise<Page<Song>>;
  getAccountPlaylists(
    cursor?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Page<AccountPlaylistSummary>>;
  getAccountPlaylistTracks(
    id: EntityId,
    cursor?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<AccountPlaylistDetail>;
  getAccountRecentlyPlayed(
    cursor?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Page<RemotePlayHistoryItem>>;
  setFavorite(
    request: FavoriteMutationRequest,
    signal?: AbortSignal,
  ): Promise<FavoriteMutationResult>;
  createPlaylist(
    request: CreatePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult>;
  renamePlaylist(
    request: RenamePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult>;
  addPlaylistTrack(
    request: PlaylistTrackMutationRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult>;
  removePlaylistTrack(
    request: PlaylistTrackMutationRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult>;
  deletePlaylist(
    request: DeletePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult>;
}

export function isAccountMusicProvider(
  provider: MusicProvider,
): provider is MusicProvider & AccountMusicProvider {
  const candidate = provider as Partial<AccountMusicProvider>;
  return [
    'getAccountSnapshot',
    'startQrLogin',
    'heartbeatQrLogin',
    'cancelQrLogin',
    'refreshQrLogin',
    'signOut',
    'getFavoriteSongs',
    'getAccountPlaylists',
    'getAccountPlaylistTracks',
    'getAccountRecentlyPlayed',
    'setFavorite',
    'createPlaylist',
    'renamePlaylist',
    'addPlaylistTrack',
    'removePlaylistTrack',
    'deletePlaylist',
  ].every((method) => typeof candidate[method as keyof AccountMusicProvider] === 'function');
}
```

Task 5 declares the final mutation request/result shapes even though Tasks 11–12 implement their behavior, so TypeScript never relies on temporary `unknown` signatures.

- [ ] **Step 5: Remove account state from catalog status and add the sanitized snapshot adapter**

Remove `account` and all favorite/playlist/auth booleans from Rust/TypeScript `ProviderStatus`. Rename its capability shape to `CatalogProviderCapabilities`. Keep `qqmusic_status` public and catalog-only. Put all account flags only in sanitized `AccountSnapshot.capabilities`. Make `QQMusicProvider` implement `MusicProvider, AccountMusicProvider` and add all 16 account methods now as typed `nativeRequest` adapters using the exact ACL command names from Task 2; for example, `getAccountSnapshot()` calls `nativeRequest('qqmusic_account_snapshot', undefined, signal)`. The corresponding Rust command implementations land in Tasks 7, 9, 11, and 12, and no frontend runtime invokes a command before its owning task exists.

Add a Rust serialization test:

```rust
#[test]
fn account_snapshot_serialization_has_no_secret_fields() {
    let json = serde_json::to_string(&authenticated_snapshot()).expect("snapshot serializes");
    for forbidden in ["cookie", "qm_keyst", "qrsig", "ptqrtoken", "authorization", "callback"] {
        assert!(!json.to_ascii_lowercase().contains(forbidden));
    }
    assert!(json.contains("maskedIdentity"));
}
```

- [ ] **Step 6: Verify catalog independence and cross-language field names**

Run:

```powershell
npm test -- src/providers/fake/fake-music-provider.test.ts src/application/use-catalog.test.tsx
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::account::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::tests -- --nocapture
```

Expected: fake/catalog tests PASS, `useCatalog` never touches account APIs, and Rust JSON field names match the TypeScript union.

- [ ] **Step 7: Commit the independently reviewable contract split**

```powershell
git add src-tauri/src/qqmusic.rs src-tauri/src/qqmusic/account.rs src-tauri/src/commands.rs src/domain/music.ts src/providers/music-provider.ts src/providers/qqmusic/qq-music-provider.ts src/providers/fake/fake-music-provider.ts src/providers/fake/fake-music-provider.test.ts src/application/use-catalog.ts src/application/use-catalog.test.tsx
git commit -m "refactor: split qq catalog and account contracts"
```

### Task 6: Implement the Rust-Owned QR Auth State Machine and Transactional Session Promotion

**Files:**

- Create: `src-tauri/src/qqmusic/auth.rs`
- Modify: `src-tauri/src/qqmusic/account.rs`
- Modify: `src-tauri/src/qqmusic.rs`
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/tests/fixtures/qqmusic/account/auth-waiting.json`
- Create: `src-tauri/tests/fixtures/qqmusic/account/auth-confirmed.json`
- Create: `src-tauri/tests/fixtures/qqmusic/account/profile.json`
- Test: inline tests in `src-tauri/src/qqmusic/auth.rs`

**Interfaces:**

- Produces secret internal `SessionRecord { version: 1, uin, cookieHeader, expiresAtMs, accountCacheScope }`; it derives `Serialize`/`Deserialize` but not `Debug`, and is persisted only under keyring accounts `qqmusic-session-staging` and `qqmusic-session`.
- Produces secret internal `AuthChallenge { qrBytes, mimeType, pollSecret, expiresAtMs }`; it is neither serializable nor debuggable.
- Produces `AuthPollResult::{WaitingForScan, WaitingForConfirmation, Confirmed(SessionRecord), Expired, Rejected}`.
- Produces `#[async_trait] trait QQMusicAuthProtocol { create_challenge, poll_challenge, validate_session }` over `QqTransport`.
- Produces `QQMusicAuthService::{snapshot, start, cancel, refresh, restore, logout}`; one active attempt is keyed by opaque 128-bit hex `attemptId`, and every async completion checks its captured `generation`.
- Produces a native `LoginOwnerLease` keyed by a second opaque 128-bit `ownerLeaseId`, renewed only by the guarded heartbeat command. Lease duration is 7 seconds and the advertised heartbeat interval is 2 seconds. Expiry cancels the poll task, increments the attempt generation, clears challenge/image bytes, and publishes `Cancelled`; late transport completion cannot revive it.
- Produces one `tokio::sync::Mutex<()>` lifecycle lock shared by restore, session promotion, and logout plus an atomic generation. Logout increments the generation and cancels poll/read cancellation tokens before waiting for this lock; restore/promotion capture the generation and recheck it after every await and again before publishing.
- Produces `ValidatedAccount { profile: AccountProfile, entitlement: AccountEntitlement }` from the lightweight validation/profile call.
- Preserves Task 4's constructor contracts exactly: `QQMusicService::new(storage: Arc<StorageService>, credentials: Arc<dyn CredentialStore>, fixture_root: PathBuf) -> Result<Self, QQMusicError>` and `QQMusicService::new_with_runtime(storage: Arc<StorageService>, credentials: Arc<dyn CredentialStore>, fixture_root: PathBuf, account_transport: Arc<dyn QqTransport>, clock: Arc<dyn Clock>) -> Result<Self, QQMusicError>`. Each constructor immediately wraps `credentials` in one owned `SpawnBlockingCredentialStore` for auth work while retaining Task 4's separate ordinary `QQMusicClient`. This keeps all four existing call sites (`src-tauri/src/lib.rs`, the test in `src-tauri/src/player.rs`, and the two tests in `src-tauri/src/qqmusic.rs`) compiling unchanged through this task; no async auth method retains or invokes `Arc<dyn CredentialStore>` directly.

- [ ] **Step 1: Add deterministic sanitized auth fixtures**

Create fixture values with `SANITIZED_ACCOUNT`, `SANITIZED_POLL_STATE`, and `https://qpic.y.qq.com/synthetic-avatar.png`; omit every cookie/token field. `auth-confirmed.json` represents only normalized protocol status and profile/entitlement shape, never a real confirmed session.

Run:

```powershell
rg -n -i 'qm_keyst|qrsig|ptqrtoken|set-cookie|authorization|vkey=|cookie\s*[:=]' src-tauri/tests/fixtures/qqmusic/account
```

Expected: no matches.

- [ ] **Step 2: Write failing auth transition, expiry, late-result, and QR-clearing tests**

Use `FakeAuthProtocol` with a queued result stream and `ManualClock`:

```rust
#[tokio::test(start_paused = true)]
async fn qr_flow_publishes_only_sanitized_states_and_clears_image_on_terminal_state() {
    let fixture = auth_fixture(vec![
        AuthPollResult::WaitingForScan,
        AuthPollResult::WaitingForConfirmation,
        AuthPollResult::Expired,
    ]);
    let service = fixture.service();
    let started = service.start().await.expect("start");
    assert!(matches!(started.state, AccountState::WaitingForScan { .. }));
    assert!(started.qr_image_data_uri().is_some());
    tokio::time::advance(Duration::from_secs(4)).await;
    let terminal = service.snapshot().await;
    assert_eq!(terminal.state_name(), "expired");
    assert!(terminal.qr_image_data_uri().is_none());
}

#[tokio::test]
async fn cancelled_generation_rejects_late_confirmation() {
    let fixture = delayed_confirmation_fixture();
    let service = fixture.service();
    let started = service.start().await.expect("start");
    service.cancel(started.attempt_id().expect("attempt")).await.expect("cancel");
    fixture.release_confirmation();
    assert_eq!(service.snapshot().await.state_name(), "cancelled");
    assert_eq!(fixture.credentials().load(ACTIVE_SESSION).await.expect("load"), None);
}

#[tokio::test(start_paused = true)]
async fn owner_lease_expiry_cancels_poll_and_releases_all_qr_material() {
    let fixture = waiting_for_scan_fixture();
    fixture.service().start().await.expect("start");
    tokio::time::advance(Duration::from_secs(8)).await;
    assert_eq!(fixture.service().snapshot().await.state_name(), "cancelled");
    assert!(fixture.service().challenge_bytes_for_test().is_none());
    assert!(fixture.poll_task_is_cancelled());
}
```

Add Tokio's `test-util` feature in `src-tauri/Cargo.toml` so `start_paused`/`advance` are deterministic.

- [ ] **Step 3: Run the focused auth tests and verify the state machine is absent**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::auth::tests -- --nocapture
```

Expected: FAIL because `QQMusicAuthService`, protocol fakes, and states do not exist.

- [ ] **Step 4: Implement one selected QR protocol without leaking the challenge**

Implement only the Task 1 selected QQ QR flow. `create_challenge()` validates image content type, rejects a zero-length or greater-than-256-KiB image, stores the polling cookie/token only in `AuthChallenge`, and projects:

```rust
let qr_image_data_uri = format!(
    "data:{};base64,{}",
    challenge.mime_type,
    base64::engine::general_purpose::STANDARD.encode(&challenge.qr_bytes)
);
```

The service polls natively no faster than the greater of the observed upstream hint and 1,500 ms, caps an attempt at its server expiry or five minutes, and applies no transport retry to a poll. `pollAfterMs` is present in `StartingLogin`, `WaitingForScan`, and `WaitingForConfirmation`, always reflects that clamped native cadence, and never tells React to call the provider poll endpoint. Each poll uses the attempt cancellation token from Task 4. `WaitingForConfirmation` drops the QR bytes immediately. `Expired`, `Rejected`, `Cancelled`, `NetworkError`, `ProtocolError`, owner loss, and success drop both image and challenge.

- [ ] **Step 5: Write failing lifecycle-serialization, staging, and rollback tests**

Add fault-injectable credential backends and assert the exact order:

```rust
#[tokio::test]
async fn confirmation_stages_reads_validates_promotes_reads_then_publishes() {
    let fixture = confirmed_fixture_with_recording_credentials();
    fixture.service().complete_confirmation(fixture.session()).await.expect("promotion");
    assert_eq!(
        fixture.credential_operations(),
        [
            "save:qqmusic-session-staging",
            "load:qqmusic-session-staging",
            "save:qqmusic-session",
            "load:qqmusic-session",
            "delete:qqmusic-session-staging",
        ]
    );
    assert_eq!(fixture.protocol().validated_records(), 2);
    assert_eq!(fixture.service().snapshot().await.state_name(), "authenticated");
}

#[tokio::test]
async fn active_readback_failure_restores_prior_session_and_projection() {
    let fixture = promotion_fixture_with_existing_session_and_active_readback_failure();
    let before = fixture.service().snapshot().await;
    assert!(fixture.service().complete_confirmation(fixture.new_session()).await.is_err());
    assert_eq!(fixture.credentials().active_plaintext_for_test(), fixture.prior_session_json());
    assert_eq!(fixture.service().snapshot().await, before);
    assert!(fixture.credentials().staging_plaintext_for_test().is_none());
}

#[tokio::test]
async fn active_save_that_writes_then_errors_restores_and_verifies_the_prior_value() {
    let fixture = promotion_fixture_with_partial_active_save_and_prior();
    let before = fixture.service().snapshot().await;
    assert!(fixture.service().complete_confirmation(fixture.new_session()).await.is_err());
    assert_eq!(fixture.credentials().active_plaintext_for_test(), fixture.prior_session_json());
    assert_eq!(fixture.credentials().active_readback_count(), 1);
    assert_eq!(fixture.service().snapshot().await, before);
    assert!(fixture.credentials().staging_plaintext_for_test().is_none());
}
```

Add the corresponding no-prior test: a backend whose `save(ACTIVE_SESSION, ...)` writes the candidate and then returns `Err` must leave ACTIVE absent after rollback/readback and must never publish `Authenticated`. Add a table-driven test over `PromotionBoundary::{CandidateValidated, BeforeStagingSave, AfterStagingSave, AfterStagingReadback, AfterStagedValidation, BeforeActiveSave, AfterActiveSave, AfterActiveReadback, AfterStagingDelete, BeforePublish}`. At each barrier, start logout, assert it increments generation before waiting, release the barrier, and prove that the candidate is removed from both keyring records and never becomes the published session. Add equivalent restore barriers at active-load, post-validation, and pre-publish.

- [ ] **Step 6: Implement restore/promotion/logout under one explicit lifecycle transaction**

Implement the protocol with these non-optional invariants:

1. Candidate validation may run before acquiring the lifecycle lock, but it captures `generation`; after that await and immediately after acquiring the lock, reject a mismatch as `QQMusicError::Cancelled` before any keyring write.
2. Hold the lifecycle lock continuously from the prior-ACTIVE load through staging save/readback/revalidation, ACTIVE save/readback, staging deletion, and final publish. Keyring work is non-abortable once dispatched, so recheck `generation` after every await while retaining the lock.
3. Treat every staging or ACTIVE `save` error as potentially partial. Clean staging after a staging-save error. After any ACTIVE-save result other than a verified constant-time-equal readback, restore the prior serialized ACTIVE value or delete ACTIVE when there was no prior value, then read ACTIVE back and constant-time verify that the prior state was restored.
4. A stale generation observed after staging or ACTIVE may have been written follows the same cleanup/restore-and-readback path and returns `Cancelled`; it never publishes candidate data. If cleanup, rollback, or rollback readback fails, publish `SecureStoreUnavailable`, retain no candidate projection, and return `Storage`.
5. Delete staging before publish. A staging-delete failure after ACTIVE changed also restores and verifies the prior ACTIVE value. Publish only while the lifecycle lock is still held and only after a final generation recheck.

`restore()` acquires the same lifecycle lock, captures/rechecks generation around active load and upstream validation, and never publishes a stale result. `logout()` increments generation/cancels work first and then uses this lock for all keyring deletion and account-cache clearing. `ValidatedAccount` derives `PartialEq` only for projection comparison in this transaction and tests; `constant_time_equivalent` compares serialized secret bytes with the existing `subtle` crate.

- [ ] **Step 7: Verify all terminal states and transactional promotion**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::auth::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml credentials::tests -- --nocapture
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: tests cover starting, waiting, scanned/confirmation, success, cancel, expiry, rejection, network/protocol/store failure, every promotion/restore barrier, logout interleavings, partial-success ACTIVE save with and without a prior value, late generation, rollback, and rollback readback; all PASS.

- [ ] **Step 8: Commit the independently reviewable auth service**

```powershell
git add src-tauri/Cargo.toml src-tauri/src/qqmusic.rs src-tauri/src/qqmusic/auth.rs src-tauri/src/qqmusic/account.rs src-tauri/tests/fixtures/qqmusic/account/auth-waiting.json src-tauri/tests/fixtures/qqmusic/account/auth-confirmed.json src-tauri/tests/fixtures/qqmusic/account/profile.json
git commit -m "feat: add rust-owned qq music qr authentication"
```

### Task 7: Wire Session Restore, Main-Window Commands, and Generation-Safe Logout

**Files:**

- Modify: `src-tauri/src/qqmusic/auth.rs`
- Modify: `src-tauri/src/qqmusic.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/storage.rs`
- Test: inline tests in `src-tauri/src/qqmusic/auth.rs`, `src-tauri/src/commands.rs`, and `src-tauri/src/storage.rs`

**Interfaces:**

- Produces: `StorageService::delete_provider_cache_kind(&self, kind: &str) -> Result<u64, StorageError>` using an exact `kind = ?1` predicate.
- Produces async methods `QQMusicService::account_snapshot(&self) -> AccountSnapshot`, `start_qr_login(&self) -> Result<AccountSnapshot, QQMusicError>`, `cancel_qr_login(&self, attempt_id: String) -> Result<AccountSnapshot, QQMusicError>`, `refresh_qr_login(&self, attempt_id: Option<String>) -> Result<AccountSnapshot, QQMusicError>`, `restore_session(&self)`, and `sign_out(&self) -> Result<AccountSnapshot, QQMusicError>`, all delegating to its owned auth service.
- Produces commands with an injected `tauri::WebviewWindow`: `qqmusic_account_snapshot`, `qqmusic_auth_start`, `qqmusic_auth_heartbeat`, `qqmusic_auth_cancel`, `qqmusic_auth_refresh`, and `qqmusic_sign_out`; every command calls `require_main_window(&window)?` before reading state. Heartbeat validates both opaque IDs and only extends the matching live lease.
- Produces: startup spawns `restore_session()` after Tauri state is managed; no account event is emitted globally.
- Preserves the existing `QQMusicService::new(..., Arc<dyn CredentialStore>, ...)` setup call. Task 6 wraps that backend internally, so this task does not introduce a second constructor shape or require edits to the three existing test call sites.

- [ ] **Step 1: Write failing restore/logout/cache-isolation tests**

Add tests:

```rust
#[tokio::test]
async fn restore_validates_before_authenticated_and_maps_invalid_material_to_reauth() {
    let valid = restore_fixture(valid_session(), ValidationResult::Valid);
    valid.service().restore_session().await;
    assert_eq!(valid.service().snapshot().await.state_name(), "authenticated");

    let malformed = restore_fixture_raw("not-json", ValidationResult::Valid);
    malformed.service().restore_session().await;
    assert_eq!(malformed.service().snapshot().await.state_name(), "reauthentication-required");
}

#[tokio::test]
async fn logout_increments_generation_before_releasing_a_late_confirmation() {
    let fixture = delayed_confirmation_fixture();
    fixture.service().start().await.expect("start");
    let before = fixture.service().generation();
    fixture.service().logout().await.expect("logout");
    assert!(fixture.service().generation() > before);
    fixture.release_confirmation();
    assert_eq!(fixture.service().snapshot().await.state_name(), "guest");
    assert_eq!(fixture.credentials().load(ACTIVE_SESSION).await.expect("load"), None);
}

#[tokio::test]
async fn logout_waits_for_the_lifecycle_lock_and_stale_restore_cannot_publish() {
    let fixture = restore_fixture_paused_after_validation();
    let restore = fixture.spawn_restore();
    fixture.wait_until_restore_is_paused().await;
    let logout = fixture.spawn_logout();
    fixture.wait_until_generation_changed().await;
    fixture.release_restore();
    restore.await.expect("restore joins");
    logout.await.expect("logout joins").expect("logout");
    assert_eq!(fixture.service().snapshot().await.state_name(), "guest");
    assert_eq!(fixture.credentials().load(ACTIVE_SESSION).await.expect("load"), None);
}

#[test]
fn account_cache_invalidation_preserves_guest_cache_settings_and_history() {
    let (_root, storage) = storage();
    storage.put_json("qqmusic:home", "metadata", &vec!["guest"], 60_000).expect("guest");
    storage.put_json("qqmusic:account:opaque:favorites", "qqmusic-account", &vec!["private"], 60_000).expect("account");
    storage.set_setting("preferred-quality", "high").expect("setting");
    storage.record_playback("qqmusic", "TRACK").expect("history");
    assert_eq!(storage.delete_provider_cache_kind("qqmusic-account").expect("delete"), 1);
    assert!(storage.get_json::<Vec<String>>("qqmusic:home", true).expect("guest read").is_some());
    assert_eq!(storage.get_setting("preferred-quality").expect("setting read").as_deref(), Some("high"));
}
```

- [ ] **Step 2: Run focused tests and verify missing integration**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::auth::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml storage::tests::account_cache_invalidation_preserves_guest_cache_settings_and_history -- --nocapture
```

Expected: FAIL until restore/logout and exact-kind invalidation exist.

- [ ] **Step 3: Implement restore and logout ordering**

`restore_session()` first captures generation, acquires the Task 6 lifecycle mutex, rechecks generation, publishes `RestoringSession`, loads ACTIVE asynchronously, rechecks, validates expiry and upstream profile with a cancellable read, rechecks, and publishes only while still holding the lock. Map missing -> `Guest`, unavailable store -> `SecureStoreUnavailable`, malformed/expired/explicit upstream auth invalid -> `ReauthenticationRequired`, and offline/timeout -> `NetworkError` with no profile projection. A generation mismatch at any boundary returns `Cancelled` without publishing. Never call a session authenticated or expose a stale profile without successful validation in this process.

`logout()` increments generation and cancels QR polls plus account read/reconciliation tokens before awaiting the lifecycle mutex. Once it owns the mutex, attempt staging deletion, ACTIVE deletion, exact-kind account-cache invalidation, cursor-registry clearing, and both in-flight/completed mutation-index clearing even when an earlier cleanup fails. A successful promotion to a new scope performs the same old-epoch index clearing before publication. Hold the mutex through the final snapshot publication. Never publish `Guest` if either sensitive credential deletion failed; publish `SecureStoreUnavailable` and return the stable storage error instead. A cache-only failure may publish `Guest` after both credentials are gone but still returns an error so stale account metadata is not silently treated as cleared. Do not call an upstream logout endpoint as a prerequisite for local logout; if Task 1 verified one, issue it best-effort before local invalidation with `RetryClass::Write`, but local generation invalidation and cleanup still complete when upstream is unavailable.

- [ ] **Step 4: Add and guard the six commands**

Use this signature pattern for every command:

```rust
#[tauri::command]
pub async fn qqmusic_auth_cancel(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    attempt_id: String,
) -> ProviderResult<AccountSnapshot> {
    require_main_window(&window)?;
    provider.cancel_qr_login(attempt_id).await.map_err(Into::into)
}
```

Register all six in `tauri::generate_handler!`. Unit-test `require_main_window_label` for every sensitive command name through a table so no new command bypasses the guard.

- [ ] **Step 5: Start restore without blocking Tauri setup and preserve constructor compatibility**

Keep the current shared synchronous credential binding and current QQ constructor call shape:

```rust
let credentials: Arc<dyn CredentialStore> = Arc::new(PlatformCredentialStore::new());
let qq_music = Arc::new(QQMusicService::new(
    Arc::clone(&storage),
    Arc::clone(&credentials),
    cache_root.join("fixture-media"),
)?);
```

Task 6 immediately creates its private `SpawnBlockingCredentialStore` from the supplied clone. Keep the existing audio/resolver/preparer/`PlayerService` construction unchanged. At the existing `LocalApiService::new` call, pass the original synchronous `credentials` as its third argument:

```rust
let local_api = LocalApiService::new(config_path, Arc::clone(&player), credentials)?;
```

Clone the service, call `app.manage(Arc::clone(&qq_music))`, and spawn restore without blocking setup:

```rust
let account_restore = Arc::clone(&qq_music);
tauri::async_runtime::spawn(async move {
    account_restore.restore_session().await;
});
```

Do not emit account snapshots on `api://event`, `player://snapshot`, or any global event; the main frontend reads them through its ACL command.

Route every native owner-loss path to one synchronous `cancel_login_owner(reason)` trigger that cancels the token immediately and schedules locked cleanup: `WindowEvent::CloseRequested` before the existing `window.hide()` close-to-tray branch, `WindowEvent::Destroyed`, and any future main-window hide helper before calling `hide()`. Add `Builder::on_page_load`; when the main WebView reports `PageLoadEvent::Started` and an active lease exists, treat reload/top-level navigation as owner loss (initial startup has no lease). Frontend `pagehide` and dialog unmount also send best-effort cancel, but the native window/page-load hooks and lease expiry are authoritative. Tests invoke pure event-to-owner-loss helpers for close-to-tray hide, destroy, navigation start, and lease expiry, then release a delayed poll and assert no state or keyring publication.

- [ ] **Step 6: Verify restore, logout, caller checks, and guest survival**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::auth::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml command_guard::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml storage::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::tests -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: valid restore, malformed/expired/store failure, logout late-result rejection, and cache isolation PASS; public QQ tests still pass.

- [ ] **Step 7: Commit the independently reviewable native lifecycle wiring**

```powershell
git add src-tauri/src/qqmusic/auth.rs src-tauri/src/qqmusic.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/storage.rs
git commit -m "feat: restore and revoke qq music account sessions"
```

### Task 8: Build the Sanitized Frontend Account Runtime and QR Dialog

**Files:**

- Create: `src/application/account-runtime.ts`
- Create: `src/application/account-runtime.test.ts`
- Create: `src/components/AccountDialog.tsx`
- Create: `src/components/AccountDialog.test.tsx`
- Modify: `src/application/provider-root.tsx`
- Modify: `src/pages/SettingsPage.tsx`
- Create: `src/pages/SettingsPage.test.tsx`
- Modify: `src/application/provider-settings.ts`
- Modify: `src/locales/en-US.ts`
- Modify: `src/locales/zh-CN.ts`
- Modify: `src/styles/components.css`

**Interfaces:**

- Produces Zustand `useAccountStore` with `{ snapshot, displayedQrImageDataUri, dialogOpen, busy, error, openDialog, closeDialog, refreshSnapshot, startLogin, heartbeatLogin, refreshQr, cancelLogin, signOut }` and an internal monotonically increasing request generation. Components render only `displayedQrImageDataUri`, never the snapshot field directly.
- Produces `useAccountRuntime(provider)` mounted once by `MusicProviderRoot`; it is inert for catalog-only providers.
- Consumes only `AccountMusicProvider` sanitized methods; no cookie/token types or arbitrary native command name is accepted.
- Produces `AccountDialog` that renders the data URI only for `waiting-for-scan` and erases the DOM `src` before cancellation/close resolves.

- [ ] **Step 1: Write failing runtime tests for stale responses, close cancellation, and guest independence**

Create a fake account provider with controllable promises and assert:

```ts
it('drops an older account snapshot after a newer generation wins', async () => {
  const provider = controlledAccountProvider();
  const first = useAccountStore.getState().refreshSnapshot(provider);
  const second = useAccountStore.getState().refreshSnapshot(provider);
  provider.resolveSecond(authenticatedSnapshot());
  await second;
  provider.resolveFirst(guestSnapshot());
  await first;
  expect(useAccountStore.getState().snapshot.state).toBe('authenticated');
});

it('clears the QR projection before cancelling on dialog close', async () => {
  const provider = waitingAccountProvider();
  const waiting = waitingForScanSnapshot();
  useAccountStore.setState({
    snapshot: waiting,
    displayedQrImageDataUri: waiting.qrImageDataUri,
    dialogOpen: true,
  });
  const close = useAccountStore.getState().closeDialog(provider);
  expect(useAccountStore.getState().displayedQrImageDataUri).toBeNull();
  provider.resolveCancel(cancelledSnapshot());
  await close;
  expect(useAccountStore.getState().dialogOpen).toBe(false);
});
```

Also advance fake timers past one heartbeat and assert the exact `(attemptId, ownerLeaseId)` pair is sent. Simulate heartbeat rejection, `pagehide`, navigation/unmount, and dialog close; each must synchronously clear the image/timers, invoke cancellation at most once, and ignore a later native waiting/confirmed response.

- [ ] **Step 2: Write failing dialog tests that forbid raw material and cover every state**

Render guest, starting, waiting-for-scan, waiting-for-confirmation, expired, rejected, cancelled, network/protocol error, authenticated, reauth, and secure-store-unavailable snapshots. For the QR case:

```ts
const { container, unmount } = renderAccountDialog(waitingForScanSnapshot());
const image = screen.getByRole('img', { name: 'Scan with QQ to sign in' });
expect(image).toHaveAttribute('src', expect.stringMatching(/^data:image\/(png|svg\+xml);base64,/));
expect(container.innerHTML).not.toMatch(/qrsig|ptqrtoken|qm_keyst|cookie|https?:\/\//i);
unmount();
expect(cancelQrLogin).toHaveBeenCalledOnce();
```

- [ ] **Step 3: Run the focused tests and verify missing runtime/components**

Run:

```powershell
npm test -- src/application/account-runtime.test.ts src/components/AccountDialog.test.tsx
```

Expected: FAIL because the store and dialog do not exist.

- [ ] **Step 4: Implement request generations and dialog ownership**

The runtime starts with one `refreshSnapshot(provider)` call backed by `getAccountSnapshot()`. While the dialog owns `starting-login`, `waiting-for-scan`, or `waiting-for-confirmation`, schedule sanitized snapshot refreshes at `pollAfterMs` clamped to 1,500–2,000 ms and send `heartbeatQrLogin(attemptId, ownerLeaseId)` every 2 seconds; native Rust, not React, polls QQ. Stop both timers on close, `pagehide`, navigation/unmount, terminal state, or heartbeat rejection. `startLogin` calls `startQrLogin` only from the sign-in action. `refreshQr` cancels the previous attempt first and calls `refreshQrLogin(previousAttemptId)` only from an explicit expired-state button click. `cancelLogin` calls `cancelQrLogin` once and clears the local image projection first.

Use an `AbortController` for component lifetime and this generation rule:

```ts
const generation = ++requestGeneration;
const next = await request();
if (generation !== requestGeneration) return;
set({ snapshot: next, error: null });
```

When a fresh `waiting-for-scan` snapshot wins its generation, copy its already-sanitized image into `displayedQrImageDataUri`; every other state sets that field to `null`. `closeDialog` and `cancelLogin` synchronously set `displayedQrImageDataUri: null`, clear the timer, and close or update the dialog before awaiting `cancelQrLogin(attemptId)`. This keeps the `AccountSnapshot` discriminated union valid while erasing the only DOM-bound image source immediately; the native cancellation response then replaces the snapshot and releases native challenge bytes.

- [ ] **Step 5: Implement the accessible, state-complete dialog and Settings account row**

Use `role="dialog"`, `aria-modal="true"`, a localized title, keyboard focus containment, an always-visible Close button, explicit Refresh only for `expired`, and Cancel for starting/waiting. Never put the image or snapshot into `console`, error titles, DOM data attributes, analytics, or test snapshots.

Settings displays only avatar, nickname, masked identity, state, tier/membership/expiry, sign-in/re-authenticate/sign-out. Move sign-out out of `useProviderSettings` into the account runtime. Secure-store and network/protocol errors use localized stable messages, not raw native error strings.

- [ ] **Step 6: Verify the complete frontend state matrix and no secret-shaped DOM**

Run:

```powershell
npm test -- src/application/account-runtime.test.ts src/components/AccountDialog.test.tsx src/pages/SettingsPage.test.tsx
npm run typecheck
npm run lint
npm run format:check
```

Expected: all account states/actions PASS, stale results are discarded, unmount cancels, and no raw URL/token/cookie term enters rendered markup.

- [ ] **Step 7: Commit the independently reviewable account UX**

```powershell
git add src/application/account-runtime.ts src/application/account-runtime.test.ts src/components/AccountDialog.tsx src/components/AccountDialog.test.tsx src/application/provider-root.tsx src/pages/SettingsPage.tsx src/pages/SettingsPage.test.tsx src/application/provider-settings.ts src/locales/en-US.ts src/locales/zh-CN.ts src/styles/components.css
git commit -m "feat: add sanitized qq music account dialog"
```

### Task 9: Add Paged Account Reads and the Opaque Account Cache

**Files:**

- Create: `src-tauri/src/qqmusic/cache.rs`
- Modify: `src-tauri/src/qqmusic/account.rs`
- Modify: `src-tauri/src/qqmusic.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/storage.rs`
- Create: `src-tauri/tests/fixtures/qqmusic/account/favorites-page-1.json`
- Create: `src-tauri/tests/fixtures/qqmusic/account/favorites-page-2.json`
- Create: `src-tauri/tests/fixtures/qqmusic/account/playlists.json`
- Create: `src-tauri/tests/fixtures/qqmusic/account/playlist-owned.json`
- Create: `src-tauri/tests/fixtures/qqmusic/account/playlist-collected.json`
- Create: `src-tauri/tests/fixtures/qqmusic/account/recent-history.json`
- Test: inline tests in `src-tauri/src/qqmusic/cache.rs` and `src-tauri/src/qqmusic/account.rs`

**Interfaces:**

- Produces: validated `OpaqueAccountScope` as 32 lowercase hexadecimal characters generated with `rand::random::<u128>()`; it is stored inside `SessionRecord`, never derived from UIN, and never serialized to React.
- Produces: `AccountLibraryProjection { favoriteIds, playlists, profile, entitlement, fetchedAtMs }` cached with kind `qqmusic-account` at `qqmusic:account:<opaque-scope>:projection`.
- Produces cache keys `qqmusic:account:<opaque-scope>:favorites:<cursor-digest>`, `qqmusic:account:<opaque-scope>:playlists:<cursor-digest>`, `qqmusic:account:<opaque-scope>:playlist:<stable-playlist-id>:tracks:<cursor-digest>`, and `qqmusic:account:<opaque-scope>:recent:<cursor-digest>`; `<cursor-digest>` is lowercase SHA-256 of the external opaque cursor string, or of the literal `first` when the cursor is absent, never a raw provider cursor.
- Produces: `QQMusicAccountService::{favorite_songs, playlists, playlist_tracks, recently_played}` accepting `(session: &SessionRecord, cursor: Option<String>, limit: u32)` and returning normalized `Page<T>`/`AccountPlaylistDetail`.
- Produces guarded commands: `qqmusic_favorite_songs`, `qqmusic_account_playlists`, `qqmusic_account_playlist_tracks`, and `qqmusic_account_recently_played`.
- Cache TTLs: Favorites 2 minutes; playlist summaries/details and recent history 5 minutes. A failed safe read may return an expired coherent page with `stale: true`; authentication expiry never returns stale data as authenticated-current.
- Produces internal `AccountEpoch { generation: u64, scope: OpaqueAccountScope }`. Every account command captures `(SessionRecord, AccountEpoch)` once, and `QQMusicAuthService::ensure_current(&AccountEpoch)` compares both fields. A mismatch is `QQMusicError::Cancelled`/`ProviderErrorCode::Cancelled`, never retryable.
- Produces `StorageService::apply_provider_cache_batch(&self, operations: &[ProviderCacheMutation]) -> Result<(), StorageError>`, where `ProviderCacheMutation::{Put { key, kind, value_json, expires_at_ms }, Delete { key }, DeleteKindPrefix { kind, prefix }}` executes under one SQLite transaction. `DeleteKindPrefix` uses bound parameters with `substr(cache_key, 1, length(?2)) = ?2`, not `LIKE` or interpolated SQL.

- [ ] **Step 1: Create shape-preserving sanitized fixtures and write failing pagination/ownership tests**

Use only `SANITIZED_TRACK_*`, `SANITIZED_PLAYLIST_*`, `Synthetic Listener`, and `https://qpic.y.qq.com/synthetic-*.png`. Add tests:

```rust
#[test]
fn favorite_pages_normalize_distinct_opaque_cursors_and_total() {
    let first = normalize_favorite_fixture(include_str!(
        "../../tests/fixtures/qqmusic/account/favorites-page-1.json"
    ))
    .expect("page one");
    let second = normalize_favorite_fixture(include_str!(
        "../../tests/fixtures/qqmusic/account/favorites-page-2.json"
    ))
    .expect("page two");
    assert_eq!(first.items.len(), 2);
    assert_eq!(first.next_cursor.as_deref(), Some("cursor:2"));
    assert_eq!(second.next_cursor, None);
    assert_eq!(first.total, Some(3));
    assert!(first.items.iter().all(|song| song.is_favorite));
}

#[test]
fn collected_playlist_has_no_owner_mutation_capabilities() {
    let playlist = normalize_playlist_fixture(include_str!(
        "../../tests/fixtures/qqmusic/account/playlist-collected.json"
    ))
    .expect("playlist");
    assert_eq!(playlist.ownership, PlaylistOwnership::Collected);
    assert_eq!(playlist.capabilities, PlaylistCapabilities::read_only());
}
```

- [ ] **Step 2: Write failing cache-key and stale-fallback tests**

```rust
#[test]
fn account_cache_scope_is_random_and_contains_no_identity() {
    let scope = OpaqueAccountScope::generate();
    assert_eq!(scope.as_str().len(), 32);
    assert!(scope.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()));
    let key = AccountCache::projection_key(&scope);
    assert!(!key.contains("10001"));
    assert_eq!(key, format!("qqmusic:account:{}:projection", scope.as_str()));
}

#[tokio::test]
async fn offline_account_read_returns_expired_page_as_explicit_stale_data() {
    let fixture = cached_favorites_fixture(QQMusicError::Offline);
    let page = fixture.service().favorite_songs(fixture.session(), None, 50).await.expect("stale page");
    assert!(page.stale);
    assert_eq!(page.items.len(), 2);
}

#[tokio::test]
async fn authentication_expiry_does_not_masquerade_as_stale_success() {
    let fixture = cached_favorites_fixture(QQMusicError::AuthenticationExpired);
    assert!(matches!(
        fixture.service().favorite_songs(fixture.session(), None, 50).await,
        Err(QQMusicError::AuthenticationExpired)
    ));
}

#[tokio::test]
async fn logout_or_login_swap_cancels_a_read_before_retry_or_cache_commit() {
    for boundary in [ReadBoundary::Response, ReadBoundary::BeforeRetry, ReadBoundary::BeforeCacheCommit] {
        let fixture = account_read_paused_at(boundary);
        let read = fixture.spawn_favorites();
        fixture.replace_auth_epoch().await;
        fixture.release(boundary);
        assert!(matches!(read.await.expect("join"), Err(QQMusicError::Cancelled)));
        assert_eq!(fixture.account_cache_write_count(), 0);
    }
}

#[test]
fn provider_cache_batch_rolls_back_every_operation_on_injected_fault() {
    let fixture = storage_batch_fixture();
    let before = fixture.rows();
    assert!(fixture.apply_with_failure_after(1).is_err());
    assert_eq!(fixture.rows(), before);
}
```

- [ ] **Step 3: Run focused tests and verify missing account reads/cache**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::account::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::cache::tests -- --nocapture
```

Expected: FAIL until normalization, paging, capability derivation, and cache keys exist.

- [ ] **Step 4: Implement paged request normalization and strict bounds**

Clamp `limit` to 1–100, treat absent cursor as the first page, and map the provider's offset/page token only inside Rust. Always return `cursor:` plus 32 lowercase hexadecimal characters generated from 128 random bits. Store the token -> provider-cursor mapping in a bounded in-memory `OpaqueCursorRegistry`, scoped to the complete `AccountEpoch`, capped at 512 entries, and cleared on logout/generation change. Unknown, expired, or cross-epoch cursors return `InvalidRequest` without transport. Never serialize raw provider cursors or request/response DTOs.

Cached `CachedAccountPage<T>` rows omit both raw provider cursors and outward opaque cursors and store only `items`, `total`, timestamps, and `terminal: bool`. A cached nonterminal page is never returned as a fresh pageable result: online code refetches that provider page to mint a new in-memory outward cursor; offline fallback may return its items with `stale: true` and `nextCursor: null`. Add a restart test that reads/caches page one with service A, constructs service B with the restored session scope and an empty cursor registry, refetches page one, then successfully follows the newly minted cursor to page two. Also assert the offline restart fallback exposes no dead cursor.

Owned playlist capability derivation is:

```rust
PlaylistCapabilities {
    can_add_tracks: ownership == PlaylistOwnership::Owned && upstream.can_add,
    can_remove_tracks: ownership == PlaylistOwnership::Owned && upstream.can_remove,
    can_rename: ownership == PlaylistOwnership::Owned && upstream.can_rename,
    can_delete: ownership == PlaylistOwnership::Owned && upstream.can_delete,
    can_reorder: false,
}
```

Keep `can_reorder` false until independently verified; do not infer ownership from display name.

- [ ] **Step 5: Implement epoch guards and transactional cache coherence**

At entry to every read, capture `(SessionRecord, AccountEpoch)`. Recheck the epoch after every transport/body await, before a safe-read retry, before using stale fallback, and before returning. The final cache write calls `commit_account_cache_if_current(epoch, || storage.apply_provider_cache_batch(...))`; that helper acquires the same lifecycle mutex used by logout, rechecks generation and scope, commits the SQLite transaction, rechecks again, and only then returns the page. If logout increments generation before this critical section, no write occurs. If commit wins first, logout waits and then deletes the exact account-cache kind; a final post-commit mismatch still returns `Cancelled`, so stale data cannot reach UI.

For Favorites and playlist-summary full refreshes, page one starts a new in-memory refresh epoch with an empty ordered accumulator. Each following page appends first-seen stable IDs in provider order. Only a terminal page (`nextCursor == null`) swaps the complete accumulator into `AccountLibraryProjection` and replaces the projection plus all affected cached page rows in one `apply_provider_cache_batch` transaction. A later full refresh therefore removes an externally unfavorited track or deleted playlist instead of unioning it forever. An interrupted/nonterminal refresh leaves the previous committed projection intact.

Before returning any normalized account song, overlay `is_favorite` from the projection. Public catalog cache rows remain unchanged; frontend consumers use the same projection in Task 11.

- [ ] **Step 6: Add the four guarded commands and register them**

Use `WebviewWindow` plus `require_main_window`, reject non-authenticated state as `authentication-expired`, and delegate cursor/limit unchanged to the service. Do not emit results globally or add them to the local HTTP API.

- [ ] **Step 7: Verify pages, stale/auth distinction, cache opacity, and guest cache isolation**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::account::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::cache::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml storage::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::tests -- --nocapture
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: two-page Favorites, owned/collected capability derivation, recent-history normalization, opaque keys, restart-safe next-page behavior, transactional rollback, logout/login-swap cancellation at response/retry/final-commit barriers, stale/offline fallback, and auth-expiry behavior PASS; guest cache remains intact.

- [ ] **Step 8: Commit the independently reviewable account read layer**

```powershell
git add src-tauri/src/qqmusic/cache.rs src-tauri/src/qqmusic/account.rs src-tauri/src/qqmusic.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/storage.rs src-tauri/tests/fixtures/qqmusic/account
git commit -m "feat: add paged qq music account library reads"
```

### Task 10: Render Account Library States Without Coupling Guest Home

**Files:**

- Modify: `src/application/account-runtime.ts`
- Modify: `src/application/account-runtime.test.ts`
- Modify: `src/application/navigation.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/components/Sidebar.tsx`
- Create: `src/components/Sidebar.test.tsx`
- Modify: `src/pages/LibraryPage.tsx`
- Create: `src/pages/LibraryPage.test.tsx`
- Modify: `src/pages/PlaylistPage.tsx`
- Create: `src/pages/PlaylistPage.test.tsx`
- Modify: `src/styles/pages.css`
- Modify: `src/locales/en-US.ts`
- Modify: `src/locales/zh-CN.ts`

**Interfaces:**

- Produces: `LibraryResource<T> = idle | loading | ready | empty | stale | account-required | reauthentication-required | error`, each non-idle variant carrying only the fields needed by that state.
- Produces in `useAccountStore`: `favorites`, `playlists`, `recent`, `loadFavorites`, `loadPlaylists`, `loadRecent`, and `loadNext(resource)` with per-resource refresh generations/cursors. Every loader also captures the authenticated `AccountSnapshot.revision` and accepts a result only when the current snapshot revision and the result's `authRevision` both equal that captured value.
- Produces routes `{ page: 'favorites' }`, `{ page: 'account-playlists' }`, `{ page: 'account-playlist'; id: EntityId }`, and `{ page: 'account-recent' }`; existing `{ page: 'library' }` is the account summary. The distinct account-playlist route never falls through to the existing public `{ page: 'playlist'; id }` loader.
- Produces `accountPlaylistDetails: Record<EntityId, LibraryResource<AccountPlaylistDetail>>` and `loadAccountPlaylist(id, reset)`/`loadNextAccountPlaylist(id)` using `getAccountPlaylistTracks`; `accountPlaylistDetailToPlaylist(detail)` maps the sanitized summary/tracks to the existing `PlaylistPage` presentation model without calling the public catalog provider.
- Preserves: Home/Search/Explore render solely from `useCatalog`; account restore/read failures never replace Home with the catalog error screen.

- [ ] **Step 1: Write failing state and route tests**

Cover guest, loading, empty, stale, reauth, error/retry, and paginated ready states:

```ts
it('shows a restrained sign-in state for a guest rather than a catalog error', () => {
  renderLibrary({ account: guestSnapshot(), route: 'favorites' });
  expect(screen.getByRole('heading', { name: 'Sign in to view Favorite Songs' })).toBeVisible();
  expect(screen.queryByText('Music is unavailable')).not.toBeInTheDocument();
});

it('labels remote QQ Music history and never merges local history', () => {
  renderLibrary({
    account: authenticatedSnapshot(),
    route: 'account-recent',
    recent: readyRecentPage(),
  });
  expect(screen.getByText('QQ Music account history')).toBeVisible();
  expect(screen.queryByText('Local playback history')).not.toBeInTheDocument();
});

it('keeps stale favorites visible with an explicit stale indicator and retry', () => {
  renderLibrary({
    account: authenticatedSnapshot(),
    route: 'favorites',
    favorites: staleFavorites(),
  });
  expect(screen.getByText('Showing saved account data')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
});
```

Add navigation/App/page assertions: clicking an owned or collected account summary navigates to `{ page: 'account-playlist', id }`; App invokes only the account detail loader; PlaylistPage renders mapped ownership/capabilities and a paged Load More control; a next-page response deduplicates stable track IDs in order. Also create `Sidebar.test.tsx` for every new route and extend `App.test.tsx` for the account-detail branch.

- [ ] **Step 2: Write the guest Home independence test**

In `src/application/account-runtime.test.ts`, reject restore and all account reads, resolve public `getHome`, then assert the catalog probe remains ready and the account resource becomes `account-required`/`error` without changing catalog state.

- [ ] **Step 3: Run focused tests and verify missing resource states/routes**

Run:

```powershell
npm test -- src/pages/LibraryPage.test.tsx src/application/account-runtime.test.ts src/application/use-catalog.test.tsx
```

Expected: FAIL until routes/resource state rendering exist.

- [ ] **Step 4: Implement independently paged resources**

Each loader records its own generation plus auth revision. Page one resets a new refresh accumulator; next pages append first-seen stable IDs in stable provider order. Construct each new immutable resource value off-store and publish it with one Zustand `set`, never by mutating existing arrays. A response is discarded when loader generation, requested cursor, current snapshot revision, or returned `authRevision` differs; `cancelled` is silent stale-work completion, not a user-facing retry error. `loadNext` is disabled while loading or when `nextCursor` is null. A first empty page becomes `empty`; a stale page with items becomes `stale`; 401/auth-expired becomes `reauthentication-required`; guest becomes `account-required` without making a native request. Add controlled-promise tests for logout and login-swap while page one, next page, and final UI commit are paused.

- [ ] **Step 5: Route and render the account library**

Sidebar retains Home/Search/Explore unchanged and adds Library, Favorites, My Playlists, and Recently Played under Your Music. The summary loads profile/entitlement plus playlist summaries first; Favorites and recent tracks load only when their route is opened. Playlist cards navigate to the distinct account route. App loads that route through `loadAccountPlaylist`, maps `AccountPlaylistDetail` into `PlaylistPage`, and wires next-page loading back to `getAccountPlaylistTracks`; it never calls the existing public `getPlaylist` path for an account-owned/collected detail. Do not virtualize at this point; append pages in bounded batches of at most 100 and measure before adding list virtualization.

- [ ] **Step 6: Verify states, pagination, route isolation, and localization**

Run:

```powershell
npm test -- src/pages/LibraryPage.test.tsx src/pages/PlaylistPage.test.tsx src/components/Sidebar.test.tsx src/application/account-runtime.test.ts src/application/use-catalog.test.tsx src/App.test.tsx
npm run typecheck
npm run lint
npm run format:check
```

Expected: all explicit states and next-page behavior PASS; Home remains usable for guest/restore failure; English and Chinese keys typecheck.

- [ ] **Step 7: Commit the independently reviewable account library UI**

```powershell
git add src/application/account-runtime.ts src/application/account-runtime.test.ts src/application/navigation.ts src/App.tsx src/App.test.tsx src/components/Sidebar.tsx src/components/Sidebar.test.tsx src/pages/LibraryPage.tsx src/pages/LibraryPage.test.tsx src/pages/PlaylistPage.tsx src/pages/PlaylistPage.test.tsx src/styles/pages.css src/locales/en-US.ts src/locales/zh-CN.ts
git commit -m "feat: render paged qq music account library"
```

### Task 11: Implement Typed Favorite Mutations with Rollback and Read-After-Write

**Files:**

- Modify: `src-tauri/src/qqmusic/account.rs`
- Modify: `src-tauri/src/qqmusic/cache.rs`
- Modify: `src-tauri/src/qqmusic.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/fixtures/qqmusic/account/favorite-success.json`
- Create: `src-tauri/tests/fixtures/qqmusic/account/favorite-rejected.json`
- Modify: `src/domain/music.ts`
- Modify: `src/providers/qqmusic/qq-music-provider.ts`
- Modify: `src/application/account-runtime.ts`
- Modify: `src/application/account-runtime.test.ts`
- Modify: `src/application/player-store.ts`
- Modify: `src/application/player-store.test.ts`
- Modify: `src/components/TrackList.tsx`
- Create: `src/components/TrackList.test.tsx`
- Modify: `src/components/PlayerBar.tsx`
- Modify: `src/components/PlayerBar.test.tsx`
- Modify: `src/pages/AlbumPage.tsx`
- Create: `src/pages/AlbumPage.test.tsx`
- Modify: `src/pages/PlaylistPage.tsx`
- Modify: `src/pages/PlaylistPage.test.tsx`
- Modify: `src/locales/en-US.ts`
- Modify: `src/locales/zh-CN.ts`

**Interfaces:**

- Consumes the exact `MutationStatus`, `FavoriteMutationRequest`, and `FavoriteMutationResult` declarations from Task 5; this task implements their native and frontend behavior without changing their shapes.
- Produces: one in-flight mutation mutex per key `favorite:<trackId>` and a bounded completed-result cache keyed by `(AccountEpoch, clientOperationId)`, never operation ID alone. The mutex is held across write, every reconciliation read, and the final guarded cache commit. Generation/scope change and logout synchronously evict completed and in-flight indexes for the old epoch before a replacement account can mutate.
- Produces one canonical `favoriteByTrackId` map in `useAccountStore` plus `useFavoriteState(trackId) -> { favorite, pending }`. TrackList, AlbumPage, PlaylistPage, and PlayerBar select by stable ID at render time; they never mutate `Song` props, album/playlist arrays, the player queue, or the active-track object.

- [ ] **Step 1: Write failing native success/rejection/unknown/duplicate tests**

```rust
#[tokio::test]
async fn favorite_success_updates_the_normalized_projection() {
    let fixture = favorite_fixture(WriteResult::Accepted);
    let result = fixture.service().set_favorite(request("TRACK", true, "op-1")).await.expect("write");
    assert_eq!(result.status, MutationStatus::Applied);
    assert!(fixture.projection().favorite_ids.contains("qqmusic:track:TRACK"));
}

#[tokio::test]
async fn favorite_timeout_reconciles_by_reading_favorite_state_without_retrying_write() {
    let fixture = favorite_fixture(WriteResult::OutcomeUnknownThenRead(true));
    let result = fixture.service().set_favorite(request("TRACK", true, "op-2")).await.expect("reconcile");
    assert_eq!(result.status, MutationStatus::Reconciled);
    assert_eq!(fixture.transport().write_calls(), 1);
    assert!(fixture.transport().favorite_read_calls() <= 3);
}

#[tokio::test]
async fn concurrent_duplicate_for_the_same_track_is_rejected_before_transport() {
    let fixture = pending_favorite_fixture();
    let first = fixture.spawn(request("TRACK", true, "op-3"));
    let duplicate = fixture.service().set_favorite(request("TRACK", false, "op-4")).await.expect_err("duplicate");
    assert!(matches!(duplicate, QQMusicError::MutationInProgress));
    fixture.release();
    first.await.expect("first joins").expect("first succeeds");
}

#[tokio::test]
async fn auth_epoch_change_during_write_timeout_reconciliation_or_commit_returns_cancelled() {
    for boundary in [
        WriteBoundary::TimeoutClassified,
        WriteBoundary::ReconciliationRead,
        WriteBoundary::BeforeCacheCommit,
        WriteBoundary::AfterCacheCommit,
    ] {
        let fixture = favorite_write_paused_at(boundary);
        let write = fixture.spawn_set_favorite();
        fixture.replace_auth_epoch().await;
        fixture.release(boundary);
        assert!(matches!(write.await.expect("join"), Err(QQMusicError::Cancelled)));
        assert!(!fixture.new_scope_contains_candidate_state());
    }
}

#[tokio::test]
async fn the_same_operation_id_after_login_swap_executes_for_the_new_epoch() {
    let fixture = favorite_fixture(WriteResult::Accepted);
    fixture.service().set_favorite(request("TRACK", true, "shared-op-id")).await.expect("first");
    fixture.login_as_new_scope().await;
    fixture.service().set_favorite(request("TRACK", false, "shared-op-id")).await.expect("second");
    assert_eq!(fixture.transport().write_calls(), 2);
    assert_eq!(fixture.completed_keys(), [fixture.current_epoch_key("shared-op-id")]);
}
```

- [ ] **Step 2: Write failing frontend rollback/convergence tests**

```ts
it('optimistically updates every projection and rolls back a definite rejection', async () => {
  const provider = rejectingFavoriteProvider();
  seedFavoriteEverywhere(false);
  const mutation = useAccountStore.getState().setFavorite(provider, track, true);
  expect(favoriteEverywhere()).toEqual([true, true, true, true]);
  provider.rejectDefinitively();
  await mutation;
  expect(favoriteEverywhere()).toEqual([false, false, false, false]);
});

it('keeps pending state during outcome-unknown and applies reconciled server state', async () => {
  const provider = unknownThenReconciledFavoriteProvider(false);
  await useAccountStore.getState().setFavorite(provider, track, true);
  expect(favoriteEverywhere()).toEqual([false, false, false, false]);
  expect(useAccountStore.getState().mutationMessage).toBe(
    'The server result was checked before the library was updated.',
  );
});
```

- [ ] **Step 3: Run focused tests and verify mutation support is absent**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::account::tests -- --nocapture
npm test -- src/application/account-runtime.test.ts src/application/player-store.test.ts
```

Expected: FAIL before native and frontend mutation logic exists.

- [ ] **Step 4: Implement one non-retried write plus bounded reconciliation**

Capture `(generation, OpaqueAccountScope)` before completed-result lookup or same-track mutex acquisition, key both lookups by that epoch, and recheck after acquisition. Send the write once with `RetryClass::Write`. Definite provider rejection returns `Rejected` and does not change cache. `OutcomeUnknown` runs at most three safe-read checks at 300 ms, 700 ms, and 1,500 ms; recheck the complete epoch before each delay/read and after every await. Observed desired state returns `Reconciled`, observed opposite state after all checks returns `Rejected`, and no definitive read returns `OutcomeUnknown`. Never send the write again. Store a completed result only through `insert_if_current(epoch, operation_id, result)` while holding the lifecycle guard; auth epoch changes clear old entries, so an identical operation ID on a new login performs a new write.

Authentication failure transitions auth to `ReauthenticationRequired` and never downgrades the write to guest. On applied/reconciled, call the Task 9 lifecycle-guarded transactional batch to update `AccountLibraryProjection.favorite_ids` and affected page caches. Recheck epoch immediately before and after that commit and before returning. A stale operation returns `Cancelled`; it never commits to the replacement scope or returns success. Tests cover logout and login swap at timeout classification, each reconciliation read, pre-commit, and post-commit.

- [ ] **Step 5: Implement optimistic snapshots and shared favorite projection**

Before optimistic update, capture only the canonical `favoriteByTrackId[trackId]` value and authenticated revision. Update that map by stable ID; all surfaces converge through `useFavoriteState` on their next render without altering ephemeral props. On `Rejected`, restore the captured map entry only if the same auth revision and operation still own it. On `Applied`/`Reconciled`, commit the returned server bit only when `result.authRevision` and the current snapshot revision equal the captured revision. On `Cancelled`, drop the result without rollback into a newer account. On unresolved `OutcomeUnknown`, stop the spinner, retain a neutral uncertainty message, and trigger a non-mutating Favorites refresh; do not issue another write.

- [ ] **Step 6: Add the guarded command and interactive controls**

`qqmusic_set_favorite(window, provider, request)` validates main caller and operation ID length 8–128 ASCII characters. Add `commands::qqmusic_set_favorite` to the existing `tauri::generate_handler![...]` in `src-tauri/src/lib.rs` in the same commit; declaring the command and ACL alone is insufficient. TrackList, AlbumPage, PlaylistPage, and PlayerBar all call the same account runtime action; buttons expose pending state and localized accessible labels. Refactor TrackList's current full-row `<button role="row">` into a noninteractive `<div role="row">` containing a dedicated play/pause `<button>` and a sibling favorite `IconButton`, so no button is nested inside another interactive element. Guest click opens sign-in rather than showing a generic provider error.

Extend an inline `src-tauri/src/lib.rs` source-registration test that extracts the current `tauri::generate_handler![...]` token block from `include_str!("lib.rs")` and asserts exactly one `commands::qqmusic_set_favorite` entry. The test must fail if the function exists but is absent/duplicated in the handler. Also retain Task 2's ACL/guard table assertion for the same command name.

Create focused tests for `TrackList`, `AlbumPage`, and `PlaylistPage`, and extend `PlayerBar.test.tsx`. Seed the same track ID on all four surfaces, change one canonical map entry, and assert every rendered selector converges; cover definite rollback, cancelled account swap, pending labels, and `container.querySelector('button button') === null` for TrackList.

- [ ] **Step 7: Verify native reconciliation and frontend consistency**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::account::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml handler_registration -- --nocapture
npm test -- src/application/account-runtime.test.ts src/application/player-store.test.ts src/components/TrackList.test.tsx src/pages/AlbumPage.test.tsx src/pages/PlaylistPage.test.tsx src/components/PlayerBar.test.tsx
npm run typecheck
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: no duplicate writes, definite rollback, outcome-unknown read-after-write, and four-surface convergence PASS.

- [ ] **Step 8: Commit the independently reviewable Favorites mutation**

```powershell
git add src-tauri/src/qqmusic/account.rs src-tauri/src/qqmusic/cache.rs src-tauri/src/qqmusic.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/tests/fixtures/qqmusic/account/favorite-success.json src-tauri/tests/fixtures/qqmusic/account/favorite-rejected.json src/domain/music.ts src/providers/qqmusic/qq-music-provider.ts src/application/account-runtime.ts src/application/account-runtime.test.ts src/application/player-store.ts src/application/player-store.test.ts src/components/TrackList.tsx src/components/TrackList.test.tsx src/components/PlayerBar.tsx src/components/PlayerBar.test.tsx src/pages/AlbumPage.tsx src/pages/AlbumPage.test.tsx src/pages/PlaylistPage.tsx src/pages/PlaylistPage.test.tsx src/locales/en-US.ts src/locales/zh-CN.ts
git commit -m "feat: reconcile qq music favorite mutations"
```

### Task 12: Implement Capability-Gated Playlist Mutations and Safe Temporary-Playlist Acceptance

**Files:**

- Modify: `src-tauri/src/qqmusic/account.rs`
- Modify: `src-tauri/src/qqmusic/cache.rs`
- Modify: `src-tauri/src/qqmusic.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/fixtures/qqmusic/account/playlist-mutation-success.json`
- Create: `src-tauri/tests/fixtures/qqmusic/account/playlist-mutation-rejected.json`
- Modify: `src/domain/music.ts`
- Modify: `src/providers/qqmusic/qq-music-provider.ts`
- Modify: `src/application/account-runtime.ts`
- Modify: `src/application/account-runtime.test.ts`
- Modify: `src/pages/PlaylistPage.tsx`
- Modify: `src/pages/PlaylistPage.test.tsx`
- Modify: `src/locales/en-US.ts`
- Modify: `src/locales/zh-CN.ts`

**Interfaces:**

- Consumes the exact `CreatePlaylistRequest`, `RenamePlaylistRequest`, `PlaylistTrackMutationRequest`, `DeletePlaylistRequest`, and `PlaylistMutationResult` declarations from Task 5; this task implements their native and frontend behavior without changing their shapes.
- Produces a create-operation key `playlist-create:<operationId>` and one shared same-entity mutex `playlist:<id>` for rename, add/remove track, and delete. Different writes against one playlist cannot overlap, including rename versus delete or two distinct track mutations.
- Reconciliation queries: create -> playlist summaries diff; rename -> playlist detail title; add/remove -> paged playlist track membership; delete -> playlist summaries absence.
- Reuses Task 11's `(AccountEpoch, clientOperationId)` completed-result cache for all playlist mutations; a completion from a prior scope/generation is never returned for an identical ID after login swap.

- [ ] **Step 1: Write failing native capability and operation-specific reconciliation tests**

```rust
#[tokio::test]
async fn collected_playlist_rejects_owner_writes_without_transport() {
    let fixture = collected_playlist_fixture();
    for operation in fixture.owner_only_requests() {
        assert!(matches!(fixture.service().mutate(operation).await, Err(QQMusicError::AuthorizationRejected)));
    }
    assert_eq!(fixture.transport().write_calls(), 0);
}

#[tokio::test]
async fn unknown_create_is_reconciled_by_summary_diff_and_never_retried() {
    let fixture = unknown_create_fixture_with_unique_new_playlist();
    let result = fixture.service().create_playlist(create_request()).await.expect("reconciled");
    assert_eq!(result.status, MutationStatus::Reconciled);
    assert_eq!(result.playlist.expect("playlist").id, "qqmusic:playlist:SANITIZED_NEW");
    assert_eq!(fixture.transport().create_calls(), 1);
}

#[tokio::test]
async fn ambiguous_unknown_create_stays_unknown_without_second_create() {
    let fixture = unknown_create_fixture_with_two_matching_playlists();
    let result = fixture.service().create_playlist(create_request()).await.expect("typed result");
    assert_eq!(result.status, MutationStatus::OutcomeUnknown);
    assert_eq!(fixture.transport().create_calls(), 1);
}

#[tokio::test]
async fn playlist_operation_id_is_reusable_after_account_epoch_changes() {
    let fixture = playlist_mutation_fixture();
    fixture.service().rename_playlist(rename_request("shared-op-id")).await.expect("first");
    fixture.login_as_new_scope().await;
    fixture.service().rename_playlist(rename_request("shared-op-id")).await.expect("second");
    assert_eq!(fixture.transport().rename_calls(), 2);
}
```

- [ ] **Step 2: Write failing frontend capability/pending/rollback tests**

Assert collected playlists render no Rename/Delete/Add/Remove actions. Assert owned controls call exactly one provider method, remain disabled under their per-entity key, rollback definite rejection, and refresh after unresolved unknown.

- [ ] **Step 3: Write the deterministic temporary-playlist lifecycle safety test**

Use a fake provider only:

```ts
it('creates, verifies, mutates, and deletes only the playlist ID created by this run', async () => {
  const provider = temporaryPlaylistProvider();
  const created = await runTemporaryPlaylistAcceptance(provider, knownTestTrack);
  expect(created.title).toMatch(/^YAQMC Integration Test \([0-9TZ:-]+\)$/);
  expect(provider.operations).toEqual([
    `create:${created.title}`,
    `add:${created.id}:${knownTestTrack.id}`,
    `read:${created.id}`,
    `remove:${created.id}:${knownTestTrack.id}`,
    `rename:${created.id}:${created.title} Verified`,
    `delete:${created.id}`,
  ]);
  expect(provider.operations.join('\n')).not.toContain('EXISTING_PLAYLIST_ID');
});
```

The harness refuses cleanup unless the playlist is `owned`, its ID equals the ID returned/reconciled for this operation, and its title begins `YAQMC Integration Test (`.

- [ ] **Step 4: Run focused tests and verify missing playlist mutation behavior**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::account::tests -- --nocapture
npm test -- src/pages/PlaylistPage.test.tsx src/application/account-runtime.test.ts
```

Expected: FAIL before capability guards/reconciliation/harness exist.

- [ ] **Step 5: Implement each write once and reconcile by operation**

Capture `(generation, OpaqueAccountScope)` before acquiring the create-operation or playlist-entity mutex and recheck after acquisition. Use `RetryClass::Write` for all five operations. Validate title after Unicode trimming: 1–80 scalar values, no control characters. Validate stable provider IDs and operation IDs before transport. Recheck the complete epoch after every await, before every reconciliation read, and immediately before/after the Task 9 guarded transactional cache commit. On applied/reconciled, update the projection and cached pages only through that commit. On definite rejection, leave cache unchanged. On unresolved unknown, retain cache as stale and require refresh; do not guess success. A stale operation returns typed `Cancelled` and cannot commit or report success to the replacement account.

For unknown create, snapshot owned playlist IDs before send and accept only one newly observed owned playlist whose normalized title equals the requested title. Zero or multiple matches stays `OutcomeUnknown`. Never call create again.

- [ ] **Step 6: Add commands and capability-gated UI**

Add the five main-guarded commands and add `commands::qqmusic_create_playlist`, `commands::qqmusic_rename_playlist`, `commands::qqmusic_add_playlist_track`, `commands::qqmusic_remove_playlist_track`, and `commands::qqmusic_delete_playlist` to the existing `tauri::generate_handler![...]` in `src-tauri/src/lib.rs`. Extend the Task 11 source-registration test to require exactly one occurrence of each of the six mutation handlers and run it with the focused suite. PlaylistPage reads only `playlist.capabilities`; it never derives ownership from owner ID/title. Disable or hide owner-only actions for collected playlists, expose a confirmation before delete, and show operation-specific localized errors without personal playlist names in logs.

- [ ] **Step 7: Verify all mutations, uncertainty, and acceptance safety**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::account::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml handler_registration -- --nocapture
npm test -- src/pages/PlaylistPage.test.tsx src/application/account-runtime.test.ts
npm run typecheck
npm run lint
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: create/rename/add/remove/delete success, rejection, unknown reconciliation, shared same-playlist serialization, logout/login-swap cancellation at write/reconciliation/final-commit barriers, duplicate suppression, collected-playlist denial, and temporary lifecycle safety PASS.

- [ ] **Step 8: Commit the independently reviewable playlist mutation layer**

```powershell
git add src-tauri/src/qqmusic/account.rs src-tauri/src/qqmusic/cache.rs src-tauri/src/qqmusic.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/tests/fixtures/qqmusic/account/playlist-mutation-success.json src-tauri/tests/fixtures/qqmusic/account/playlist-mutation-rejected.json src/domain/music.ts src/providers/qqmusic/qq-music-provider.ts src/application/account-runtime.ts src/application/account-runtime.test.ts src/pages/PlaylistPage.tsx src/pages/PlaylistPage.test.tsx src/locales/en-US.ts src/locales/zh-CN.ts
git commit -m "feat: reconcile qq music playlist mutations"
```

### Task 13: Apply the Entitlement Matrix Through the Existing Playback Engine

**Files:**

- Create: `src-tauri/src/qqmusic/entitlement.rs`
- Modify: `src-tauri/src/qqmusic/auth.rs`
- Modify: `src-tauri/src/qqmusic/account.rs`
- Modify: `src-tauri/src/qqmusic.rs`
- Modify: `src-tauri/src/player.rs`
- Modify: `src-tauri/src/media.rs`
- Modify: `src-tauri/src/audio.rs`
- Create: `src-tauri/tests/fixtures/qqmusic/account/entitlement-free.json`
- Create: `src-tauri/tests/fixtures/qqmusic/account/entitlement-vip.json`
- Modify: `src/domain/music.ts`
- Modify: `src/application/provider-settings.ts`
- Modify: `src/application/player-store.ts`
- Modify: `src/application/native-player-runtime.ts`
- Modify: `src/components/PlayerBar.tsx`
- Modify: `src/components/PlayerBar.test.tsx`
- Modify: `src/pages/SettingsPage.tsx`
- Modify: `src/pages/SettingsPage.test.tsx`
- Modify: `src/locales/en-US.ts`
- Modify: `src/locales/zh-CN.ts`
- Modify: `docs/playback.md`
- Create: `docs/entitlement.md`

**Interfaces:**

- Produces provider-independent `AudioQualityPreference::{Automatic, Standard, High, Lossless}` in Rust/TypeScript; replace the QQ-local `PreferredQuality` definition with this shared type.
- Produces `PlaybackFallbackReason::{SourceUnavailable, AccountRights, PreviewOnly}`.
- Produces `PlaybackSourceSelection { requestedQuality, resolvedQuality, fallbackReason, preview }` and carries it through `ResolvedPlaybackSource`, `PreparedPlaybackSource`, `PlayerCore`, `PlayerSnapshot`, and `AuthoritativePlayerSnapshot`.
- Moves the current private Rust `SourceCandidate { filename, cache_label, format, mime_type, bitrate_kbps, preview }` from `qqmusic.rs` into `entitlement.rs` and adds `quality: AudioQuality`; candidate construction remains provider-native.
- Produces `SourceDecision { candidate: SourceCandidate, selection: PlaybackSourceSelection }` and pure `choose_source(preference: AudioQualityPreference, entitlement: &AccountEntitlement, track_formats: &[AudioFormatInfo], vkey_results: &[VkeyAvailability], preview: Option<PreviewRange>) -> Result<SourceDecision, PlaybackSourceError>`. `VkeyAvailability { filename: String, available: bool }` contains no URL; `PreviewRange { start_ms: u64, end_ms: u64 }` contains only normalized timing.
- Preserves: the same `QQMusicService: PlaybackSourceResolver`, `CachedMediaPreparer`, `ProgressiveSource`/full-file-cache preparation, `AudioEngine`, `PlayerService`, cache, and one-time expired-URL re-resolution.
- Produces nonserializable `PlaybackEpochGuard { expected: Option<AccountEpoch>, cancellation: CancellationToken, clock: Arc<PlaybackEpochClock> }` in `media.rs`; its manual `Debug` prints only `account_bound: bool`. `PlaybackEpochClock` stores the current generation+opaque scope behind `std::sync::RwLock<Option<AccountEpoch>>`; `validate()` compares both, while `validate_and_run(closure)` holds a read lock across one synchronous audio/core operation. Auth promotion/logout takes the write lock, changes/clears the epoch, and cancels the old token inside the Task 6 lifecycle mutex. Guest/public sources use `PlaybackEpochGuard::unrestricted()`.
- Adds `epoch_guard: PlaybackEpochGuard` to `ResolvedPlaybackSource` and `PreparedPlaybackSource`; `CachedMediaPreparer` moves the same guard through unchanged and never serializes it. `AudioEngine`/its worker retains the loaded source guard, validates inside `load` immediately before decoder/source creation and inside every `play`/resume immediately before backend playback, and returns a typed source-cancelled error on mismatch.
- Adds `PlaybackSourceError::Cancelled` and `AudioEngineError::SourceCancelled`; player error mapping treats both as non-retryable cancellation, stops the loaded source, and does not publish a provider/network failure toast for expected logout/login-swap invalidation.
- Applies this guard whenever source resolution uses account entitlement/cookies: validate after entitlement/vkey awaits; before and after media preparation; wrap audio load and every audio play/resume in `validate_and_run`; validate after audio load/play; and call `validate_and_run` while already holding the PlayerCore write lock immediately before `sourceSelection`/Playing commit. The audio worker also registers a cancellation watcher for the loaded guard and stops/clears the backend when auth invalidates it. After a valid commit, `PlayerService` owns a generation-bound cancellation task that increments `load_generation`, calls `audio.stop()`, clears `active_epoch_guard`/`sourceSelection`/Playing state under the core lock, and publishes one sanitized playback update; a newer load makes an older watcher a no-op. Thus a play that started just before invalidation is stopped, and a play after invalidation cannot enter the guarded closure. Any mismatch clears pending selection/guard, returns `PlaybackSourceError::Cancelled`, and cannot attach or keep playing an old account source after logout/login swap.

- [ ] **Step 1: Write the failing full candidate-matrix tests**

Use table-driven tests for all preferences:

```rust
#[test]
fn deterministic_quality_matrix_respects_rights_availability_and_preview() {
    let cases = [
        case("auto-vip-lossless", Automatic, vip_lossless(), all_sources(), Lossless, None),
        case("auto-free-standard", Automatic, free_standard(), all_sources(), Standard, None),
        case("standard", Standard, vip_lossless(), all_sources(), Standard, None),
        case("high", High, vip_high(), all_sources(), High, None),
        case("high-missing", High, vip_high(), standard_only(), Standard, Some(SourceUnavailable)),
        case("lossless-rights", Lossless, vip_high(), all_sources(), High, Some(AccountRights)),
        case("lossless-missing", Lossless, vip_lossless(), high_and_standard(), High, Some(SourceUnavailable)),
        case("preview", Lossless, free_standard(), preview_only(), Standard, Some(PreviewOnly)),
    ];
    for case in cases {
        let selected = choose_source(case.preference, &case.entitlement, &case.formats, &case.vkeys, case.preview)
            .expect(case.name);
        assert_eq!(selected.selection.resolved_quality, case.expected_quality, "{}", case.name);
        assert_eq!(selected.selection.fallback_reason, case.expected_reason, "{}", case.name);
    }
}

#[test]
fn entitlement_required_without_official_preview_is_unplayable() {
    assert_eq!(
        choose_source(Lossless, &free_standard(), &lossless_track(), &no_vkeys(), None),
        Err(PlaybackSourceError::EntitlementInsufficient)
    );
}

#[test]
fn missing_source_and_insufficient_right_are_distinct() {
    assert_eq!(missing_standard_source_error(), PlaybackSourceError::TrackUnavailable);
    assert_eq!(lossless_right_error(), PlaybackSourceError::EntitlementInsufficient);
}
```

- [ ] **Step 2: Write failing player projection and one-time refresh tests**

Extend the existing media/audio/player test fixtures with `PlaybackSourceSelection` and `PlaybackEpochGuard`. Assert the selection and exact guard instance move resolved -> prepared -> loaded without appearing in serialized snapshots; the selection survives valid media preparation, clears on a new load/error/cancellation, and `expired_media_url_is_resolved_again_once_then_played` still makes exactly two resolver/preparer calls.

Add deterministic barriers `PlaybackBoundary::{AfterEntitlementRead, AfterVkeyResponse, BeforePrepare, DuringPrepare, BeforeAudioLoad, InsideAudioLoad, BeforeAudioPlay, InsideAudioPlay, BeforeSnapshotCommit}`. At each boundary, run both logout and login-swap cases, release the operation, and assert typed cancellation, engine stop/not-playing, no stale `sourceSelection`, no final Playing snapshot, and no preparation/audio request with old account material. Add a separate resume test: load while current, pause, swap epoch, then `PlayerService::play()` must be rejected by the audio worker's retained guard without invoking backend play.

- [ ] **Step 3: Run focused native tests and verify missing matrix/projection**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::entitlement::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml player::tests::expired_media_url_is_resolved_again_once_then_played -- --nocapture
```

Expected: FAIL before the entitlement module and source projection exist.

- [ ] **Step 4: Implement normalized entitlement and deterministic candidate selection**

Normalize membership strings only in `entitlement.rs`. Build candidate orders exactly:

```rust
match preference {
    Automatic => entitled_available_descending_then_standard_then_preview(),
    Standard => [Standard, Preview],
    High => [High, Standard, Preview],
    Lossless => [Lossless, High, Standard, Preview],
}
```

Do not request a paid candidate excluded by `permitted_qualities`. Batch candidate vkey requests once per playback resolution; do not probe entitlement per visible song. `Automatic` means highest entitled available quality, so selecting Standard for a free account is not a fallback. Emit `AccountRights` only when an explicit `Standard`/`High`/`Lossless` requested quality is excluded by `permitted_qualities`; emit `SourceUnavailable` when that explicit requested quality is entitled but lacks an available format/vkey; preview selection emits `PreviewOnly`.

- [ ] **Step 5: Carry only the sanitized selection through the existing pipeline**

Add `selection: PlaybackSourceSelection` and the nonserializable guard to resolved/prepared sources, `active_epoch_guard: Option<PlaybackEpochGuard>` to private `PlayerCore`, and `source_selection: Option<PlaybackSourceSelection>` only to serializable player snapshots. `CachedMediaPreparer::prepare` calls `validate()` before cache lookup/network start, selects the cancellation token against all download/progressive waits, validates after each await and before returning, then copies the guard to `PreparedPlaybackSource`. Never include the guard, source URL, headers, cookie, cache scope, media signature, or vkey in a snapshot. Keep cache identity:

```rust
format!("qqmusic:{}:{}:{}", provider.track_id, decision.candidate.cache_label, media_mid)
```

The cache key includes stable track/media identity and resolved quality only; it never includes account/session/URL material.

- [ ] **Step 6: Write failing frontend observed-quality/fallback tests**

In `SettingsPage.test.tsx`, assert changing `Preferred quality` changes only the preference setting while `Account can currently access` remains the observed entitlement maximum, and updating the account snapshot changes only the observed maximum. In `PlayerBar.test.tsx`, render neutral localized reasons for account-rights, source-unavailable, and preview-only fallback from the typed enum. No component parses `qualityLabel` or membership marketing text.

- [ ] **Step 7: Implement frontend projection and presentation**

Mirror only the serde selection fields in `domain/music.ts`, thread `sourceSelection` through `native-player-runtime.ts` and `player-store.ts`, and render a small status only when fallback reason is non-null. The native guard never crosses IPC. Clear selection/guard on new track, loading failure, cancellation, logout, and error so a prior fallback does not label or authorize the next song.

- [ ] **Step 8: Verify matrix, engine reuse, UI, and lyric/player regressions**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::entitlement::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::auth::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml media::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml audio::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml player::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml streaming::tests -- --nocapture
npm test -- src/application/player-store.test.ts src/application/native-player-runtime.test.ts src/components/PlayerBar.test.tsx src/pages/SettingsPage.test.tsx src/application/lyrics-timing.test.ts
npm run typecheck
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: full matrix, all nine logout/login-swap barriers, guarded resume, and one-time URL refresh PASS; an old account source is never prepared, loaded, played, resumed, or committed after epoch cancellation, while the existing engine/clock/Range path and lyric timing remain unchanged.

- [ ] **Step 9: Commit the independently reviewable entitlement integration**

```powershell
git add src-tauri/src/qqmusic/entitlement.rs src-tauri/src/qqmusic/auth.rs src-tauri/src/qqmusic/account.rs src-tauri/src/qqmusic.rs src-tauri/src/player.rs src-tauri/src/media.rs src-tauri/src/audio.rs src-tauri/tests/fixtures/qqmusic/account/entitlement-free.json src-tauri/tests/fixtures/qqmusic/account/entitlement-vip.json src/domain/music.ts src/application/provider-settings.ts src/application/player-store.ts src/application/native-player-runtime.ts src/components/PlayerBar.tsx src/components/PlayerBar.test.tsx src/pages/SettingsPage.tsx src/pages/SettingsPage.test.tsx src/locales/en-US.ts src/locales/zh-CN.ts docs/playback.md docs/entitlement.md
git commit -m "feat: enforce qq music account entitlement in playback"
```

### Task 14: Add Secret Regression Scans and Security/Account Documentation

**Files:**

- Create: `scripts/check-secrets.ps1`
- Create: `scripts/check-secrets.sh`
- Create: `scripts/invoke-qqmusic-auth-preflight-command.ps1`
- Create: `scripts/run-qqmusic-auth-preflight.ps1`
- Create: `scripts/record-qqmusic-live-acceptance.ps1`
- Modify: `.github/workflows/build.yml`
- Modify: `docs/architecture.md`
- Modify: `docs/provider-contract.md`
- Modify: `docs/qqmusic-provider.md`
- Modify: `docs/authentication.md`
- Modify: `docs/caching.md`
- Modify: `docs/playback.md`
- Create: `docs/account-library.md`
- Modify: `docs/entitlement.md`
- Modify: `README.md`
- Test: inline Rust redaction tests in `src-tauri/src/qqmusic/redaction.rs`

**Interfaces:**

- Produces PowerShell parameter sets `scripts/check-secrets.ps1 [-SelfTest] [-Path $evidencePath]` and Bash modes `scripts/check-secrets.sh [--self-test] [--path "$evidence_path"]`; default scans tracked plus nonignored candidate `README.md`, `docs/**`, and `src-tauri/tests/fixtures/**` files, while the single-file mode scans a generated evidence file. Both report `path:line` and exit 1 on an assigned secret-like value.
- Produces `scripts/invoke-qqmusic-auth-preflight-command.ps1` with mutually exclusive `-CommandId <ValidateSet>` and `-ArgvProbe -First <string> -Second <string>` parameter sets. Its switch branches contain only literal executable/argument tokens; it accepts no executable path, free-form command, or arbitrary argument array.
- Produces `scripts/run-qqmusic-auth-preflight.ps1 [-SelfTest]` that invokes that fixed `-File` harness by command ID, streams output to the console, writes a machine-readable ignored result under `output/qqmusic-auth-account/preflight/`, and exits at the first failed gate. It never invokes an ignored/live test or auth command and is compatible with Windows PowerShell 5.1.
- Produces `scripts/record-qqmusic-live-acceptance.ps1` with `-Start`, `-Record`, `-Finish`, and `-SelfTest` parameter sets. `-Record` accepts only fixed `ValidateSet` values for check name, `pass|fail|blocked|not-supported`, sanitized failure classification, and the recent-history advertised-capability boolean; it accepts no arbitrary note/body/URL/profile fields and alone writes the ignored live-acceptance JSON.
- Produces CI gates before packaging; PowerShell runs on Windows and Bash runs on Linux.

- [ ] **Step 1: Extend redaction unit tests with positive and negative cases**

Positive inputs include Cookie/Set-Cookie, `qm_keyst`, UIN/music ID credential fields, QR/poll tokens, authorization headers, refresh/access keys, callback URLs, and signed media URLs. Negative inputs include numeric pagination, public track IDs, `cookie` as a documentation field name without an assigned value, sanitized sentinel values, and ordinary avatar URLs. Assert outputs retain only `[REDACTED]` for secrets.

- [ ] **Step 2: Create both tracked-file scanners with the same rule set**

Use `apply_patch` to create both scanner files. The scanners obtain the tracked files plus nonignored candidate docs/fixtures created in the current task with:

```text
git ls-files -z --cached --others --exclude-standard -- README.md docs src-tauri/tests/fixtures
```

PowerShell splits the captured output on NUL and Bash uses `while IFS= read -r -d '' path`; neither parser splits filenames on whitespace.

They reject assigned values matching these case-insensitive field names:

```text
authorization, cookie, set-cookie, qm_keyst, qrsig, ptqrtoken,
access_token, refresh_token, refresh_key, musickey, openid, unionid,
uin, musicid, str_musicid, callback_url
```

They also reject URL query assignments for `vkey`, `token`, `sig`, or `key` when the value has eight or more token characters. Allow values exactly equal to `[REDACTED]`, `redacted`, `SANITIZED_*`, or `SECRET` so documentation and synthetic test intent remain readable. A mention such as `` `qm_keyst` `` with no `:`/`=` assigned value is allowed.

`-SelfTest`/`--self-test` must run in-memory cases and assert:

```text
assigned cookie value assembled from two test-only string fragments -> reject
signed vkey URL assembled from two test-only string fragments        -> reject
qm_keyst                                 -> allow
qm_keyst=[REDACTED]                      -> allow
"uin":"SANITIZED_ACCOUNT"             -> allow
https://qpic.y.qq.com/synthetic.png      -> allow
```

- [ ] **Step 3: Create the deterministic preflight and fixed-schema live-evidence runners as reviewed scripts**

Create the harness and both runners with `apply_patch`. The preflight owns this exact ordered ID/display table and records ID, display, exit code, start/end UTC, and log SHA-256; it does not store environment variables:

```powershell
$commands = @(
  @{ Id='secret-scan'; Display='powershell -File scripts/check-secrets.ps1' },
  @{ Id='format'; Display='npm run format:check' },
  @{ Id='lint'; Display='npm run lint' },
  @{ Id='typecheck'; Display='npm run typecheck' },
  @{ Id='frontend-tests'; Display='npm test' },
  @{ Id='vite-build'; Display='npm run build' },
  @{ Id='rustfmt'; Display='cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check' },
  @{ Id='clippy'; Display='cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings' },
  @{ Id='rust-tests'; Display='cargo test --manifest-path src-tauri/Cargo.toml --all-targets' },
  @{ Id='local-release-binary'; Display='npm run tauri -- build --no-bundle' }
)
```

`invoke-qqmusic-auth-preflight-command.ps1` sets the repository working directory, switches on the validated ID, and uses literal calls such as `& npm.cmd run format:check` and `& cargo.exe clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`; each branch exits with the immediately captured `$LASTEXITCODE`. The main runner calls only `& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fixedHarness -CommandId $command.Id 2>&1 | Tee-Object -FilePath $ignoredLogPath`. Because the only dynamic value is a no-space `ValidateSet` ID consumed by the reviewed harness, it does not rely on legacy native-array quoting. Capture `$LASTEXITCODE` immediately after the pipeline. `Tee-Object` streams and writes only the ignored log; `[IO.File]::WriteAllText` writes only the ignored JSON result.

`-SelfTest` invokes the same tracked harness through `powershell.exe -File` with literal `-ArgvProbe -First alpha -Second 'two words'`. The probe parameter set exits 17 unless `$First -ceq 'alpha'` and `$Second -ceq 'two words'`, and prints one fixed success line otherwise. Assert exit 0, the spaced value remains one argument, stdout reaches the ignored log, and a fixed `self-test-fail` command ID preserves exit 23. Run this self-test under `powershell.exe`, not only `pwsh`, on Windows CI.

For the live recorder, `-Start` generates a random run ID and UTC start time; `-Record` accepts one check from `qr-created`, `authenticated`, `restart-restore`, `favorites-read`, `favorite-write`, `playlists-read`, `recent-history-read`, `temporary-playlist-cleanup`, `entitlement-playback`, `lyrics-regression`, `logout`, or `guest-fallback`; `-Finish` derives the aggregate result. Failure classification is limited to `none`, `owner-unavailable`, `upstream-unavailable`, `authentication-rejected`, `entitlement-required`, `endpoint-changed`, `capability-not-advertised`, `cleanup-failed`, or `unknown`. Only `recent-history-read` may use `not-supported`, and only with `-CapabilityAdvertised false -Classification capability-not-advertised`; every other check requires pass/fail/blocked, while an advertised recent-history capability requires pass/fail. `-Finish` excludes that one fixed not-supported row from the aggregate denominator but emits `recentHistoryVerified: false`; it still requires `favorite-write` and every other check to pass. Reject every other key/value, store only enum/boolean values and UTC timestamps, and run the tracked secret scanner over the result before atomically replacing the JSON file.

- [ ] **Step 4: Run scanner and recorder self-tests after every required script exists**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1 -SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1
bash scripts/check-secrets.sh --self-test
bash scripts/check-secrets.sh
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-qqmusic-auth-preflight.ps1 -SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/record-qqmusic-live-acceptance.ps1 -SelfTest
```

Expected: scanner, fixed-harness argv/exit-code, and recorder self-tests PASS under Windows PowerShell 5.1; repository scan exits 0. Any false positive is fixed by sanitizing the value or narrowing the parser around a field-name-only mention, not by allowlisting a real-looking token value.

- [ ] **Step 5: Document exact security, cache, account, and entitlement behavior without live claims**

Update docs to state:

- secrets and staging/active keyring account names conceptually, not values;
- main-window ACL plus Rust caller checks and lyric WebView exclusions;
- three-hop redirect revalidation/cross-host secret stripping;
- native QR ownership and clearing rules;
- save/readback/validate/promote/readback/publish and rollback;
- opaque random account cache scope and logout isolation;
- account page/stale/history semantics;
- typed mutation uncertainty and operation-specific reconciliation;
- temporary-playlist safety;
- entitlement matrix and existing engine reuse;
- local API remains account-free;
- deterministic tests complete versus live QR/account acceptance pending.

Keep README wording `implemented; live account acceptance pending` until Task 16 succeeds. Do not embed a QR image, token, cookie, personal profile, playlist name, or live response body in docs/screenshots.

- [ ] **Step 6: Add scans to CI before package builds**

Add this job to `.github/workflows/build.yml`, then add `needs: account-secret-scan` to both `linux-appimage` and `windows-nsis`:

```yaml
account-secret-scan:
  name: Account secret scan (${{ matrix.os }})
  strategy:
    fail-fast: false
    matrix:
      os: [ubuntu-22.04, windows-latest]
  runs-on: ${{ matrix.os }}
  steps:
    - uses: actions/checkout@v4
    - name: Scan tracked account artifacts (Linux)
      if: runner.os == 'Linux'
      run: bash scripts/check-secrets.sh --self-test && bash scripts/check-secrets.sh
    - name: Scan tracked account artifacts (Windows)
      if: runner.os == 'Windows'
      shell: powershell
      run: |
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1 -SelfTest
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-qqmusic-auth-preflight.ps1 -SelfTest
```

Keep the existing package-job bodies intact. The matrix must pass on both platforms before either package job starts. Do not upload `output/qqmusic-auth-account` as an artifact.

- [ ] **Step 7: Verify documentation links, scans, and full static checks**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1 -SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1
rg -n 'account-library.md|entitlement.md|authentication.md|qqmusic-provider.md' README.md docs
npm run format:check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
```

Expected: both scanner modes PASS, docs are linked, formatting passes, and no live capability is claimed.

- [ ] **Step 8: Commit the independently reviewable security/documentation gate**

```powershell
git add scripts/check-secrets.ps1 scripts/check-secrets.sh scripts/invoke-qqmusic-auth-preflight-command.ps1 scripts/run-qqmusic-auth-preflight.ps1 scripts/record-qqmusic-live-acceptance.ps1 .github/workflows/build.yml src-tauri/src/qqmusic/redaction.rs docs/architecture.md docs/provider-contract.md docs/qqmusic-provider.md docs/authentication.md docs/caching.md docs/playback.md docs/account-library.md docs/entitlement.md README.md
git commit -m "security: gate qq music account secrets and documentation"
```

### Task 15: Pass the Complete Deterministic Pre-QR Gate

**Files:**

- Modify only if a gate exposes a defect: the smallest production/test file owned by Tasks 2–14
- Runtime-only, ignored evidence: `output/qqmusic-auth-account/preflight/`

**Interfaces:**

- Consumes: `scripts/run-qqmusic-auth-preflight.ps1` from Task 14.
- Produces: one ignored preflight result whose command list contains no live/ignored auth operation and whose overall status is `passed`.
- Gate rule: no live QR challenge may be created, displayed, fetched, or polled before every step below passes.

- [ ] **Step 1: Confirm the tree and command list contain no premature live auth action**

Run:

```powershell
git status --short
rg -n -- '--ignored|qqmusic_auth_start|ptqrshow|ptqrlogin' scripts/run-qqmusic-auth-preflight.ps1 scripts/invoke-qqmusic-auth-preflight-command.ps1
```

Expected: only intended implementation changes are present; `rg` finds only the runner's explicit refusal guard, not an executable command.

- [ ] **Step 2: Run the reviewed preflight script**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-qqmusic-auth-preflight.ps1
```

Expected: secret scan, formatting, lint, typecheck, all deterministic frontend tests, Vite build, rustfmt, Clippy `-D warnings`, all non-ignored Rust tests, and the local Windows Tauri release binary build PASS. Because the command uses `--no-bundle`, this gate neither creates nor claims verification of an NSIS installer.

- [ ] **Step 3: Inspect the result rather than trusting the wrapper exit code**

Run:

```powershell
$latest = Get-ChildItem 'output/qqmusic-auth-account/preflight' -Filter '*.json' |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
$result = Get-Content -Raw $latest.FullName | ConvertFrom-Json
if ($result.status -ne 'passed') { throw 'Preflight did not pass' }
$serializedCommands = $result.commands | ConvertTo-Json -Depth 5 -Compress
if ($serializedCommands -match '--ignored|qqmusic_auth_start|ptqrshow|ptqrlogin') {
  throw 'Preflight contained a forbidden live auth action'
}
$result.commands | Format-Table id, display, exitCode, startedAtUtc, endedAtUtc, logSha256
```

Expected: every exit code is 0; each log SHA is present; no forbidden action appears.

- [ ] **Step 4: Run focused contract regressions with explicit evidence**

Run:

```powershell
npm test -- src/application/account-runtime.test.ts src/components/AccountDialog.test.tsx src/components/Sidebar.test.tsx src/components/TrackList.test.tsx src/pages/AlbumPage.test.tsx src/pages/LibraryPage.test.tsx src/pages/PlaylistPage.test.tsx src/pages/SettingsPage.test.tsx src/components/PlayerBar.test.tsx src/App.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::auth::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::account::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::entitlement::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::transport::tests -- --nocapture
```

Expected: sanitized auth states, paging/cache, mutation reconciliation, entitlement matrix, redirect/redaction, and caller-boundary suites PASS.

- [ ] **Step 5: Commit only defect fixes exposed by the gate**

Task 15 itself changes no implementation files and creates no commit. If a deterministic check fails, stop before QR creation, return to the owning implementation task, add a focused regression test there, make that task's documented focused commit, and restart Task 15 from Step 1.

If no code changed, do not create an empty commit. The ignored preflight result remains uncommitted.

### Task 16: Perform the Single Human QR Gate and Safe Live Account Acceptance

**Files:**

- Modify after verified observations only: `docs/qqmusic-provider.md`
- Modify after verified observations only: `docs/authentication.md`
- Modify after verified observations only: `docs/account-library.md`
- Modify after verified observations only: `docs/entitlement.md`
- Modify after verified observations only: `README.md`
- Runtime-only, ignored evidence: `output/qqmusic-auth-account/live-acceptance/`

**Interfaces:**

- Consumes: a passed Task 15 result and the main-window Tauri account UI.
- Produces: one valid live QR challenge shown only in the main window, one owner scan/confirmation pause, a sanitized state transcript containing state names/timestamps only, and exact live account/read/write/entitlement outcomes.
- Produces no QR screenshot, QR data URI, cookie/header/token, raw response body, personal nickname/avatar/playlist title, UIN, or signed URL.

- [ ] **Step 1: Reconfirm the deterministic gate immediately before first live QR creation**

Run:

```powershell
$latest = Get-ChildItem 'output/qqmusic-auth-account/preflight' -Filter '*.json' |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
$result = Get-Content -Raw $latest.FullName | ConvertFrom-Json
if ($result.status -ne 'passed') { throw 'Do not create a QR before preflight passes' }
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/record-qqmusic-live-acceptance.ps1 -Start
npm run tauri dev
```

Expected: native app opens with guest Home usable and account state available only in the main window.

- [ ] **Step 2: Create exactly one live QR and pause for the owner**

Open Settings -> QQ Music account -> Sign in. Verify the dialog shows a path-only data URI image and an expiry time but no raw URL/token. Do not capture a screenshot or inspect/copy the image source. Tell the owner only:

```text
Scan the QQ Music sign-in QR shown in the YAQMC main window and confirm it in QQ before the expiry time displayed in that dialog. After confirmation, YAQMC will verify secure restore, account reads, a temporary-playlist round trip, entitlement-aware playback, logout, and guest fallback.
```

Pause here if the owner is not present. Do not refresh, regenerate, or poll by reopening the dialog while unattended.

After the image and expiry are visible, record only the fixed check enum:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/record-qqmusic-live-acceptance.ps1 -Record -Check qr-created -Result pass -Classification none
```

If the owner is absent, record `-Result blocked -Classification owner-unavailable` for `authenticated`, close/cancel the dialog so native polling stops and QR display data clears, then end this task without creating another challenge.

- [ ] **Step 3: Verify confirmation, promotion, and restart restore without exposing identity**

After the owner confirms, verify state progresses to `authenticated`, Settings shows a masked identity/profile/tier, and no error exposes a native body. Close and restart YAQMC once; verify `restoring-session -> authenticated` occurs before account pages load. Record the `authenticated` and `restart-restore` checks through `scripts/record-qqmusic-live-acceptance.ps1 -Record`; use only `pass|fail` plus the fixed classification, never profile values.

- [ ] **Step 4: Verify paged reads, history semantics, and one reversible favorite write**

Open Favorites and fetch at least two pages when the account has enough items; otherwise record a verified single empty/partial terminal page. Open My Playlists and one owned playlist detail. Open Recently Played when the endpoint is reliable and confirm it is labeled `QQ Music account history`, not merged with local playback history. Confirm Home/Search/Explore remain usable throughout.

Record `favorites-read` and `playlists-read` separately. If `AccountSnapshot.capabilities.recentHistoryRead` is true, the recent-history check must pass or fail honestly. If it is false, do not call the endpoint; record only `-Check recent-history-read -Result not-supported -Classification capability-not-advertised -CapabilityAdvertised false`. That fixed disposition is excluded from the aggregate, sets `recentHistoryVerified: false`, and cannot support a README/docs verification claim. An advertised but unavailable endpoint is `fail` plus `endpoint-changed` or `upstream-unavailable`; it is never marked passed or not-supported.

Choose one ordinary visible test track without logging its ID/title. Snapshot its current favorite state, call the UI toggle exactly once to reach the opposite state, read Favorites/current track state until the bounded reconciliation completes, and verify the opposite state. Then toggle exactly once back to the snapshot state and read again until restoration is confirmed. If either outcome remains unknown, perform read-only reconciliation; do not issue another write except the single required restore when the first write is known to have applied. If restoration cannot be confirmed, stop all later writes and record `favorite-write` as `fail` plus `cleanup-failed`. Record `favorite-write` as pass only after the original state is restored and the ID-keyed selector converges across Library, Playlist/Album row, and PlayerBar.

- [ ] **Step 5: Perform the temporary playlist lifecycle with identity locks**

Before writing, list existing owned playlists and retain their stable IDs in memory only. Generate the title with `$temporaryTitle = 'YAQMC Integration Test ({0})' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')`, enter that exact value, and lock acceptance to the returned/reconciled new ID. Then perform exactly:

```text
create -> read new ID -> add one known test track -> read membership -> remove it -> read absence -> rename the same new ID with suffix " Verified" -> read title -> delete the same new ID -> read summaries and confirm absence
```

At every step assert `ownership == owned`, the ID equals the newly created ID, and the title begins `YAQMC Integration Test (`. Never rename/delete any ID present in the pre-write snapshot. On unresolved create outcome, reconcile summaries and stop; never call create again. On cleanup failure, stop further writes and report the temporary ID plus cleanup error prominently without exposing other playlist data.

Record only `temporary-playlist-cleanup` with `pass` after confirmed absence. Any failure is `fail` plus `cleanup-failed`; the recorder deliberately has no field that could accept the playlist ID or title.

- [ ] **Step 6: Verify entitlement-aware playback through the existing player**

Compare Settings preferred quality with observed account maximum. Play one legitimately available track for each locally permitted requested class needed to exercise fallback; verify `PlayerSnapshot.sourceSelection` reports resolved quality and typed fallback reason, Range playback/seek works, and no paid/unavailable quality is claimed. Verify one QRC track with word timing, translation/romanization when available, Fullscreen Lyrics, Desktop Lyrics, and Lyrics Island using the same playing `PlayerService`.

Record `entitlement-playback` and `lyrics-regression` independently with the fixed recorder.

- [ ] **Step 7: Verify logout generation and guest fallback**

With no mutation in flight, sign out. Verify account becomes `guest`, protected account pages show sign-in state, account cache/mutation projections clear, and guest Home/Search/public playlist/public lyrics/legitimate guest playback remain functional. Restart once and verify no authenticated state resurrects.

Record `logout` and `guest-fallback`, then run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/record-qqmusic-live-acceptance.ps1 -Finish`. The script must refuse `passed` if any required check is absent, failed, or blocked.

- [ ] **Step 8: Update docs only with verified live outcomes**

Change `reference-correlated; live acceptance pending` rows to the exact verified status/date. Mark unavailable/changed/entitlement-required operations honestly. README may say authenticated account support is verified only if login restore, required reads, reversible favorite write, playlist mutations/cleanup, entitlement playback, logout, and guest fallback all passed. When recent history used the fixed not-supported disposition, state that it is not advertised/verified and exclude it from any verified-capability list. Do not include personal values or raw artifacts.

- [ ] **Step 9: After documentation edits, rerun the complete deterministic preflight and inspect it**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-qqmusic-auth-preflight.ps1
$latest = Get-ChildItem 'output/qqmusic-auth-account/preflight' -Filter '*.json' |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$result = Get-Content -Raw $latest.FullName | ConvertFrom-Json
if ($result.status -ne 'passed') { throw 'Post-documentation preflight did not pass' }
$outputState = @(git status --short --ignored --untracked-files=all -- output/qqmusic-auth-account/)
$unexpectedOutput = @($outputState | Where-Object {
  $_ -notmatch '^!! output/qqmusic-auth-account/(preflight|live-acceptance)/[^/]+\.(json|log)$'
})
if ($unexpectedOutput) { throw "Unexpected recursive output artifact: $($unexpectedOutput -join ', ')" }
git diff --check
git status --short
```

Expected: all formatting/lint/type/test/build checks and the complete reviewed preflight rerun after documentation edits PASS; its `local-release-binary` command (`npm run tauri -- build --no-bundle`) succeeds, only intentional tracked docs/code changes remain, and no secret scan finding exists. The preflight is deterministic and must not create, refresh, or poll another live QR. `--no-bundle` verifies the local Tauri release binary, not a Windows release installer; installer packaging remains the existing `windows-nsis` CI job. Existing local API/SSE, Range streaming, player, lyrics, Desktop Lyrics/Lyrics Island, system-media, tray, and credential tests remain green.

- [ ] **Step 10: Commit the verified acceptance record, or report the exact external blocker**

If live acceptance completed:

```powershell
git add docs/qqmusic-provider.md docs/authentication.md docs/account-library.md docs/entitlement.md README.md
git commit -m "docs: record verified qq music account acceptance"
```

If the owner scan is the only missing action, make no live-verification claim and report `external acceptance pending: owner QR scan/confirmation`. If QQ rejects the session or an endpoint has changed, record the exact sanitized classification (`upstream unavailable`, `requires entitlement`, `requires authentication`, `endpoint changed`, or `unknown`) and continue every independent regression/cleanup step that remains safe.

---

## Completion Checklist

- [ ] Protocol/provenance ledger is date/commit/license pinned and distinguishes source correlation from live verification.
- [ ] Account commands have both Tauri custom-command ACL and Rust `main` caller checks; lyric WebViews receive neither permissions nor account events.
- [ ] Keyring access is isolated with `spawn_blocking`; staging/readback/validation/promotion/readback/publish and rollback tests pass.
- [ ] Redirects are manual, HTTPS/allowlist-validated per hop, capped at three, and stripped of secrets cross-host.
- [ ] React/logs/fixtures/docs/screenshots/local API contain no raw QR/token/cookie/header/UIN secret/signed URL.
- [ ] Public catalog and guest Home remain independent of restore/account failures.
- [ ] QR state machine covers start/wait/confirm/cancel/expire/reject/network/protocol/store/late generation and clears display data on every terminal/owner-loss path.
- [ ] Logout increments generation first, deletes secret records/account cache/pending mutations, and preserves settings/history/guest caches.
- [ ] Favorites, owned/collected playlists, playlist detail, and remote recent history are normalized, paged, cached under an opaque scope, and render every required state.
- [ ] Favorite and playlist writes use client operation IDs, per-entity locks, no blind retry, and bounded operation-specific read-after-write reconciliation.
- [ ] Temporary acceptance touches only the newly created `YAQMC Integration Test (` ID and verifies cleanup.
- [ ] Entitlement matrix is deterministic, reports typed fallback reasons, and reuses the existing resolver/Range/audio/player path.
- [ ] Deterministic preflight passes before the first live QR; the live gate pauses exactly once for owner scan when required.
- [ ] Final frontend/Rust/release/secret/regression gates pass and docs claim only evidence-backed capability.
