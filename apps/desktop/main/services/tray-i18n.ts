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

/** Must match `src/locales/zh-CN.ts` `tray.*`. Not the full locale tree. */
export const ZH_CN_TRAY_LABELS: TrayLabels = {
  'show-hide': '显示 / 隐藏',
  'play-pause': '播放 / 暂停',
  previous: '上一首',
  next: '下一首',
  settings: '设置',
  quit: '退出',
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

export function localeFromPreferences(raw: unknown): string | undefined {
  const document = preferencesObject(raw);
  return typeof document?.locale === 'string' ? document.locale : undefined;
}

export function trayLabelsForLocale(locale: string, systemLang?: string): TrayLabels {
  if (locale === 'zh-CN') {
    return { ...ZH_CN_TRAY_LABELS };
  }
  if (locale === 'en-US') {
    return { ...DEFAULT_TRAY_LABELS };
  }
  if (locale === 'system' && (systemLang ?? '').toLowerCase().startsWith('zh')) {
    return { ...ZH_CN_TRAY_LABELS };
  }
  return { ...DEFAULT_TRAY_LABELS };
}

function preferencesObject(raw: unknown): { locale?: unknown } | undefined {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as { locale?: unknown };
    } catch {
      return undefined;
    }
  }
  if (raw && typeof raw === 'object') {
    return raw as { locale?: unknown };
  }
  return undefined;
}

export function resolveTrayLabels(labels?: Partial<TrayLabels>): TrayLabels {
  return { ...DEFAULT_TRAY_LABELS, ...labels };
}
