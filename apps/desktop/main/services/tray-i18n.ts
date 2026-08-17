/**
 * Main-side tray labels keyed by Electron menu id.
 *
 * Strings live in the renderer i18next dictionaries (`src/locales/en-US.ts`,
 * `zh-CN.ts`) under `tray.*` using the same id names. This module maps those
 * keys for the tray service so locale switch can rebuild the menu without
 * bundling the full locale trees into Main.
 */

export const TRAY_MENU_IDS = [
  'show-hide',
  'play-pause',
  'previous',
  'next',
  'settings',
  'quit',
] as const;

export type TrayMenuId = (typeof TRAY_MENU_IDS)[number];

export type TrayLabels = Record<TrayMenuId, string>;

/** i18next key path for each Electron tray menu id. */
export const TRAY_I18N_KEYS = {
  'show-hide': 'tray.show-hide',
  'play-pause': 'tray.play-pause',
  previous: 'tray.previous',
  next: 'tray.next',
  settings: 'tray.settings',
  quit: 'tray.quit',
} as const satisfies Record<TrayMenuId, `tray.${TrayMenuId}`>;

/** Default English — matches the current hardcoded `createTray` strings. */
export const DEFAULT_TRAY_LABELS: TrayLabels = {
  'show-hide': 'Show / Hide',
  'play-pause': 'Play / Pause',
  previous: 'Previous',
  next: 'Next',
  settings: 'Settings',
  quit: 'Quit',
};

export function trayLabelsFromLocale(tray: TrayLabels): TrayLabels {
  return {
    'show-hide': tray['show-hide'],
    'play-pause': tray['play-pause'],
    previous: tray.previous,
    next: tray.next,
    settings: tray.settings,
    quit: tray.quit,
  };
}

export function resolveTrayLabels(labels?: Partial<TrayLabels>): TrayLabels {
  return { ...DEFAULT_TRAY_LABELS, ...labels };
}
