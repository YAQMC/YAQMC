/**
 * Windows native input policy for lyrics overlays.
 *
 * Intended architecture is Option A: when locked, the whole
 * lyrics HWND is click-through. Unlock is a separate 42×42 overlay, not a
 * hole punched with `{ forward: true }`.
 *
 * Electron 43 facts this module depends on:
 *
 * - `setIgnoreMouseEvents(true)` without `{ forward: true }` sets
 *   `WS_EX_TRANSPARENT | WS_EX_LAYERED` on the top-level HWND (SURF-02).
 *   `{ forward: true }` keeps the HWND in the hit-test path.
 * - `setAlwaysOnTop(true, level)` always uses Chromium `kFloatingWindow`
 *   (`HWND_TOPMOST`). The level string does **not** raise the window into a
 *   security-surface band. On Windows, `floating` / `torn-off-menu` /
 *   `modal-panel` / `main-menu` / `status` call `SetWindowPos(hwnd, taskbar)`
 *   so the overlay sits **behind the taskbar** (and tray popups). `screen-saver`
 *   skips that, so the HWND stays above Explorer tray menus.
 * - `setAlwaysOnTop` restyles the HWND. Re-apply ignore-mouse **after** it.
 * - `setFocusable(true)` calls `SetSkipTaskbar(false)` on Windows. Overlays
 *   must restore `skipTaskbar` after becoming focusable.
 * - `hookWindowMessage` callbacks are `void`. Their return value is **not**
 *   sent to DefWindowProc, so they cannot return `HTTRANSPARENT` /
 *   `MA_NOACTIVATE`. Do not hook `WM_NCHITTEST` (it would only bounce into
 *   V8 on every hit-test).
 */

/** Locked lyrics: HWND_TOPMOST, inserted behind the Windows taskbar. */
export const LYRICS_LOCKED_ALWAYS_ON_TOP_LEVEL = 'floating' as const;

export type OverlayInputWindow = {
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  setFocusable(focusable: boolean): void;
  setResizable?(resizable: boolean): void;
  setAlwaysOnTop?(flag: boolean, level?: string): void;
  setSkipTaskbar?(skip: boolean): void;
  moveTop?(): void;
  showInactive?(): void;
  show?(): void;
};

/** Locked lyrics: true click-through, no activation, no mouse forwarding. */
export function applyLockedSurfaceInput(window: OverlayInputWindow): void {
  window.setAlwaysOnTop?.(true, LYRICS_LOCKED_ALWAYS_ON_TOP_LEVEL);
  window.setFocusable(false);
  // `{ forward: true }` keeps the HWND in the Windows hit-test path (SURF-02).
  // Must run after `setAlwaysOnTop` so Chromium's z-order restyle cannot drop
  // `WS_EX_TRANSPARENT`.
  window.setIgnoreMouseEvents(true);
}

/** Unlocked lyrics: interactive, restacked above the locked / taskbar band. */
export function applyUnlockedSurfaceInput(
  window: OverlayInputWindow,
  resizableWhenUnlocked: boolean,
  alwaysOnTopLevel: string,
): void {
  window.setIgnoreMouseEvents(false);
  window.setFocusable(true);
  window.setSkipTaskbar?.(true);
  window.setResizable?.(resizableWhenUnlocked);
  window.setAlwaysOnTop?.(true, alwaysOnTopLevel);
}

/**
 * Unlock pill: a separate HWND that must receive clicks. Chromium does not
 * dispatch clicks to `focusable: false` transparent windows, so the pill is
 * focusable at show-time. `showInactive` + `moveTop` keep it above the
 * click-through lyrics surface without activating Fullscreen Lyrics.
 */
export function applyUnlockOverlayInput(window: OverlayInputWindow, alwaysOnTopLevel: string): void {
  window.setIgnoreMouseEvents(false);
  window.setFocusable(true);
  window.setSkipTaskbar?.(true);
  window.setAlwaysOnTop?.(true, alwaysOnTopLevel);
  window.moveTop?.();
}

export function showOverlayInactive(window: OverlayInputWindow): void {
  if (typeof window.showInactive === 'function') {
    window.showInactive();
    return;
  }
  window.show?.();
}
