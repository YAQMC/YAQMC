# Lyrics Focus and Fullscreen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Lyrics-only Focus preference, native main-window fullscreen, compact fullscreen transport, and lower-cost synchronized lyric rendering without remounting the player or lyric surface.

**Architecture:** Keep the existing `LyricsPanel` mounted for Normal, Focus, and Fullscreen states. A small Zustand presentation store wraps an injectable main-window fullscreen port; App keyboard handling and shell data attributes drive layout while the Rust `PlayerService` remains untouched. Split Tauri capabilities so only the main window can change fullscreen state.

**Tech Stack:** React 19, TypeScript 6, Zustand 5, Vitest/Testing Library, Tauri 2 window API, CSS, i18next.

## Global Constraints

- Do not add `applemusic-like-lyrics` or copy AMLL source, CSS, shaders, assets, DOM structure, or animation constants; its inspected revision is AGPL-3.0-only.
- Keep one authoritative native `PlayerService`; presentation transitions must not issue queue/playback reconstruction commands.
- Focus is a Lyrics-only preference. Home, Search, Explore, Library, and Settings keep the normal sidebar.
- Only the `main` WebView may receive `core:window:allow-set-fullscreen`.
- `Esc` priority is native fullscreen, Lyrics Focus, then closing Lyrics. `F11` toggles fullscreen only while Lyrics is open.
- Preserve translation, romanization, word timing, manual scroll, click-to-seek, reduced motion, and the Linux graphics downgrade policy.
- Every user-visible string must exist in both `en-US` and `zh-CN` resources.

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
- Modify: `src/styles/components.css`
- Modify: `src/styles/platform.css`

**Interfaces:**

- Preserves: `selectLyricCursor`, `wordProgress`, click-to-seek, manual follow state, and normalized lyrics.
- Produces: next-boundary cursor scheduling, immediate discontinuity wake-up, and adaptive active-word updates.

- [ ] **Step 1: Write failing timer/reduced-motion tests**

Test `nextLyricBoundaryMs` with line starts/ends, word gaps, document offset, and no future boundary. In PlayerStore,
apply a normal near-predicted snapshot and assert `timelineRevision` is unchanged; apply a seek-sized discontinuity,
track change, and pause/resume and assert it increments. With fake timers, render an open panel and assert cursor
selection schedules a timeout to the next boundary rather than a cursor `requestAnimationFrame`; increment the
timeline revision and verify a seek updates immediately. Under `prefers-reduced-motion: reduce`, assert the current
word receives the discrete class/data state and no animation frame is scheduled. After `document.hidden=true`, assert
no new active-word style write occurs.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/components/LyricsPanel.test.tsx`

Expected: FAIL because next-boundary scheduling/timeline revisions do not exist, cursor polling uses continuous
animation frames, and reduced motion does not reach `SyncedWord`.

- [ ] **Step 3: Add next-boundary selection and timeline revisions**

Export `nextLyricBoundaryMs(document, rawPositionMs): number | null`. Convert raw position by metadata offset, inspect
future line starts/effective ends and word starts/ends, and return the earliest future boundary converted back to raw
time. Add `timelineRevision: number` to PlayerState with initial value 0. In `applyExternalSnapshot`, compare the new
track/index, play state, and position to the prior state's estimated position; increment only for track changes,
pause/resume, or a position discontinuity greater than 250 ms. Ordinary native poll snapshots must not increment.

- [ ] **Step 4: Replace cursor rAF with boundary scheduling**

Pass `timelineRevision` and `isPlaying` to `useLyricCursor`. Update immediately on effect start. While playing,
schedule one timeout for `nextBoundary - estimatedPosition + 8 ms`, clamped to 16–500 ms as a drift guard; when it
fires, select the cursor and schedule the next boundary. When paused, schedule no timer—the revision wakes paused
seeks. Use an effect generation and clear the timer on document/offset/revision/play-state/unmount change. Add a
`visibilitychange` wake-up so a throttled background tab corrects immediately when shown.

- [ ] **Step 5: Make active-word progress adaptive**

Pass a boolean reduced-motion value to `SyncedWord`. In reduced motion, set the current word to a static 100% fill
and do not schedule a frame. Otherwise update only the active word; skip while `document.hidden`, and throttle style
writes to approximately 30 fps on Linux (`document.documentElement.dataset.platform === 'linux'`) and 60 fps on
Windows. Cancel the frame on state/word/unmount changes.

- [ ] **Step 6: Add containment after functional tests pass**

Apply `contain: layout paint style` to lyric lines and `content-visibility: auto` with a conservative intrinsic block
size. Verify `centerLyricLine` still obtains correct geometry for the active line. In software graphics mode, disable
transform scaling as the existing platform policy already disables long animations.

- [ ] **Step 7: Run focused and full frontend checks**

Run:

```powershell
npx vitest run src/components/LyricsPanel.test.tsx src/application/lyrics-timing.test.ts src/application/player-store.test.ts
npm run check
npm run format:check
```

Expected: all pass.

- [ ] **Step 8: Commit**

```powershell
git add -- src/components/LyricsPanel.tsx src/components/LyricsPanel.test.tsx src/application/lyrics-timing.ts src/application/lyrics-timing.test.ts src/application/player-store.ts src/application/player-store.test.ts src/styles/components.css src/styles/platform.css
git commit -m "perf: bound immersive lyrics rendering work"
```

### Task 7: Native visual acceptance and documentation

**Files:**

- Modify: `docs/lyrics.md`
- Modify: `docs/design-system.md`
- Modify: `docs/linux-acceptance.md`
- Create ignored evidence under: `output/visual-acceptance/lyrics-focus-fullscreen/`

**Interfaces:**

- Consumes: completed Tasks 1–6.
- Produces: locally verified Windows evidence and an exact Arch retest sequence.

- [ ] **Step 1: Run all frontend/Rust regression checks**

Run:

```powershell
npm run format:check
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

Expected: every command exits 0.

- [ ] **Step 2: Build and run the Windows native application**

Run: `npm run tauri -- build --no-bundle`

Expected: `src-tauri/target/release/yaqmc.exe` exists and launches without a capability error.

- [ ] **Step 3: Capture the required layouts**

Using the native fake provider, capture Normal, Focus, and Fullscreen Lyrics at 1000x680 and 1280x800, plus OS
fullscreen. Cover English/Chinese, light/dark, default/custom-color/custom-image/artwork backgrounds. Verify sidebar
recovery, artwork/lyric reflow, translation/romanization, manual scroll, click-to-seek while the sidebar is hidden,
track change while fullscreen, PlayerBar sizing in Focus, compact transport hide/reveal/focus pin, UI exit, F11 exit,
Esc priority, compositor exit synchronization, and resize after exit. Store screenshots and a text checklist only
under the ignored output path.

- [ ] **Step 4: Document the implemented contract**

Update Lyrics/design docs with the three presentation states, Focus persistence scope, F11/Esc behavior, reduced
motion, transient transport, and the AMLL no-code-reuse boundary. Extend Linux acceptance with phase markers for
Focus/fullscreen resource sampling and the native-Wayland exit/restore checks.

- [ ] **Step 5: Run doc formatting and diff checks**

Run:

```powershell
npx prettier --check docs/lyrics.md docs/design-system.md docs/linux-acceptance.md
git diff --check
```

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add -- docs/lyrics.md docs/design-system.md docs/linux-acceptance.md
git commit -m "docs: record immersive lyrics acceptance"
```
