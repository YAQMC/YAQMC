/**
 * Diagnostic Chromium switches for Windows overlay occlusion A/B.
 *
 * Real-app (no CDP) A/B on 2026-08-20: overlay-open Fullscreen Lyrics dropped
 * from ~240 Hz to ~45 Hz with p95 ~254 ms. `document.hidden` stayed false,
 * main `visualIdle` stayed false, and `--disable-backgrounding-occluded-windows`
 * did not restore rAF. Overlay `show()` stole focus from the fullscreen main
 * window. Production default is no switches; `YAQMC_WINDOWS_OCCLUSION=on` is
 * opt-in only.
 *
 * This module never emits renderer-wide `--disable-renderer-backgrounding` or
 * `--disable-background-timer-throttling`. Main applies returned switches
 * before `ready`. Linux/macOS: empty.
 */

export const DISABLE_BACKGROUNDING_OCCLUDED_WINDOWS =
  '--disable-backgrounding-occluded-windows';
export const DISABLE_CALCULATE_NATIVE_WIN_OCCLUSION =
  '--disable-features=CalculateNativeWinOcclusion';

export const WINDOWS_OCCLUSION_SWITCH_ALLOWLIST = [
  DISABLE_BACKGROUNDING_OCCLUDED_WINDOWS,
  DISABLE_CALCULATE_NATIVE_WIN_OCCLUSION,
] as const;

export type WindowsOcclusionSwitch = (typeof WINDOWS_OCCLUSION_SWITCH_ALLOWLIST)[number];

export type WindowsOcclusionOptions = {
  platform: NodeJS.Platform | string;
  /**
   * `auto` / `off` — no switches (production default).
   * `on` — occluded-window backgrounding off (diagnostic A/B only).
   * `occlusion-tracker-off` — also disable CalculateNativeWinOcclusion.
   */
  mode?: string;
};

function canonicalMode(mode: string | undefined): string {
  return (mode ?? 'auto').trim().toLowerCase();
}

/**
 * Allowlisted Chromium switches for Windows overlay occlusion.
 * Empty on every non-Windows platform.
 */
export function windowsOcclusionSwitches(
  options: WindowsOcclusionOptions,
): readonly WindowsOcclusionSwitch[] {
  if (options.platform !== 'win32') {
    return [];
  }
  switch (canonicalMode(options.mode)) {
    case 'on':
      return [DISABLE_BACKGROUNDING_OCCLUDED_WINDOWS];
    case 'occlusion-tracker-off':
      return [DISABLE_BACKGROUNDING_OCCLUDED_WINDOWS, DISABLE_CALCULATE_NATIVE_WIN_OCCLUSION];
    default:
      // auto/off: do not change Chromium. Occluded-window backgrounding was
      // A/B'd and did not restore Fullscreen rAF; overlay `show()` focus-steal
      // did. Keep `on` for an explicit diagnostic retry only.
      return [];
  }
}

/** Merge Chromium `enable-features` / `disable-features` comma lists. */
export function mergeChromiumFeatureList(existing: string | undefined, next: string): string {
  const parts = new Set<string>();
  for (const item of `${existing ?? ''},${next}`.split(',')) {
    const trimmed = item.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}
