/**
 * §29.2 Linux Chromium graphics switch policy (ADR-008). This module
 * never calls `app.commandLine.appendSwitch`. Main applies the returned
 * switches before `ready`.
 *
 * Electron must not copy today's WebKitGTK env mutation in `platform.rs`
 * (`WEBKIT_DISABLE_DMABUF_RENDERER`, `WEBKIT_DISABLE_COMPOSITING_MODE`,
 * `LIBGL_ALWAYS_SOFTWARE`, `__NV_DISABLE_EXPLICIT_SYNC`). Those exist solely
 * for WebKitGTK (TD-1). Chromium/Ozone is a different stack.
 *
 * `YAQMC_LINUX_RENDERER` is not read here. The caller passes `mode` (settings
 * or that deprecated env) and this table maps it. Default / auto: no flags.
 */

export type LinuxGraphicsOptions = {
  platform: NodeJS.Platform | string;
  /** Session is Wayland (including XWayland hosts). Does not select native Ozone Wayland. */
  wayland: boolean;
  /** NVIDIA GPU present. Does not inject WebKitGTK NVIDIA workarounds. */
  nvidia: boolean;
  /** Settings or `YAQMC_LINUX_RENDERER` string. Unknown values behave as `auto`. */
  mode: string;
};

/**
 * `--ozone-platform=wayland` — user opt-in `native-wayland` only.
 * ADR-008 keeps the default backend on X11/XWayland so always-on-top and
 * click-through overlays keep working. `--ozone-platform-hint=auto` is
 * intentionally never returned.
 */
const OZONE_PLATFORM_WAYLAND = '--ozone-platform=wayland';

/**
 * `--disable-gpu` — `gpu-off`, replacing today's `software` / `safe` renderer
 * mode. Do not set `LIBGL_ALWAYS_SOFTWARE` or disable WebKitGTK DMA-BUF.
 */
const DISABLE_GPU = '--disable-gpu';

/**
 * `--enable-features=VaapiVideoDecodeLinuxGL` — `vaapi-on` only (default off).
 * Chromium 150 / Electron 43.4.0 VideoDecode path; needs per-distro acceptance
 * (§29.2) before it can become default.
 */
const VAAPI_VIDEO_DECODE = '--enable-features=VaapiVideoDecodeLinuxGL';

export const LINUX_GRAPHICS_SWITCH_ALLOWLIST = [
  OZONE_PLATFORM_WAYLAND,
  DISABLE_GPU,
  VAAPI_VIDEO_DECODE,
] as const;

export type LinuxGraphicsSwitch = (typeof LINUX_GRAPHICS_SWITCH_ALLOWLIST)[number];

function canonicalMode(mode: string): string {
  return mode.trim().toLowerCase();
}

/**
 * Allowlisted Chromium switches for the given Linux graphics facts.
 * Empty on Windows and every other non-Linux platform.
 */
export function linuxGraphicsSwitches(
  options: LinuxGraphicsOptions,
): readonly LinuxGraphicsSwitch[] {
  const { platform, wayland, nvidia, mode } = options;
  // Caller-supplied session/GPU facts must not resurrect WebKitGTK env magic.
  void wayland;
  void nvidia;

  if (platform !== 'linux') {
    return [];
  }

  switch (canonicalMode(mode)) {
    case 'native-wayland':
      return [OZONE_PLATFORM_WAYLAND];
    case 'gpu-off':
    case 'software':
    case 'safe':
      return [DISABLE_GPU];
    case 'vaapi-on':
      return [VAAPI_VIDEO_DECODE];
    default:
      // auto, baseline, x11, and WebKitGTK-only names (dmabuf, compositing-off, …)
      return [];
  }
}
