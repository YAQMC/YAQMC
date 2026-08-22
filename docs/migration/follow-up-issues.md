# P15 post-migration issue drafts

Status: **DRAFTED; NOT FILED — BLOCKED-AUTH**.

The local `gh` credential cannot access the repository, and unauthenticated
repository access is unavailable. No issue URL or issue number is invented in
this record. A maintainer with authorized GitHub access must file the five
drafts below, then replace each `PENDING-ISSUE-URL` marker with the created
issue URL to close CLEAN-02.

Do not paste credentials, tokens, private-repository URLs containing
credentials, or production-profile data into an issue.

## 1. Sign Windows artifacts and harden updater trust (R-9)

- **Suggested labels:** `security`, `release`, `windows`
- **Issue URL:** `PENDING-ISSUE-URL`
- **Context:** Electron artifacts are currently unsigned. Checksums and a
  notify-only update flow reduce accidental corruption but do not remove
  SmartScreen friction or establish publisher identity.
- **Scope:** select certificate custody/signing infrastructure, sign NSIS and
  portable executables, verify signatures before publication and update
  application, define rotation/revocation, and document CI secret boundaries.
- **Acceptance:** a clean Windows VM verifies the expected publisher and
  signature chain; modified or unsigned update artifacts are rejected; CI logs
  expose no signing secret; the release runbook covers rotation and emergency
  revocation.

## 2. Add opt-in operating-system notifications

- **Suggested labels:** `enhancement`, `desktop`, `privacy`
- **Issue URL:** `PENDING-ISSUE-URL`
- **Context:** the migration intentionally preserved the previous behavior and
  did not add an OS notification surface.
- **Scope:** define user value and opt-in settings, implement a Main-owned
  notification adapter, localize copy, and preserve the deny-by-default web
  permission policy.
- **Acceptance:** notifications are disabled by default, reveal no account or
  track data when privacy mode is enabled, behave consistently on supported
  Windows/Linux environments, and have automated lifecycle/permission tests.

## 3. Design and implement authenticated deep links

- **Suggested labels:** `enhancement`, `desktop`, `security`
- **Issue URL:** `PENDING-ISSUE-URL`
- **Context:** YAQMC currently registers no custom scheme and intentionally
  ignores second-instance arguments except for focusing the existing window.
- **Scope:** specify the URI grammar and supported actions, register schemes per
  platform, validate and normalize every argument in Electron Main, and define
  behavior for cold-start and second-instance delivery.
- **Acceptance:** malformed, oversized, untrusted-origin, and path-confusion
  inputs are rejected; renderer code never receives raw arguments; clean
  install/uninstall registration is tested on Windows and Linux; threat-model
  and negative tests are documented.

## 4. Improve native-Wayland integration

- **Suggested labels:** `linux`, `wayland`, `enhancement`
- **Issue URL:** `PENDING-ISSUE-URL`
- **Context:** native Wayland is an explicit opt-in. Global shortcuts and
  absolute/topmost/click-through lyric-surface behavior remain limited by the
  compositor/platform stack.
- **Scope:** evaluate portal-backed shortcuts and compositor-compatible surface
  controls without weakening sandbox or permission boundaries; retain X11/
  XWayland fallback behavior.
- **Acceptance:** results are recorded on at least one current Ubuntu LTS
  Wayland environment and one additional compositor; capability detection is
  factual; unsupported operations degrade safely; X11/XWayland regression
  coverage remains green.

## 5. Remove QQ-specific fields from public provider DTOs (TD-3)

- **Suggested labels:** `refactor`, `provider`, `api`
- **Issue URL:** `PENDING-ISSUE-URL`
- **Context:** the migration deliberately froze wire fields such as `mid`,
  `numericId`, `albumId`, `mediaId`, `tid`, `dirId`, and `encArea` to preserve
  compatibility while making provider references opaque inside Core.
- **Scope:** design versioned opaque provider references, migrate Rust and
  TypeScript contracts, define compatibility decoding, and update plugins and
  persisted data without coupling generic consumers to QQ Music identifiers.
- **Acceptance:** protocol fixtures and generated mirrors agree; old persisted
  references upgrade without data loss; plugin/API compatibility has an
  explicit version policy; provider-specific fields no longer appear in the
  generic public DTO surface.
