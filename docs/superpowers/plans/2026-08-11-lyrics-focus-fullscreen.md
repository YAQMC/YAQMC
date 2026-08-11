# Lyrics Focus and Fullscreen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Lyrics-only Focus preference, native main-window fullscreen, compact fullscreen transport, truthful appearance integration, and auditable native acceptance without remounting the player or lyric surface.

**Architecture:** Keep the existing `LyricsPanel` mounted for Normal, Focus, and Fullscreen states. A small Zustand presentation store wraps an injectable main-window fullscreen port; App keyboard handling and shell data attributes drive layout while the Rust `PlayerService` remains untouched. Split Tauri capabilities so only the main window can change fullscreen state. Resolve native artwork through the existing cache boundary before rendering it, derive the immersive stage from the persisted appearance contract, and verify native behavior with machine-readable evidence plus a tracked verifier.

**Tech Stack:** React 19, TypeScript 6, Zustand 5, Vitest/Testing Library, Tauri 2 window API, CSS, i18next.

## Global Constraints

- Do not add `applemusic-like-lyrics` or copy AMLL source, CSS, shaders, assets, DOM structure, or animation constants; its inspected revision is AGPL-3.0-only.
- Keep one authoritative native `PlayerService`; presentation transitions must not issue queue/playback reconstruction commands.
- Focus is a Lyrics-only preference. Home, Search, Explore, Library, and Settings keep the normal sidebar.
- Only the `main` WebView may receive `core:window:allow-set-fullscreen`.
- `Esc` priority is native fullscreen, Lyrics Focus, then closing Lyrics. `F11` toggles fullscreen only while Lyrics is open.
- Preserve translation, romanization, word timing, manual scroll, click-to-seek, reduced motion, and the Linux graphics downgrade policy.
- Every user-visible string must exist in both `en-US` and `zh-CN` resources.
- Evidence under `output/` is ignored and must never be staged; tracked docs summarize verified identities and outcomes only after the corresponding gate passes.
- Windows software/safe graphics modes are not substitutes for Linux native-Wayland/X11 acceptance.
- Native visual acceptance always uses the deterministic `fake` provider selected by the exact query
  `?provider=fake`; the app shell exposes the stable provider ID as `data-provider-id="fake"`, and evidence from any
  other provider is invalid.

---

## File structure

- Create `src/application/lyrics-presentation.ts`: pure escape-action policy, injectable fullscreen port, transient fullscreen state, and runtime subscription.
- Create `src/application/lyrics-presentation.test.ts`: port, failure, external-exit, and escape-priority tests.
- Create `src/components/LyricsFullscreenTransport.tsx`: compact transport with idle visibility policy.
- Create `src/components/LyricsFullscreenTransport.test.tsx`: player-command and visibility tests.
- Modify `src/application/preferences.ts` and `preferences.test.ts`: persisted Lyrics-only `focusSidebarCollapsed` setting.
- Modify `src/App.tsx`: runtime hookup, keyboard policy, shell attributes, and presentation callbacks.
- Modify `src/components/LyricsPanel.tsx` and its test: controls, responsive state, transport, and retained seek/follow behavior.
- Modify `src/components/PlayerBar.tsx`: make the existing fullscreen control open Fullscreen Lyrics instead of remaining disabled.
- Modify `src/styles/shell.css`, `components.css`, and `platform.css`: one-column Focus layout, fullscreen layout, transport, containment, and Linux cost limits.
- Modify `src/locales/en-US.ts` and `zh-CN.ts`: labels and nonfatal fullscreen error copy.
- Split `src-tauri/capabilities/default.json` and create `src-tauri/capabilities/main-window.json`: least-privilege fullscreen permission.
- Modify `docs/lyrics.md`, `docs/design-system.md`, and `docs/linux-acceptance.md`: behavior, shortcuts, performance, and physical acceptance.
- Create `src/application/artwork-source.ts` and tests; modify `src/application/artwork-cache.ts`,
  `src-tauri/src/qqmusic.rs`, and `src-tauri/src/storage.rs`: a closed native artwork boundary with exact origins,
  no redirects, image-only MIME, and validated data-URI results used only by immersive Lyrics.
- Create `src/application/lyrics-appearance.ts` and tests: a pure projection from persisted appearance to immersive Lyrics presentation.
- Create `scripts/capture-windows-lyrics-acceptance.ps1`: semantic WebView2 automation plus native-window image capture.
- Create `scripts/capture-windows-lyrics-acceptance.test.ps1`: hermetic process/CDP/HWND/capture adapter tests.
- Create `scripts/verify-lyrics-acceptance.mjs` and `scripts/verify-lyrics-acceptance.test.ts`: schema, transition, geometry, and hash verification.
- Create `docs/windows-acceptance.md`; modify `docs/appearance.md`, `docs/linux.md`, and `docs/linux-graphics.md`: native acceptance and appearance contracts.
- Deferred authenticated-beta delivery work: modify `scripts/collect-linux-diagnostics.sh`, `src-tauri/src/platform.rs`,
  and `.github/workflows/build.yml`; create `scripts/collect-linux-diagnostics.test.sh` for phase-marked final-AppImage
  diagnostics, synchronized embedded tester instructions, and workflow-generated `BUILD-IDENTITY.json`/hashes.

### Task 1: Persist the Lyrics-only Focus preference

**Files:**

- Modify: `src/application/preferences.ts`
- Modify: `src/application/preferences.test.ts`

**Interfaces:**

- Produces: `LyricDisplaySettings.focusSidebarCollapsed: boolean`
- Consumed by: App shell state and `LyricsPanel` controls in Tasks 3–4.

- [ ] **Step 1: Write failing normalization and store tests**

Add assertions that missing/invalid values normalize to `false`, a valid `true` value survives normalization, and
`updateLyrics({ focusSidebarCollapsed: true })` changes only the Lyrics slice:

```ts
expect(normalizePreferences({ version: 2 }).lyrics.focusSidebarCollapsed).toBe(false);
expect(
  normalizePreferences({ version: 2, lyrics: { focusSidebarCollapsed: true } }).lyrics
    .focusSidebarCollapsed,
).toBe(true);

usePreferencesStore.getState().updateLyrics({ focusSidebarCollapsed: true });
expect(usePreferencesStore.getState().lyrics.focusSidebarCollapsed).toBe(true);
expect(usePreferencesStore.getState().appearance).toEqual(defaultPreferences.appearance);
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npx vitest run src/application/preferences.test.ts`

Expected: TypeScript/test failure because `focusSidebarCollapsed` is absent.

- [ ] **Step 3: Add the setting with an additive default**

Extend the interface/default and normalize only real booleans:

```ts
export interface LyricDisplaySettings {
  translation: SecondaryLyricVisibility;
  romanization: SecondaryLyricVisibility;
  timingOffsetMs: number;
  focusSidebarCollapsed: boolean;
}

lyrics: {
  translation: 'auto',
  romanization: 'auto',
  timingOffsetMs: 0,
  focusSidebarCollapsed: false,
},

focusSidebarCollapsed:
  typeof lyrics.focusSidebarCollapsed === 'boolean' ? lyrics.focusSidebarCollapsed : false,
```

Do not bump preference version: this is an additive field and existing version-2 documents normalize safely.

- [ ] **Step 4: Run focused and related tests**

Run: `npx vitest run src/application/preferences.test.ts`

Expected: preference tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- src/application/preferences.ts src/application/preferences.test.ts
git commit -m "feat: persist lyrics focus preference"
```

### Task 2: Add the fullscreen state/port and least-privilege Tauri capability

**Files:**

- Create: `src/application/lyrics-presentation.ts`
- Create: `src/application/lyrics-presentation.test.ts`
- Modify: `src-tauri/capabilities/default.json`
- Create: `src-tauri/capabilities/main-window.json`

**Interfaces:**

- Produces: `FullscreenPort`, `setFullscreenPortForTests`, `useLyricsPresentationStore`,
  `startLyricsPresentationRuntime`, and `lyricsEscapeAction`.
- Consumed by: `App.tsx` in Task 3.

- [ ] **Step 1: Write failing state-machine tests with a fake port**

Use this test port and assert successful entry, rejected entry, external exit synchronization, and escape priority:

```ts
class FakeFullscreenPort implements FullscreenPort {
  fullscreen = false;
  listener: (() => void) | null = null;
  fail = false;
  async read() {
    return this.fullscreen;
  }
  async write(value: boolean) {
    if (this.fail) throw new Error('denied');
    this.fullscreen = value;
  }
  async subscribe(listener: () => void) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
}

expect(lyricsEscapeAction({ lyricsOpen: true, fullscreen: true, focus: true })).toBe(
  'exit-fullscreen',
);
expect(lyricsEscapeAction({ lyricsOpen: true, fullscreen: false, focus: true })).toBe('exit-focus');
expect(lyricsEscapeAction({ lyricsOpen: true, fullscreen: false, focus: false })).toBe(
  'close-lyrics',
);
```

After `request(true)`, expect `fullscreen=true`, `pending=false`, and no error. When `write` throws, expect the old
fullscreen value to remain and `error` to equal `denied`. Set `port.fullscreen=false`, call `port.listener`, and expect
the store to synchronize to false.

- [ ] **Step 2: Run and confirm the new tests fail**

Run: `npx vitest run src/application/lyrics-presentation.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the presentation module**

Define the exact contracts and Zustand state:

```ts
export interface FullscreenPort {
  read(): Promise<boolean>;
  write(value: boolean): Promise<void>;
  subscribe(listener: () => void): Promise<() => void>;
}

export type LyricsEscapeAction = 'exit-fullscreen' | 'exit-focus' | 'close-lyrics' | 'none';

export function lyricsEscapeAction(input: {
  lyricsOpen: boolean;
  fullscreen: boolean;
  focus: boolean;
}): LyricsEscapeAction {
  if (input.fullscreen) return 'exit-fullscreen';
  if (!input.lyricsOpen) return 'none';
  if (input.focus) return 'exit-focus';
  return 'close-lyrics';
}
```

The Zustand state shape is:

```ts
interface LyricsPresentationState {
  fullscreen: boolean;
  pending: boolean;
  error: string | null;
  request: (value: boolean) => Promise<boolean>;
  sync: () => Promise<void>;
  clearError: () => void;
}
```

`request` increments a module-private generation, sets `pending`, calls `port.write`, confirms with `port.read`, and
changes `fullscreen` only when the confirmation belongs to the latest generation. `sync` captures the current
generation, reads without writing, and discards the result if a request started meanwhile. `startLyricsPresentationRuntime`
subscribes to the current main window's `onResized` event, coalesces resize wake-ups into one microtask, and calls
`sync`; the resize event itself is never treated as fullscreen evidence. It returns an async cleanup function. The
browser port stores an in-memory boolean for deterministic browser development. The native port uses
`getCurrentWindow().isFullscreen()`, `setFullscreen(value)`, and `onResized`.

- [ ] **Step 4: Split capabilities by window**

Change `default.json` to target only auxiliary surfaces:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "lyrics-surfaces",
  "description": "Minimal permissions for dedicated lyric surfaces",
  "windows": ["lyrics-desktop", "lyrics-island"],
  "permissions": ["core:default", "core:window:allow-start-dragging"]
}
```

Create `main-window.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main-window",
  "description": "Main application permissions including user-controlled fullscreen",
  "windows": ["main"],
  "permissions": ["core:default", "core:window:allow-set-fullscreen"]
}
```

- [ ] **Step 5: Run focused tests and validate capability JSON**

Run:

```powershell
npx vitest run src/application/lyrics-presentation.test.ts
Get-Content src-tauri/capabilities/default.json -Raw | ConvertFrom-Json | Out-Null
Get-Content src-tauri/capabilities/main-window.json -Raw | ConvertFrom-Json | Out-Null
```

Expected: tests pass; both JSON commands exit 0.

- [ ] **Step 6: Commit**

```powershell
git add -- src/application/lyrics-presentation.ts src/application/lyrics-presentation.test.ts src-tauri/capabilities/default.json src-tauri/capabilities/main-window.json
git commit -m "feat: add native lyrics fullscreen state"
```

### Task 3: Wire App keyboard policy and shell presentation state

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/application/player-store.ts`
- Modify: `src/application/player-store.test.ts`
- Modify: `src/styles/shell.css`

**Interfaces:**

- Consumes: `focusSidebarCollapsed`, `useLyricsPresentationStore`, `startLyricsPresentationRuntime`, and
  `lyricsEscapeAction`.
- Produces: `openLyrics`, the App-level runtime/keyboard policy, and shell
  `data-lyrics-focus`/`data-lyrics-fullscreen`.
- Defers: `LyricsPanel`/`PlayerBar` presentation props and callbacks until Task 4, where those component
  interfaces are introduced.

- [ ] **Step 1: Write a failing `openLyrics` store test**

```ts
usePlayerStore.setState({ ...initialPlayerState, queueOpen: true, lyricsOpen: false });
usePlayerStore.getState().openLyrics();
expect(usePlayerStore.getState()).toMatchObject({ queueOpen: false, lyricsOpen: true });
```

- [ ] **Step 2: Run the store test and confirm failure**

Run: `npx vitest run src/application/player-store.test.ts`

Expected: FAIL because `openLyrics` is absent.

- [ ] **Step 3: Add `openLyrics` without touching playback state**

Add `openLyrics: () => set({ lyricsOpen: true, queueOpen: false })` to `PlayerActions` and the store.

- [ ] **Step 4: Wire App state, one-shot close recovery, and StrictMode-safe cleanup**

In `App`, select `lyricsOpen`, `focusSidebarCollapsed`, `updateLyrics`, and presentation
`fullscreen/pending/request/sync`. Do not select unused presentation errors or pass props to `LyricsPanel` or
`PlayerBar` yet.

Start the presentation runtime once. Its subscription is asynchronous, so the effect must use a disposed flag,
immediately invoke a late cleanup that resolves after disposal, consume startup rejection, and consume the async
cleanup promise. Do not return an async cleanup directly from `useEffect`. Perform one initial `sync()`.

When `lyricsOpen` transitions to `false`, imperatively inspect the presentation store. If fullscreen entry is
confirmed or still pending, enqueue one `request(false)`. Key this recovery to the Lyrics close transition instead of
the request result, so a persistent native failure does not create an automatic retry loop. Task 4 will route every
direct UI close through a recoverable callback and keep Lyrics visible on a failed exit.

Use this keyboard action block before Space handling:

```ts
if (event.key === 'Escape') {
  const action = lyricsEscapeAction({ lyricsOpen, fullscreen, focus: focusSidebarCollapsed });
  if (action === 'exit-fullscreen') void requestFullscreen(false);
  else if (action === 'exit-focus') updateLyrics({ focusSidebarCollapsed: false });
  else usePlayerStore.getState().closePanels(); // Also preserve Escape closing an open Queue.
  return;
}
if (event.key === 'F11' && lyricsOpen) {
  event.preventDefault();
  if (!fullscreenPending && !event.repeat) void requestFullscreen(!fullscreen);
  return;
}
```

Include every captured state/action in the keyboard effect dependencies so Escape/F11 never use stale presentation
state. The recoverable close callback and PlayerBar fullscreen-entry callback are added in Task 4 after their prop
interfaces exist.

Add shell attributes only while Lyrics is open:

```tsx
<div
  className="app-shell"
  data-lyrics-focus={(lyricsOpen && focusSidebarCollapsed) || undefined}
  data-lyrics-fullscreen={(lyricsOpen && fullscreen) || undefined}
>
```

- [ ] **Step 5: Add shell reflow CSS**

Add rules that use a one-column grid and remove the Sidebar rather than reserving an empty margin:

```css
.app-shell[data-lyrics-focus],
.app-shell[data-lyrics-fullscreen] {
  grid-template-columns: minmax(0, 1fr);
}

.app-shell[data-lyrics-focus] > .sidebar,
.app-shell[data-lyrics-fullscreen] > .sidebar {
  display: none;
}

.app-shell[data-lyrics-focus] > .content-shell,
.app-shell[data-lyrics-focus] > .player-bar {
  grid-column: 1;
}

.app-shell[data-lyrics-fullscreen] > .content-shell,
.app-shell[data-lyrics-fullscreen] > .player-bar {
  visibility: hidden;
}
```

- [ ] **Step 6: Run focused tests and build**

Run:

```powershell
npx vitest run src/application/player-store.test.ts src/application/lyrics-presentation.test.ts
npm run typecheck
npx eslint src/App.tsx src/application/player-store.ts src/application/player-store.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```powershell
git add -- src/App.tsx src/application/player-store.ts src/application/player-store.test.ts src/styles/shell.css
git commit -m "feat: wire lyrics focus and fullscreen shell"
```

### Task 4: Add recoverable Lyrics controls, layout, and localization

**Files:**

- Modify: `src/App.tsx`
- Create: `src/application/lyrics-presentation-actions.ts`
- Create: `src/application/lyrics-presentation-actions.test.ts`
- Modify: `src/components/LyricsPanel.tsx`
- Modify: `src/components/LyricsPanel.test.tsx`
- Modify: `src/components/PlayerBar.tsx`
- Create: `src/components/PlayerBar.test.tsx`
- Modify: `src/styles/components.css`
- Modify: `src/styles/shell.css`
- Modify: `src/locales/en-US.ts`
- Modify: `src/locales/zh-CN.ts`

**Interfaces:**

- Consumes: Task 3 presentation state and `openLyrics`.
- Produces: tested recoverable close/entry orchestration; App callbacks `onToggleFocus`, `onToggleFullscreen`, and
  `onClose`; presentation flags/pending/error; visible Focus/fullscreen controls; and an enabled PlayerBar entry.

- [ ] **Step 1: Write failing orchestration and component tests**

Create application-layer tests for these order and failure contracts:

- `enterLyricsFullscreen()` opens Lyrics and closes Queue before the fullscreen adapter write begins; a rejected entry
  leaves Lyrics visible with the presentation error.
- `closeLyricsPresentation()` closes immediately in normal mode, requests `false` and closes only after a confirmed
  clean exit, remains open after rejected exit, and serializes a pending entry followed by exit before closing.
- Concurrent close callers share one in-flight Promise and issue exactly one native exit. Navigation and Queue entry
  proceed only after that Promise confirms closure; rejection retains Lyrics and the visible error.
- A successful normal close clears a stale presentation error so reopening does not surface an obsolete failure.

Render `LyricsPanel` with explicit presentation props and assert:

```ts
fireEvent.click(screen.getByRole('button', { name: 'Hide navigation' }));
expect(onToggleFocus).toHaveBeenCalledOnce();

fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen lyrics' }));
expect(onToggleFullscreen).toHaveBeenCalledOnce();

rerender(<LyricsPanel {...props} focus fullscreen />);
expect(screen.getByRole('button', { name: 'Show navigation' })).toBeVisible();
expect(screen.getByRole('button', { name: 'Exit fullscreen lyrics' })).toBeVisible();
```

Retain the existing line-click test in both normal and focus props, proving it still seeks through the shared player
contract. Assert that the X button calls only `onClose` and leaves `lyricsOpen` true until the App callback decides.
Assert pending disables the fullscreen action, both data attributes reflect props, and a fullscreen error renders
only the localized message with `role="status"`; the raw native error must not appear as visible text, label, or title.

Create a minimal `PlayerBar` test proving the Lyrics-specific fullscreen label is enabled with a callback, invokes it,
and remains disabled when the optional callback is absent.

- [ ] **Step 2: Run and confirm failure**

Run:

```powershell
npx vitest run src/application/lyrics-presentation-actions.test.ts src/components/LyricsPanel.test.tsx src/components/PlayerBar.test.tsx
```

Expected: FAIL because orchestration, presentation props/controls, and PlayerBar entry do not exist.

- [ ] **Step 3: Add recoverable entry and close orchestration**

Implement `enterLyricsFullscreen(): Promise<boolean>` with imperative store snapshots. If no request is pending,
call `openLyrics()` before `request(true)` so an entry failure remains visible in Lyrics.

Implement `closeLyricsPresentation(): Promise<boolean>`. If already confirmed non-fullscreen and non-pending, clear
any stale presentation error and close. Otherwise await `request(false)`, take a fresh presentation snapshot, and
close only when `fullscreen === false`, `pending === false`, and `error === null`. Return whether Lyrics was closed;
never infer success from `request(false)` returning `false`, because that boolean is the confirmed fullscreen value.
Coalesce overlapping close calls behind one module-level in-flight Promise and clear the reference in `finally`; do
not enqueue duplicate native exits. Add a tested helper for Queue entry that waits for recoverable Lyrics close before
opening Queue while preserving ordinary Queue toggle-close behavior.

- [ ] **Step 4: Add the control cluster and semantic state**

Use `PanelLeftClose`/`PanelLeftOpen`, `Maximize2`/`Minimize2`, and `X` icons. The header starts with:

```tsx
<div className="lyrics-stage__presentation-controls">
  <IconButton label={focus ? t('showNavigation') : t('hideNavigation')} onClick={onToggleFocus}>
    {focus ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
  </IconButton>
  <IconButton
    label={fullscreen ? t('exitFullscreen') : t('enterFullscreen')}
    onClick={onToggleFullscreen}
    disabled={fullscreenPending}
  >
    {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
  </IconButton>
</div>
```

Set `data-focus` and `data-fullscreen` on `.lyrics-stage`. Keep the same scroll container and `unfollowedSongId`
state. On a focus/fullscreen change, call `centerLyricLine` only when `following` is true. The X button delegates only
to `onClose`; it must not call `closePanels` directly. Render a localized `role="status"` when `fullscreenError` is
non-null without exposing the raw value.

- [ ] **Step 5: Wire App and the PlayerBar entry**

In App, select the presentation error and pass every presentation prop/callback added here. Focus toggles the
persistent preference. Fullscreen toggling uses a fresh presentation-store snapshot and no-ops while pending. Close
delegates to `closeLyricsPresentation()`. Escape's `exit-fullscreen` branch explicitly requests `false` instead of
calling the toggle callback. Navigation waits for a successful recoverable close before changing route. PlayerBar
delegates fullscreen entry to `enterLyricsFullscreen()` and Queue entry to the safe Queue helper.

Replace PlayerBar's disabled button with `onEnterLyricsFullscreen?: () => void`; keep it disabled without a callback.
Use `useTranslation('lyrics')` and the Lyrics-specific `enterFullscreen` label, not `player:fullscreen`. When Lyrics is
already open, route its PlayerBar Lyrics button through the same recoverable close callback rather than directly
closing during a pending/fullscreen transition. Route Queue opening through an App callback as well; do not invoke the
store's direct `toggleQueue()` path while Lyrics is fullscreen or pending.

- [ ] **Step 6: Implement responsive layout CSS**

Normal remains `left: 212px; bottom: 92px`. Focus becomes `left: 0`; fullscreen becomes `inset: 0`. Add a header grid
with the control cluster at left and close at right. At narrow/tall aspect ratios, reduce artwork size and use one
column without hiding track identity. Preserve the existing Linux selectors and do not add fullscreen blur/WebGL.

Use `.lyrics-stage[data-focus]` and `.lyrics-stage[data-fullscreen]` so the state rules outrank the later
`@media (max-width: 1120px) .lyrics-stage` left offset; place fullscreen after focus because both attributes can be
present. Rename the heading container so the existing `.lyrics-stage__header > div` rule cannot turn the control
cluster vertical. Remove/replace the shell media rule that hides the last PlayerBar icon so the fullscreen entry stays
visible at the 1000 px acceptance width; compact a lower-priority control instead if space is required.

- [ ] **Step 7: Localize labels**

Add these exact keys in the `lyrics` namespace:

```ts
hideNavigation: 'Hide navigation',
showNavigation: 'Show navigation',
enterFullscreen: 'Enter fullscreen lyrics',
exitFullscreen: 'Exit fullscreen lyrics',
fullscreenFailed: 'Fullscreen could not be changed.',
```

```ts
hideNavigation: '隐藏导航栏',
showNavigation: '显示导航栏',
enterFullscreen: '进入全屏歌词',
exitFullscreen: '退出全屏歌词',
fullscreenFailed: '无法切换全屏状态。',
```

- [ ] **Step 8: Run tests, typecheck, and lint**

Run:

```powershell
npx vitest run src/application/lyrics-presentation-actions.test.ts src/components/LyricsPanel.test.tsx src/components/PlayerBar.test.tsx src/application/preferences.test.ts src/application/lyrics-presentation.test.ts src/application/player-store.test.ts src/i18n.test.ts
npm run typecheck
npm run lint
npx prettier --check src/App.tsx src/application/lyrics-presentation-actions.ts src/application/lyrics-presentation-actions.test.ts src/components/LyricsPanel.tsx src/components/LyricsPanel.test.tsx src/components/PlayerBar.tsx src/components/PlayerBar.test.tsx src/styles/components.css src/styles/shell.css src/locales/en-US.ts src/locales/zh-CN.ts
```

Expected: all pass.

- [ ] **Step 9: Commit**

```powershell
git add -- src/App.tsx src/application/lyrics-presentation-actions.ts src/application/lyrics-presentation-actions.test.ts src/components/LyricsPanel.tsx src/components/LyricsPanel.test.tsx src/components/PlayerBar.tsx src/components/PlayerBar.test.tsx src/styles/components.css src/styles/shell.css src/locales/en-US.ts src/locales/zh-CN.ts
git commit -m "feat: add recoverable lyrics presentation controls"
```

### Task 5: Add compact auto-hiding fullscreen transport

**Files:**

- Create: `src/components/LyricsFullscreenTransport.tsx`
- Create: `src/components/LyricsFullscreenTransport.test.tsx`
- Modify: `src/components/LyricsPanel.tsx`
- Modify: `src/components/LyricsPanel.test.tsx`
- Modify: `src/styles/components.css`
- Modify: `src/styles/platform.css`

**Interfaces:**

- Consumes: `useCurrentSong` and PlayerStore previous/toggle/next/position/playbackDuration state.
- Produces: a fullscreen-only `<LyricsFullscreenTransport ref={transportRef} />` and an imperative `reveal()` handle
  used by pointer movement anywhere on `.lyrics-stage`.

- [ ] **Step 1: Write failing transport tests with fake timers**

Assert that previous, play/pause, and next buttons dispatch through the shared player command adapter and use the
existing localized accessible names. With `isPlaying=true`, initial mount is visible, advancing 2400 ms hides it, and
`reveal()` restores it with exactly one new timeout. Focus a child control, move focus between internal controls, and
advance timers: it remains visible and pinned. Blur outside starts a fresh full timeout. Paused controls remain visible;
paused-to-playing gets a new visible grace period. No current song renders nothing.

Cover progress duration fallback/null/zero and clamp to `[0, 100]`, native snapshot position updates, repeated reveal
keeping `vi.getTimerCount() === 1`, and unmount/StrictMode cleanup returning the timer count to zero. Every fake-timer
test must clear timers and restore real timers in teardown.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/components/LyricsFullscreenTransport.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the transport state machine and reveal handle**

Export `LyricsFullscreenTransportHandle { reveal(): void }`. With React 19, accept a typed `ref` prop and expose
`reveal()` via `useImperativeHandle`. Use one 2400 ms timeout, always cleared before replacement and on unmount. Root
semantics:

```tsx
<div
  className="lyrics-fullscreen-transport"
  data-visible={visible || !isPlaying || focused || undefined}
  role="group"
  aria-label={player('region')}
  onFocusCapture={pinVisible}
  onBlurCapture={(event) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) releaseFocus();
  }}
>
```

Focus entry clears the timer and pins visible. Internal focus moves do not release it. Focus leaving makes it visible
and starts a complete new timeout when playing. Playing mount and paused-to-playing also show first and schedule the
full delay; paused or missing-song state clears the timer.

Render decorative cached artwork, title/artists, and semantic previous/play-pause/next buttons. Use
`playbackDurationMs ?? current.durationMs ?? 0`; compute finite progress as
`durationMs > 0 ? Math.min(100, Math.max(0, positionMs / durationMs * 100)) : 0`. Keep the progress track
`aria-hidden="true"`. Do not call `getEstimatedPositionMs` or add rAF/interval position work; consume existing native
Zustand snapshots.

- [ ] **Step 4: Mount only for active fullscreen**

Render it inside the existing `LyricsPanel` tree when `fullscreen` is true. Pointer movement anywhere on the stage
calls `transportRef.current?.reveal()`. Do not rely on pointer events on the hidden transport itself because its CSS
sets `pointer-events:none`. Add LyricsPanel tests proving normal mode has no transport and that stage pointer movement
reveals a hidden fullscreen transport without breaking header controls or click-to-seek.

- [ ] **Step 5: Add restrained CSS**

Position a compact surface at bottom center, transition only opacity/translate, set `pointer-events:none` while
hidden, restore pointer events while focused/visible, and disable the transition under reduced motion. Linux uses an
opaque/tinted background without `backdrop-filter`; keep that platform rule in `platform.css`, which is imported after
component styles. Use an explicit z-index and bounded viewport width so it does not cover the lower-right Follow
control. Do not set `aria-hidden` while visually hidden: keyboard focus remains a supported reveal path.

- [ ] **Step 6: Run component tests**

Run:

```powershell
npx vitest run src/components/LyricsFullscreenTransport.test.tsx src/components/LyricsPanel.test.tsx
npm test
npm run typecheck
npm run lint
npx prettier --check src/components/LyricsFullscreenTransport.tsx src/components/LyricsFullscreenTransport.test.tsx src/components/LyricsPanel.tsx src/components/LyricsPanel.test.tsx src/styles/components.css src/styles/platform.css
```

Expected: all pass.

- [ ] **Step 7: Commit**

```powershell
git add -- src/components/LyricsFullscreenTransport.tsx src/components/LyricsFullscreenTransport.test.tsx src/components/LyricsPanel.tsx src/components/LyricsPanel.test.tsx src/styles/components.css src/styles/platform.css
git commit -m "feat: add fullscreen lyrics transport"
```

### Task 6: Reduce lyric timing and paint work

**Files:**

- Modify: `src/components/LyricsPanel.tsx`
- Modify: `src/components/LyricsPanel.test.tsx`
- Modify: `src/application/lyrics-timing.ts`
- Modify: `src/application/lyrics-timing.test.ts`
- Modify: `src/application/player-store.ts`
- Modify: `src/application/player-store.test.ts`
- Modify: `src/application/native-player-runtime.ts`
- Create: `src/application/native-player-runtime.test.ts`
- Modify: `src/styles/components.css`
- Modify: `src/styles/platform.css`

**Interfaces:**

- Preserves: `selectLyricCursor`, `wordProgress`, click-to-seek, manual follow state, and normalized lyrics.
- Produces: next-boundary cursor scheduling, immediate discontinuity wake-up, and adaptive active-word updates.

- [ ] **Step 1: Write failing timing, store, runtime, and rendering tests**

Use one documented coordinate model throughout:

```text
lyricTime = playerPosition + presentationOffset - documentOffset
rawBoundary = lyricBoundary + documentOffset
delay = rawBoundary - (playerPosition + presentationOffset) + 8
clickSeek = lineStart + documentOffset - presentationOffset
```

Test `nextLyricBoundaryMs` with finite line starts/effective ends and word starts/ends, exact-boundary strictness,
word/line gaps, untimed intervening lines, inferred null ends, final Infinity exclusion, positive/negative document
offset, presentation and document offsets together, and null/unsynchronized/no-future cases.

In PlayerStore, cover ordinary near-predicted external snapshots, forward/backward discontinuities, exactly 250 ms
versus 251 ms, pause/resume, index change, and same-index/different-track ID. Cover local seek, play/pause, playTracks,
playFromQueue, next/previous, repeat reset, and automatic track advance; ordinary local tick must not increment.

With controlled `document.hidden=false` and focused fake timers, render Lyrics and prove boundary timeouts replace
cursor rAF polling; paused and hidden states retain no timeout, visibility restore corrects immediately, and a revision
wakes seek immediately. Test paused seek inside the same long word updates progress despite unchanged cursor indexes.
Under dynamic reduced motion, the current word becomes discrete 100% with no active-word frame. Hidden documents make
no word style write. A Profiler test applies content-equivalent position snapshots and expects no LyricsPanel commit.

Add a native-runtime gate test where a snapshot event arrives before the initial `player_snapshot` invoke resolves;
the older initial response must be discarded. Gate rendered lyrics by matching `document.songId` to the current track.
Every test overriding `document.hidden`/`visibilityState`, timers, RAF, or prototypes must restore them in teardown.

- [ ] **Step 2: Run and confirm failure**

Run:

```powershell
npx vitest run src/components/LyricsPanel.test.tsx src/application/lyrics-timing.test.ts src/application/player-store.test.ts src/application/native-player-runtime.test.ts
```

Expected: FAIL because next-boundary scheduling/timeline revisions do not exist, cursor polling uses continuous
animation frames, and reduced motion does not reach `SyncedWord`.

- [ ] **Step 3: Add exact next-boundary selection and complete timeline revisions**

Export `nextLyricBoundaryMs(document, rawPositionMs): number | null`, where callers pass
`playerPosition + presentationOffset`. Convert to lyric time by subtracting the document offset. Inspect finite line
starts, finite effective ends, and word starts/ends; return the smallest boundary strictly greater than current lyric
time, converted back by adding the document offset. Never return Infinity.

Add `timelineRevision: number` to PlayerState with initial value 0. Increment on every local discontinuity listed in
Step 1, but not ordinary tick. In `applyExternalSnapshot`, use a functional setter and one `now = performance.now()`
for both prediction and `observedAtMs`. Clamp the prior predicted position, compare both index and track ID, play state,
and absolute position delta strictly greater than 250 ms. Ordinary native polls must not increment.

- [ ] **Step 4: Replace cursor rAF with a visibility-safe boundary scheduler**

Pass `timelineRevision` and `isPlaying` to `useLyricCursor`. Update immediately on effect start. While playing,
compute cursor and boundary from the same `playerPosition + presentationOffset`, then schedule one timeout for the
formula in Step 1, clamped to 16–500 ms as a drift guard. Recompute from current `performance.now()` after every wake;
never accumulate from an old deadline. Paused, hidden, null-document, and no-future-boundary states retain no timer.
Use both a generation/cancelled guard and `clearTimeout`. `visibilitychange` to hidden clears immediately; becoming
visible selects immediately and establishes at most one fresh timer.

- [ ] **Step 5: Make active-word progress adaptive and prevent snapshot-only rerenders**

Change the reduced-motion hook from a ref to boolean state so live media-query changes render. Pass reduced motion and
`timelineRevision` through the active line to `SyncedWord`; include the revision in memo semantics so a paused seek
inside the same word recomputes. Reduced motion renders the current word at static 100% without a frame. Otherwise only
the current word owns an rAF; paused writes once; hidden writes nothing; visibility restoration corrects. Throttle from
the rAF callback timestamp to about 30 Hz on Linux and 60 Hz elsewhere, and cancel on state/word/revision/unmount.

Stop subscribing LyricsPanel to the whole current Song object, because native snapshots deserialize a new queue every
~250 ms. Select only stable primitive presentation fields (track ID, title, artist label, artwork fields) and gate the
lyric document on matching song ID. Content-equivalent position snapshots must not re-render LyricsPanel.

- [ ] **Step 6: Fix initial native snapshot ordering and add safe containment**

In the native runtime, mark when the first `player://snapshot` event is applied and discard an older in-flight initial
`player_snapshot` response that resolves afterward. Preserve cleanup/StrictMode behavior and consume async setup
failures without allowing late writes.

After functional tests pass, apply `contain: layout paint style`, `content-visibility:auto`, and conservative
`contain-intrinsic-block-size:auto ...` to lyric lines; force the active line to `content-visibility:visible` before
measuring it. Verify center geometry with mocked rects, far seeks, multiline secondary text, and manual-follow
preservation. If geometry needs a correction frame, scope tests to cursor/active-word loops rather than asserting that
the entire component never uses rAF. In Linux software/safe mode remove only active-line scaling while preserving its
translate offset.

- [ ] **Step 7: Run focused and full frontend checks**

Run:

```powershell
npx vitest run src/components/LyricsPanel.test.tsx src/application/lyrics-timing.test.ts src/application/player-store.test.ts src/application/native-player-runtime.test.ts
npm run check
npm run format:check
```

Expected: all pass.

- [ ] **Step 8: Commit**

```powershell
git add -- src/components/LyricsPanel.tsx src/components/LyricsPanel.test.tsx src/application/lyrics-timing.ts src/application/lyrics-timing.test.ts src/application/player-store.ts src/application/player-store.test.ts src/application/native-player-runtime.ts src/application/native-player-runtime.test.ts src/styles/components.css src/styles/platform.css
git commit -m "perf: bound immersive lyrics rendering work"
```

### Task 7: Resolve immersive artwork without exposing its remote source

**Files:**

- Create: `src/application/artwork-source.ts`
- Create: `src/application/artwork-source.test.tsx`
- Modify: `src/application/artwork-cache.ts`
- Modify: `src-tauri/src/qqmusic.rs`
- Modify: `src-tauri/src/storage.rs`

**Interfaces:**

- Produces `classifyArtworkSource(source, currentOrigin)`, `isCacheableArtworkSource(source)`,
  `isCachedArtworkDataUri(value)`, and `useSafeArtworkSource(source)` only for the immersive Lyrics stage and its
  transport in Task 8.
- Native direct sources are exactly: non-protocol-relative relative URLs resolved against `currentOrigin`; absolute URLs
  whose `origin` exactly equals `currentOrigin`; any `data:` URL; any `asset:` URL; and URLs whose origin is exactly
  `http://asset.localhost`. Reject an input beginning with `//` before URL resolution, including
  `//y.gtimg.cn/cover.jpg`, because protocol-relative input is remote, not relative-local.
- Native cache eligibility exactly matches Rust `is_allowed_artwork_url`: HTTPS origin on the exact hosts
  `y.gtimg.cn` or `qpic.y.qq.com`, default/explicit port 443 only, with no username or password. Subdomains,
  `*.music.tc.qq.com`, other HTTP(S) origins, non-443 ports, and credential-bearing URLs resolve to `null`.
- In native mode, an eligible remote URL resolves to `null` until `qqmusic_cache_artwork` returns a syntactically
  valid, nonempty `data:image/*;base64,...` value. Validate MIME, the literal base64 flag, alphabet/padding, and a
  successful base64 round trip; reject raw URLs, generic `data:`, empty payloads, malformed IPC values, and stale
  results. Browser development may keep ordinary remote URLs direct, but the native branch must follow this closed
  policy.
- Rust uses a dedicated artwork `reqwest::Client` with `redirect::Policy::none()`; the shared QQ request client keeps
  its existing redirect behavior. Thus every 3xx artwork response is rejected rather than following to an unchecked
  host. `StorageService` requires a normalized `image/*` Content-Type both for a fresh response before writing bytes
  and for a cache hit before returning a data URI; missing/non-image MIME is rejected and any invalid cached artwork
  row/file is evicted.
- The raw remote URL must not enter immersive Lyrics DOM, CSS, logs, or evidence. This closes the current live-DOM
  gap only when Task 8 adopts the hook in both `LyricsPanel` and `LyricsFullscreenTransport`; existing non-Lyrics
  public-artwork consumers remain unchanged and are deferred to the authenticated-beta privacy audit.

- [ ] **Step 1: Write failing source-policy and hook tests**

Table-test direct `/artwork/a.svg`, `./a.svg`, `../a.svg`, exact same-origin absolute, `data:image/png;base64,AA==`,
`asset:/a.png`, and `http://asset.localhost/a.png`. Require rejection of `//y.gtimg.cn/a.jpg` and
`//same-origin.example/a.jpg`. In native mode, table-test exact allowed HTTPS hosts and reject HTTP, subdomains,
credentials, non-443 ports, `https://aqqmusic.tc.qq.com/a.jpg`, `https://music.tc.qq.com/a.jpg`, and
`https://example.com/a.jpg`; in browser mode, prove the same arbitrary HTTPS URL remains direct.

For the hook, cover pending, rejected, stale, and unmount paths. Resolve the IPC mock with a valid PNG data URI, then
mutate it to the original raw URL, `data:text/plain;base64,QQ==`, `data:image/png,raw`, empty/malformed base64, an
object, and `null`; every mutant must yield `null`. Assert the native hook never returns an allowed raw remote URL.

Add Rust unit/integration tests that exact-host URL validation rejects the frontend's former `music.tc` wildcard and
arbitrary remotes; a test-only loopback server returning 302 proves the dedicated artwork client does not follow the
redirect; and storage servers returning `text/html`, missing Content-Type, and `image/png` prove only the image case
is cached/encoded. Seed an invalid cached artwork row to prove cache hits are revalidated and evicted.

- [ ] **Step 2: Run the focused tests and confirm RED**

```powershell
npx vitest run src/application/artwork-source.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::tests::artwork
cargo test --manifest-path src-tauri/Cargo.toml storage::tests::artwork
```

Expected: fail because the closed frontend boundary and scoped redirect/MIME defenses do not exist,
`qpic.y.qq.com` currently bypasses the TypeScript cache allowlist, and `music.tc` is incorrectly accepted.

- [ ] **Step 3: Implement the closed frontend source boundary**

Export the predicates from `artwork-cache.ts`, align exact origins with Rust, and implement the classifier before
calling `new URL` so `//host` cannot be mistaken for same-origin. Implement the hook with a generation token and
effect cleanup so a prior song cannot win. Reuse `qqmusic_cache_artwork`; add no frontend network path. Parse and
validate the returned value before placing it in the memory cache so malformed IPC results cannot poison later
callers. Task 8, not this isolated boundary task, adopts the hook inside immersive Lyrics.

- [ ] **Step 4: Refuse artwork redirects and non-image responses in Rust**

Add `artwork_http: Client` to `QQMusicClient`, built with the same timeouts/user agent and
`reqwest::redirect::Policy::none()`, and pass only that client to `StorageService::artwork_data_uri`; do not alter the
general `http` client. Extend the cache fetch contract with `required_mime_prefix: Option<&str>`: media callers pass
`None`, artwork passes `Some("image/")`. Normalize Content-Type before streaming; reject missing/nonmatching MIME
before creating the target file, and on cache hit revalidate recorded MIME, evicting the invalid row/file before
returning `StorageError::InvalidContentType`. A 3xx from the no-redirect client remains a non-success HTTP error.

- [ ] **Step 5: Run focused and regression checks**

```powershell
npx vitest run src/application/artwork-source.test.tsx src/components/LyricsPanel.test.tsx src/components/LyricsFullscreenTransport.test.tsx
npm run check
npm run format:check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml qqmusic::tests::artwork
cargo test --manifest-path src-tauri/Cargo.toml storage::tests::artwork
```

Expected: all pass, and tests restore mocked Tauri globals, promises, and DOM.

- [ ] **Step 6: Commit the isolated boundary**

```powershell
git add -- src/application/artwork-cache.ts src/application/artwork-source.ts src/application/artwork-source.test.tsx src-tauri/src/qqmusic.rs src-tauri/src/storage.rs
git commit -m "fix: keep native artwork behind the cache"
```

### Task 8: Make immersive Lyrics honor persisted appearance

**Files:**

- Create: `src/application/lyrics-appearance.ts`
- Create: `src/application/lyrics-appearance.test.ts`
- Modify: `src/components/LyricsPanel.tsx`
- Modify: `src/components/LyricsPanel.test.tsx`
- Modify: `src/components/LyricsFullscreenTransport.tsx`
- Modify: `src/components/LyricsFullscreenTransport.test.tsx`
- Modify: `src/styles/components.css`
- Modify: `src/styles/personalization.css`
- Modify: `src/styles/platform.css`

**Interfaces:**

- `resolveLyricsAppearance(background, safeArtworkSource)` returns only `mode`, `imageSource`, `imageFit`, and
  `baseColor` primitives.
- It maps `default` to no image, `color` to the normalized custom color, `image` to the managed data URI and fit,
  and `artwork` to Task 7's safe source. Light/dark foregrounds, washes, controls, and transport use theme tokens;
  the opaque `#121411` stage and unconditional white text are removed.
- `LyricsPanel` exposes only its already-selected primitive track identity as `data-song-id={currentTrackId}` on
  `.lyrics-stage`; this nonlocalized seam lets Task 9 prove which deterministic fixture is rendered without exposing
  provider payloads.

- [ ] **Step 1: Write the failing pure matrix and integration tests**

Table-test light/dark x default/color/image/artwork, invalid colors, missing sources, both image fits, and absence of
raw track URLs. Extend component tests for live appearance mutation without remount, cache-pending/failure,
reduced motion, paused same-word revision, manual follow, click seek, active-word timing, and one active-word rAF.
Require `.lyrics-stage[data-song-id="quiet-light"]` for the fake current track, then change the current track to
`paper-sun` and require the attribute to change; a hard-coded `quiet-light` mutant must fail.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
npx vitest run src/application/lyrics-appearance.test.ts src/components/LyricsPanel.test.tsx src/components/LyricsFullscreenTransport.test.tsx
```

Expected: fail because the stage is hard-coded dark and always consumes current artwork regardless of appearance.

- [ ] **Step 3: Implement the projection and tokenized stage**

Subscribe to primitive appearance fields, call the Task 7 `useSafeArtworkSource` once in `LyricsPanel`, and pass only
that returned safe value to the stage and `LyricsFullscreenTransport`; neither component may retain or render the raw
track artwork URL. Expose stable `data-background-mode`/`data-image-fit`. Render an image only for managed custom
image or resolved artwork. Convert stage, lyric, wash, scrollbar, header, focus control, and transport colors to theme
tokens. Preserve the Linux software/safe transform used for alignment while disabling only blur and expensive effects.
Set `data-song-id={currentTrackId ?? undefined}` on `.lyrics-stage` from the existing primitive selector; do not use
title text or a separately cached Song object.

- [ ] **Step 4: Run focused and full checks**

```powershell
npx vitest run src/application/lyrics-appearance.test.ts src/application/artwork-source.test.tsx src/components/LyricsPanel.test.tsx src/components/LyricsFullscreenTransport.test.tsx
npm run check
npm run format:check
```

Expected: all pass; Profiler/mutation assertions show appearance updates without player or lyric-document remount.

- [ ] **Step 5: Commit the appearance repair**

```powershell
git add -- src/application/lyrics-appearance.ts src/application/lyrics-appearance.test.ts src/components/LyricsPanel.tsx src/components/LyricsPanel.test.tsx src/components/LyricsFullscreenTransport.tsx src/components/LyricsFullscreenTransport.test.tsx src/styles/components.css src/styles/personalization.css src/styles/platform.css
git commit -m "fix: honor appearance in immersive lyrics"
```

### Task 9: Make native evidence machine-verifiable

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Create: `scripts/capture-windows-lyrics-acceptance.ps1`
- Create: `scripts/capture-windows-lyrics-acceptance.test.ps1`
- Create: `scripts/verify-lyrics-acceptance.mjs`
- Create: `scripts/verify-lyrics-acceptance.test.ts`
- Create ignored: `output/visual-acceptance/lyrics-focus-fullscreen/`

**Interfaces and exact evidence contract:**

- Each platform root contains `checklist.md`, `manifest.json`, `commands.log`, `state.jsonl`, `sha256.txt`, and
  `screenshots/*.png`, all ignored by Git.
- CLI in this task: `node scripts/verify-lyrics-acceptance.mjs --platform windows --root <absolute-root>`.
  Deferred delivery checkpoints extend it for final NSIS and Linux schemas.
- Windows attaches to a loopback-only WebView2 CDP port, locates visible controls by role/name or stable `data-*`
  state, and sends real pointer/keyboard input. It must not mutate Zustand or invoke player commands through CDP.
  Required images are real desktop crops of the native HWND client bounds; CDP screenshots are diagnostic only.
- `App` exposes the actual provider as `.app-shell[data-provider-id]`. After CDP attaches, the collector installs its
  preload instrumentation, navigates the existing target to the same Tauri origin with the exact URL
  `/?provider=fake`, waits for `Page.loadEventFired`, and requires both `location.search === '?provider=fake'` and
  `.app-shell.dataset.providerId === 'fake'` before any action. It then sends a real pointer click to the single visible
  featured-release primary Play control on Home, opens Lyrics through the real PlayerBar control, and requires
  `.lyrics-stage.dataset.songId === 'quiet-light'`, the fake featured album's first track. Launch arguments or
  localized provider/title text are not accepted as identity proof.
- Manifest identity fields are `schemaVersion`, `capturedAtUtc`, `gitCommit`, `gitTree`, `platform`, `osVersion`,
  `appVersion`, `webview2Version`, `monitorId`, `visualBinaryPath`, `visualBinarySha256`, `visualBuildKind`,
  `provider`, `fixtureSongId`, and `releaseArtifact` (`path`, `sha256`, `buildKind`, or `null` before its gate).
  `provider` is exactly `"fake"` and `fixtureSongId` is exactly `"quiet-light"` for this gate.
- `gitCommit` is `git rev-parse HEAD`; `gitTree` is `git rev-parse HEAD^{tree}`; binary paths are absolute; hashes
  are lowercase 64-character SHA-256 hex; UTC fields are ISO 8601 with `Z`.
- The local visual gate requires exactly `screenshots/W01.png` through `screenshots/W09.png` and the minimum-size
  smoke `screenshots/S01.png`.
- Every case contains `id`, `theme`, `locale`, `backgroundMode`, `presentation`, `entryPath`, `exitPath`,
  `reducedMotion`, `devicePixelRatio`, `sourceLogicalBounds`, `sourcePhysicalBounds`, `captureLogicalBounds`,
  `capturePhysicalBounds`, `restoredLogicalBounds`, `restoredPhysicalBounds`, `screenshot`, `screenshotSha256`,
  `stateSeqStart`, and `stateSeqEnd`.
- A logical bounds object is exactly `{ x, y, width, height, unit: "logical-px" }`; a physical bounds object has the
  same finite numeric fields and `unit: "physical-px"`. DPR is positive and finite. Exact restoration compares all
  four coordinates in each unit; logical-to-physical conversion permits only the documented one-pixel rounding
  tolerance per edge.
- Every JSONL row contains `seq`, `timestampUtc`, `caseId`, `action`, `source`, `logicalBounds`, `physicalBounds`,
  `devicePixelRatio`, `nativeFullscreen`, `lyricsOpen`, `focus`, `reducedMotion`, `songId`, `playerState`,
  `captureMethod`, and semantic `assertions`; `seq` is strictly increasing.
- The verifier contains this literal immutable W-case contract and compares every field by ID; it does not derive
  expected values from `manifest.json` or `checklist.md`:

| ID  | Source geometry | Presentation      | Theme | Locale | Background | Entry path             | Exit path           | Reduced motion |
| --- | --------------- | ----------------- | ----- | ------ | ---------- | ---------------------- | ------------------- | -------------- |
| W01 | 1280x800        | Normal            | light | en-US  | default    | `playerbar-lyrics`     | `lyrics-close`      | false          |
| W02 | 1280x800        | Focus             | dark  | zh-CN  | artwork    | `focus-toggle`         | `focus-toggle`      | false          |
| W03 | 1280x800        | native fullscreen | dark  | en-US  | image      | `header-fullscreen`    | `header-fullscreen` | false          |
| W04 | 1000x700        | Normal            | light | zh-CN  | color      | `playerbar-lyrics`     | `escape`            | true           |
| W05 | 1000x700        | Focus             | dark  | en-US  | image      | `focus-toggle`         | `escape`            | false          |
| W06 | 1000x700        | native fullscreen | dark  | zh-CN  | artwork    | `playerbar-fullscreen` | `escape`            | true           |
| W07 | 1000x1000       | Normal            | dark  | en-US  | artwork    | `playerbar-lyrics`     | `lyrics-close`      | false          |
| W08 | 1000x1000       | Focus             | light | zh-CN  | default    | `focus-toggle`         | `focus-toggle`      | true           |
| W09 | 1000x1000       | native fullscreen | light | en-US  | color      | `f11`                  | `f11`               | false          |

JSON presentation values are exactly `normal`, `focus`, and `native-fullscreen`; geometry is checked against
`sourceLogicalBounds.width/height`, and `screenshot` must be exactly `screenshots/<ID>.png`. W04, W06, and W08 are
the only required reduced-motion W cases. Any tuple-field edit, case-ID swap, screenshot swap, or reduced-motion
reassignment is invalid even if overall coverage counts remain unchanged.

- Before the fake-provider reload, `Page.addScriptToEvaluateOnNewDocument` wraps `requestAnimationFrame` and
  `CSSStyleDeclaration.prototype.setProperty`. It increments `activeWordRafProgressWrites` only when
  `--word-progress` is written while inside an rAF callback; it does not modify application or player state. For each
  of W04/W06/W08, use `Emulation.setEmulatedMedia` with `prefers-reduced-motion: reduce`, reset the counter, exercise
  an actively playing word, and machine-assert across `.lyrics-stage` plus all descendants that the maximum parsed
  computed `transitionDuration` is `0ms`, maximum `animationDuration` is `0ms`, and
  `activeWordRafProgressWrites === 0`. Persist those exact numeric assertions in the case state rows. Task 6's unit
  test remains the product-code proof; this is native corroboration.
- `sha256.txt` covers checklist, manifest, commands, state, every screenshot, and the visual binary. It omits itself;
  the manifest self-hash is omitted to avoid recursion. `releaseArtifact` must remain null at this checkpoint.

- [ ] **Step 1: Write failing verifier fixture tests**

Build a valid Windows local-visual fixture in a test-owned temporary directory, then mutate missing/extra/duplicate
cases, `provider`, `fixtureSongId`, commit/tree, transitions, sequence, hashes, filename traversal, private URL
leakage, DPR geometry, exact restore, native-crop provenance, a non-null release artifact, and a release-pass claim.
For every W ID, mutate
each tuple field once; swap complete W-case objects between IDs; swap only screenshot names/hashes; move
`reducedMotion: true` from W04/W06/W08 to another case; and set each required zero-duration/rAF assertion nonzero.
Every mutant must fail. Restore globals/timers/directories.

In `App.test.tsx`, render App under `ProviderContext` with `fakeMusicProvider` and require
`.app-shell[data-provider-id="fake"]`; rerender under a stub with ID `qqmusic` and require `qqmusic`, preventing a
hard-coded acceptance marker.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npx vitest run src/App.test.tsx scripts/verify-lyrics-acceptance.test.ts`

Expected: fail because the provider marker and verifier do not exist.

- [ ] **Step 3: Implement the Node-stdlib verifier**

Use only Node JSON/path/PNG-header/crypto APIs. Declare the W01-W09 table above as a literal frozen object in verifier
source. Require `provider: "fake"`, `fixtureSongId: "quiet-light"`, W01-W09 plus local S01,
`releaseArtifact: null`, exact tuple equality, exact logical restore, physical conversion within one rounded pixel per
edge, both hash sources, required transitions, required reduced-motion numeric assertions, and native-crop
provenance. Collect and print all errors before exiting nonzero.

- [ ] **Step 4: Add stable provider identity and hermetic collector tests**

Read `useMusicProvider()` inside `App` and set `data-provider-id={provider.id}` on `.app-shell`; do not expose account
data. Structure the collector around an exported/dot-sourceable `Invoke-WindowsLyricsAcceptance` function accepting
four injected adapter groups with exact names: `Process` (`Start`, `Stop`), `Cdp` (`Connect`, `Send`, `Disconnect`),
`Hwnd` (`ResolveExactlyOne`, `GetClientBounds`), and `Capture` (`SaveClientPng`). Production defaults call the real
implementations; the test script supplies scriptblocks and never launches a GUI.

In `capture-windows-lyrics-acceptance.test.ps1`, implement a no-dependency assertion harness with three suites:

1. success records adapter call order, proves `Page.navigate` uses the attached target's same origin plus
   `/?provider=fake`, proves the Home Play and PlayerBar Lyrics pointer actions precede the identity assertion, emits a
   manifest with `provider = 'fake'` and `fixtureSongId = 'quiet-light'`, and writes only adapter-supplied native crops;
2. failure cases independently inject provider/search mismatch, fixture song `paper-sun`, ambiguous HWND, stale CDP
   state, and crop-bounds mismatch, and require a nonzero/throwing result before a pass manifest is written;
3. finally cleanup makes `Capture.SaveClientPng` throw after process/CDP setup, then proves `Cdp.Disconnect` and
   `Process.Stop` each ran once and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` was restored byte-for-byte (including the
   originally-absent case).

- [ ] **Step 5: Implement the Windows collector**

Accept explicit `-Binary`, `-Output`, and `-BuildKind`; refuse a dirty tracked tree; log commands before execution;
temporarily set `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`; resolve exactly one process
and HWND; and clean environment/processes in `finally`. Fail on ambiguous HWND, identity mismatch, missing control,
stale semantic state, or crop-bounds mismatch.

After initial CDP connection, enable Page/Runtime, install the rAF/style preload observer, derive the current target's
origin, reject non-Tauri or changed origins, call `Page.navigate` to the same origin with exactly
`/?provider=fake`, and wait for the matching `Page.loadEventFired`. Reconnect/reselect the single target if WebView2
changes its target ID during reload. Poll until `document.readyState === 'complete'`, exact `location.search`, and the
stable provider marker all agree; otherwise abort. Use CDP only to locate the unique visible Home featured primary Play
button and PlayerBar Lyrics button, calculate their screen/client centers, and send real pointer input through the input
adapter. Poll `.lyrics-stage[data-song-id]` and abort unless it becomes exactly `quiet-light`; do not set player state,
call a player command, or match the localized title through CDP. Record `provider: 'fake'` and
`fixtureSongId: 'quiet-light'` in the manifest.

For the external-exit probe, first enter fullscreen with real UI input. Then issue these exact CDP
`Runtime.evaluate` expressions separately, each with `awaitPromise: true` and `returnByValue: true`, rejecting
`exceptionDetails` or a nonmatching result:

```text
window.__TAURI_INTERNALS__.metadata.currentWindow.label
window.__TAURI_INTERNALS__.invoke('plugin:window|is_fullscreen',{label:'main'})
window.__TAURI_INTERNALS__.invoke('plugin:window|set_fullscreen',{label:'main',value:false})
window.__TAURI_INTERNALS__.invoke('plugin:window|is_fullscreen',{label:'main'})
```

Require label `main`, native `is_fullscreen === true` before the set, a fulfilled set call, and native
`is_fullscreen === false` afterward; then wait for the app's semantic fullscreen state to reconcile to false and for
exact native bounds restoration. Do not read or assume a public `window.__TAURI__` object. Label this extra probe
`external-native-api`; it cannot satisfy a W case's normal entry/exit tuple.

- [ ] **Step 6: Run tooling checks**

```powershell
npx vitest run src/App.test.tsx scripts/verify-lyrics-acceptance.test.ts
powershell -NoProfile -File scripts/capture-windows-lyrics-acceptance.test.ps1
npx prettier --check scripts/verify-lyrics-acceptance.mjs scripts/verify-lyrics-acceptance.test.ts
powershell -NoProfile -Command "[void][scriptblock]::Create((Get-Content -Raw scripts/capture-windows-lyrics-acceptance.ps1)); [void][scriptblock]::Create((Get-Content -Raw scripts/capture-windows-lyrics-acceptance.test.ps1))"
npm run check
```

Expected: all pass without launching the native app.

- [ ] **Step 7: Commit tooling only**

```powershell
git add -- src/App.tsx src/App.test.tsx scripts/capture-windows-lyrics-acceptance.ps1 scripts/capture-windows-lyrics-acceptance.test.ps1 scripts/verify-lyrics-acceptance.mjs scripts/verify-lyrics-acceptance.test.ts
git commit -m "test: make lyrics evidence verifiable"
```

### Task 10: Pass the Windows local visual checkpoint and document it

**Files:**

- Create: `docs/windows-acceptance.md`
- Modify: `docs/lyrics.md`
- Modify: `docs/design-system.md`
- Modify: `docs/appearance.md`
- Update ignored: `output/visual-acceptance/lyrics-focus-fullscreen/windows/`
- Update ignored: `output/goal-progress.md`

**Required matrix:**

| ID  | Source geometry | Presentation      | Theme | Locale | Background | Entry path             | Exit path           | Reduced motion |
| --- | --------------- | ----------------- | ----- | ------ | ---------- | ---------------------- | ------------------- | -------------- |
| W01 | 1280x800        | Normal            | light | en-US  | default    | `playerbar-lyrics`     | `lyrics-close`      | false          |
| W02 | 1280x800        | Focus             | dark  | zh-CN  | artwork    | `focus-toggle`         | `focus-toggle`      | false          |
| W03 | 1280x800        | native fullscreen | dark  | en-US  | image      | `header-fullscreen`    | `header-fullscreen` | false          |
| W04 | 1000x700        | Normal            | light | zh-CN  | color      | `playerbar-lyrics`     | `escape`            | true           |
| W05 | 1000x700        | Focus             | dark  | en-US  | image      | `focus-toggle`         | `escape`            | false          |
| W06 | 1000x700        | native fullscreen | dark  | zh-CN  | artwork    | `playerbar-fullscreen` | `escape`            | true           |
| W07 | 1000x1000       | Normal            | dark  | en-US  | artwork    | `playerbar-lyrics`     | `lyrics-close`      | false          |
| W08 | 1000x1000       | Focus             | light | zh-CN  | default    | `focus-toggle`         | `focus-toggle`      | true           |
| W09 | 1000x1000       | native fullscreen | light | en-US  | color      | `f11`                  | `f11`               | false          |

S01 is a separate non-release smoke of the same `--no-bundle` binary at the minimum `1000x680`; it cannot replace
W01-W09. Every fullscreen case starts at its table geometry and restores exactly to that source logical and physical
rectangle after exits.

- [ ] **Step 1: Run the pre-acceptance regression gate**

```powershell
npm run format:check
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

Expected: all exit 0 on a clean tracked tree.

- [ ] **Step 2: Build the non-distributable visual gate**

```powershell
npm run tauri -- build --no-bundle
Get-FileHash src-tauri/target/release/yaqmc.exe -Algorithm SHA256
```

Record this as `visualBuildKind: "tauri-no-bundle"`. It closes local checkpoint C only, not release checkpoint K.

- [ ] **Step 3: Capture W01-W09 and S01 with the full sequence**

Run the collector against the exact raw binary; it must perform its own same-origin CDP reload to `?provider=fake`
and refuse to start W01 until query/provider equal `fake`, a real Home Play -> PlayerBar Lyrics path produces
`data-song-id="quiet-light"`, and the manifest records both `provider: "fake"` and
`fixtureSongId: "quiet-light"`:

```powershell
powershell -NoProfile -File scripts/capture-windows-lyrics-acceptance.ps1 `
  -Binary "$PWD/src-tauri/target/release/yaqmc.exe" `
  -Output "$PWD/output/visual-acceptance/lyrics-focus-fullscreen/windows" `
  -BuildKind tauri-no-bundle
```

Use the exact entry/exit path in each table row, with real controls/keys. The broader state sequence additionally
exercises Esc priority fullscreen -> Focus -> close Lyrics, translation, romanization, manual scroll/follow, click
seek, pause/resume, fullscreen track change, Focus PlayerBar sizing, and transport hide/reveal/focus pinning. Only
W04, W06, and W08 set reduced motion; each must record numeric zero maximum computed transition/animation duration
and zero rAF-contained `--word-progress` writes while an active word advances. Non-reduced W cases must record
`reducedMotion: false`; do not satisfy the gate with an unbound extra probe.

For the external-exit probe only, use Task 9's exact `window.__TAURI_INTERNALS__.invoke` sequence, including label and
native before/after checks, without writing presentation state; label it `external-native-api` and verify
resize-listener reconciliation. It cannot satisfy any normal UI path. Capture every W case from the native client crop
with semantic state, DPR, logical/physical bounds, exact restore, and hashes. Run S01 at `1000x680` against the same
binary: open Lyrics, toggle Focus, enter/exit fullscreen through the visible UI, seek a lyric line, and exercise Esc
priority.

- [ ] **Step 4: Verify the visual evidence**

```powershell
node scripts/verify-lyrics-acceptance.mjs --platform windows --root "$PWD/output/visual-acceptance/lyrics-focus-fullscreen/windows"
```

Expected: W01-W09 and S01 pass with `releaseArtifact: null`; no release pass is claimed.

- [ ] **Step 5: Document verified contracts and evidence identities**

Record presentation behavior, appearance mapping, safe artwork boundary, UI/F11/Esc/external exit, reduced motion,
transport, matrix, manifest hash, Git identity, and raw-exe hash. State explicitly that NSIS/release checkpoint K is
open. Update ignored `goal-progress.md` with checkpoint C and the evidence path; never stage it.

- [ ] **Step 6: Check and commit tracked docs only**

```powershell
npx prettier --check docs/windows-acceptance.md docs/lyrics.md docs/design-system.md docs/appearance.md
git diff --check
git status --short --ignored
git add -- docs/windows-acceptance.md docs/lyrics.md docs/design-system.md docs/appearance.md
git commit -m "docs: record windows lyrics acceptance"
```

## Deferred authenticated-beta delivery gates

The checkpoint K reference and Tasks 11-12 belong to the authenticated-beta delivery plan, not Lyrics Task 7.
Stop the Lyrics execution after Task 10. Do not modify the Linux workflow, claim a physical Linux pass, or close the
final AppImage hash here.

### Checkpoint K reference: final Windows NSIS (deferred)

After QQ/authenticated-beta code stabilizes, rerun W01-W09 on that exact clean commit, build the final NSIS, install
it, and rerun S01 from the installed binary. Extend the verifier/release manifest at that time, record installer and
installed-binary hashes, and update Windows acceptance only after both the repeated matrix and installed smoke pass.
No current `--no-bundle` artifact may be promoted to checkpoint K.

### Task 11: Phase Linux diagnostics and embed tester instructions (deferred)

**Files:**

- Modify: `scripts/collect-linux-diagnostics.sh`
- Create: `scripts/collect-linux-diagnostics.test.sh`
- Modify: `scripts/verify-lyrics-acceptance.mjs`
- Modify: `scripts/verify-lyrics-acceptance.test.ts`
- Modify: `src-tauri/src/platform.rs`
- Modify: `.github/workflows/build.yml`
- Modify: `docs/linux-acceptance.md`
- Modify: `docs/linux.md`
- Modify: `docs/linux-graphics.md`

**Interfaces:**

- Canonical modes are `auto`, `native-wayland`, `x11`, and conditional `software`. `baseline` may remain only as a
  compatibility alias for `auto`; it is not XWayland.
- Required phases are `startup-idle`, `playback`, `seek-pause-resume`, `main-scroll-resize`, `lyrics-normal`,
  `lyrics-focus`, `lyrics-fullscreen`, `desktop-lyrics`, `island-lyrics`, `both-surfaces`, and `shutdown`.
- Each sample records phase, UTC timestamp, process tree, RSS/PSS where available, CPU, threads, window state,
  reported Wayland/X11 backend, and graphics environment. Common evidence files follow Task 9 and do not claim a
  pass before verification.
- The final workflow tester bundle contains `BUILD-IDENTITY.json` with exact fields `schemaVersion`, `gitCommit`,
  `gitTree`, `workflowRunId`, `workflowRunAttempt`, `appVersion`, and `appImage` (`fileName`, `sha256`). Commit is
  `${GITHUB_SHA}`, tree is `git rev-parse HEAD^{tree}` in the workflow checkout, run values come from
  `${GITHUB_RUN_ID}`/`${GITHUB_RUN_ATTEMPT}`, version is `src-tauri/tauri.conf.json.version`, and the AppImage name/hash
  identify the final repacked artifact. `SHA256SUMS` covers this identity file and every other packaged file except
  itself.

- [ ] **Step 1: Write a failing hermetic collector test**

With a temporary fake AppImage/process tree and injected command shims, test all mode environments, `baseline`
alias, ordered phases, interrupt cleanup, manifest identity, and refusal to label `software` native. No display
server or real AppImage is needed.

- [ ] **Step 2: Run syntax/behavior tests and confirm RED**

```bash
bash -n scripts/collect-linux-diagnostics.sh scripts/collect-linux-diagnostics.test.sh
bash scripts/collect-linux-diagnostics.test.sh
```

Expected: behavior fails because canonical modes and phase markers do not exist.

- [ ] **Step 3: Implement phase-marked collection**

Add strict arguments, a phase marker consumed by the sampler, ordered prompts, signal-safe cleanup, runtime backend
detection, AppImage/Git identity, and explicit incomplete/pass state. `auto` leaves overrides unset;
`native-wayland` clears X11 overrides; `x11` sets the documented override; `software` adds the renderer downgrade
only after a native failure. Preserve the translated surface; software/safe disables costly effects, not transform.

- [ ] **Step 4: Embed exact platform-tester instructions**

Make the workflow artifact contain the final repacked AppImage, `BUILD-IDENTITY.json`, `TESTING.md`, `ACCEPTANCE.md`,
`collect-linux-diagnostics.sh`, `verify-lyrics-acceptance.mjs`, and `SHA256SUMS`. After repacking, compute the final
AppImage hash, write this exact JSON shape from workflow environment values, then hash every packaged file except
`SHA256SUMS` and immediately run `sha256sum -c SHA256SUMS` from the bundle root. Use this workflow shell/Node shape
after `final_appimage` points to the repacked file; do not construct JSON with unescaped `echo`:

```bash
export BUILD_GIT_TREE="$(git rev-parse 'HEAD^{tree}')"
export BUILD_APP_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')).version")"
export BUILD_APPIMAGE_FILE="$(basename "$final_appimage")"
export BUILD_APPIMAGE_SHA="$(sha256sum "$final_appimage" | cut -d' ' -f1)"
node --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs';

const identity = {
  schemaVersion: 1,
  gitCommit: process.env.GITHUB_SHA,
  gitTree: process.env.BUILD_GIT_TREE,
  workflowRunId: process.env.GITHUB_RUN_ID,
  workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
  appVersion: process.env.BUILD_APP_VERSION,
  appImage: {
    fileName: process.env.BUILD_APPIMAGE_FILE,
    sha256: process.env.BUILD_APPIMAGE_SHA,
  },
};
writeFileSync(
  'release/YAQMC-linux-x86_64/BUILD-IDENTITY.json',
  `${JSON.stringify(identity, null, 2)}\n`,
);
NODE
(
  cd release/YAQMC-linux-x86_64
  find . -type f ! -name SHA256SUMS -printf '%P\0' | sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum -c SHA256SUMS
)
```

Validate commit/tree as 40 lowercase hex, the AppImage hash as 64 lowercase hex, nonempty decimal run fields, and the
version against Tauri config before upload. Instructions name the identity file, exact AppImage, checksum command,
ordered UI actions, output
tree, archive command, and return channel, state that only the final workflow AppImage is valid, and explicitly say
the physical tester does not need a repository checkout.
Extend the verifier with the Linux manifest/mode/phase schema and tests that reject a missing native mode, reordered
phase, backend mismatch, software-only pass, missing/malformed `BUILD-IDENTITY.json`, checksum mismatch, or any
manifest commit/tree/run ID/run attempt/version/AppImage name/hash that differs from the packaged identity. Mutate
each identity field and its `SHA256SUMS` entry independently; also run `--identity-only` with a `git` shim that exits
99 and require success, proving the verifier does not depend on a checkout. Add
`--build-identity "$PWD/BUILD-IDENTITY.json"` and `--identity-only` to the Linux CLI; the first points to the packaged
file and the second validates only identity plus its AppImage hash before a run. The verifier never shells out to Git.

Factor the `README.txt` body in `src-tauri/src/platform.rs` into a testable constant and synchronize it with the
packaged `TESTING.md`: `auto` first, required `native-wayland` and `x11`, conditional `software`, ordered phases,
verifier/archive commands, and final-AppImage-only identity rule. Add a Rust string-content test that asserts those
tokens exist, the no-checkout `BUILD-IDENTITY.json` verification command is present, `baseline` is described only as
the `auto` compatibility alias, and no current baseline is called XWayland.

- [ ] **Step 5: Correct and expand Linux docs**

State that the 2026-08-10 current baseline was native Wayland. Keep XWayland only as historical pre-fix evidence;
remove wording that calls the current baseline XWayland. Document `auto` first, then required native Wayland/X11,
with `software` conditional on a reproduced native graphics failure. Add Focus/fullscreen phases, exact exit/restore,
verifier commands, and the rule that Windows software/safe cannot satisfy Linux. Do not insert a final AppImage hash.

- [ ] **Step 6: Run tooling, doc, and workflow checks**

```bash
bash -n scripts/collect-linux-diagnostics.sh scripts/collect-linux-diagnostics.test.sh
bash scripts/collect-linux-diagnostics.test.sh
npx vitest run scripts/verify-lyrics-acceptance.test.ts
npx prettier --check .github/workflows/build.yml docs/linux-acceptance.md docs/linux.md docs/linux-graphics.md
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml platform::tests
grep -F 'BUILD-IDENTITY.json' .github/workflows/build.yml
grep -F 'GITHUB_RUN_ID' .github/workflows/build.yml
grep -F 'GITHUB_RUN_ATTEMPT' .github/workflows/build.yml
grep -F 'SHA256SUMS' .github/workflows/build.yml
git diff --check
```

Expected: all pass without a physical Linux session.

- [ ] **Step 7: Commit tooling and instructions**

```bash
git add -- scripts/collect-linux-diagnostics.sh scripts/collect-linux-diagnostics.test.sh scripts/verify-lyrics-acceptance.mjs scripts/verify-lyrics-acceptance.test.ts src-tauri/src/platform.rs .github/workflows/build.yml docs/linux-acceptance.md docs/linux.md docs/linux-graphics.md
git commit -m "test: phase linux lyrics acceptance"
```

### Task 12: Release checkpoint for the final AppImage (deferred)

**Files:**

- Modify after verified evidence: `docs/linux-acceptance.md`
- Modify after verified evidence: `docs/linux.md`
- Modify after verified evidence: `docs/linux-graphics.md`
- Update ignored: `output/visual-acceptance/lyrics-focus-fullscreen/linux/`
- Update ignored: `output/goal-progress.md`

**Prerequisite:** Tasks 7-11 are committed and the final GitHub workflow for that exact clean commit has completed.
Download and extract the workflow tester bundle containing its final AppImage, `BUILD-IDENTITY.json`, and
`SHA256SUMS`; no repository checkout is required or accepted as identity evidence. A local/provisional AppImage is
invalid. The final AppImage hash is intentionally absent until this checkpoint verifies it.

- [ ] **Step 1: Verify final artifact identity before launch**

On the physical Arch machine, from the extracted workflow bundle root:

```bash
sha256sum -c SHA256SUMS
node verify-lyrics-acceptance.mjs --platform linux \
  --build-identity "$PWD/BUILD-IDENTITY.json" \
  --identity-only
```

Any build-identity/checksum error is fatal. Populate the ignored manifest from `BUILD-IDENTITY.json`, then record
workflow URL, run ID/attempt, Git commit/tree, AppImage filename/version/hash, OS/kernel/compositor, monitor, scale,
and DPR. The verifier must compare those manifest fields back to the packaged file without invoking Git. Stop on any
identity mismatch.

- [ ] **Step 2: Run required physical modes on that AppImage**

Run `auto`, `native-wayland`, and `x11` through the embedded collector and every ordered phase. In Lyrics
Normal/Focus/fullscreen, repeat UI/F11/Esc/external-exit/reduced-motion, translation/romanization, manual follow,
click seek, pause/resume, track change, desktop Lyrics, Lyrics Island, and exact source-geometry restore. Capture real
native crops, semantic state, logical/physical bounds, DPR, process/resource samples, and hashes.

Run `software` only after a reproducible native graphics failure. It is diagnostic and replaces no native mode.

- [ ] **Step 3: Verify and return ignored evidence**

```bash
node verify-lyrics-acceptance.mjs --platform linux \
  --root "$PWD/output/visual-acceptance/lyrics-focus-fullscreen/linux" \
  --build-identity "$PWD/BUILD-IDENTITY.json"
tar -C output/visual-acceptance/lyrics-focus-fullscreen -czf lyrics-linux-acceptance.tar.gz linux
sha256sum lyrics-linux-acceptance.tar.gz
```

Expected: exit 0 with every required mode/phase, then return archive, hash, and workflow URL via `TESTING.md`.

- [ ] **Step 4: Record a pass only after independent verification**

Only then may tracked docs record the final AppImage hash and pass. On missing/failing evidence, put the concrete
failure in ignored `goal-progress.md`, leave tracked acceptance unchanged, and keep this task unchecked.

- [ ] **Step 5: Check and commit verified Linux results**

```bash
npx prettier --check docs/linux-acceptance.md docs/linux.md docs/linux-graphics.md
git diff --check
git status --short --ignored
git add -- docs/linux-acceptance.md docs/linux.md docs/linux-graphics.md
git commit -m "docs: record final Arch lyrics acceptance"
```
