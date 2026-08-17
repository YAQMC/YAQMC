import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveTrayLabels, TRAY_MENU_IDS, type TrayLabels, type TrayMenuId } from './tray-i18n';

export {
  DEFAULT_TRAY_LABELS,
  TRAY_I18N_KEYS,
  TRAY_MENU_IDS,
  ZH_CN_TRAY_LABELS,
  localeFromPreferences,
  resolveTrayLabels,
  trayLabelsForLocale,
  trayLabelsFromLocale,
  type TrayLabels,
  type TrayMenuId,
} from './tray-i18n';

/**
 * Preserved renderer channel. Host wiring (not this module) emits it;
 * tests inject `openSettings` and must not send IPC.
 */
export const OPEN_SETTINGS_CHANNEL = 'app://open-settings';

export type PlayerInvokeMethod = 'toggle' | 'next' | 'previous';

export type TrayWindow = {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  show(): void;
  hide(): void;
  restore(): void;
  focus(): void;
};

export type TrayMenuItem = {
  id?: string;
  label?: string;
  type?: 'normal' | 'separator';
  click?: () => void;
};

export type TrayInstance = {
  setContextMenu(menu: unknown): void;
  setToolTip(tooltip: string): void;
  on(event: 'click', listener: () => void): unknown;
  destroy(): void;
};

export type TrayApis = {
  Tray: new (icon: string) => TrayInstance;
  Menu: {
    buildFromTemplate(template: TrayMenuItem[]): unknown;
  };
};

export type CreateTrayOptions = {
  apis: TrayApis;
  resourcesDir: string;
  getMainWindow: () => TrayWindow | undefined;
  invokePlayer: (method: PlayerInvokeMethod) => void | Promise<void>;
  /** Host wires this to emit `app://open-settings`. Do not send IPC here. */
  openSettings: () => void;
  quit: () => void;
  /** Menu labels; omitted keys fall back to English matching the current strings. */
  labels?: Partial<TrayLabels>;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  log?: (message: string, extra?: Record<string, unknown>) => void;
};

export type TrayHandle = {
  iconPath: string;
  destroy(): void;
  /** Rebuild the context menu with merged labels (locale switch). */
  applyLabels(labels: Partial<TrayLabels>): void;
  /** Alias of `applyLabels` for host injection. */
  setLabels(labels: Partial<TrayLabels>): void;
  /** Programmatic menu click (Playwright / unit tests). */
  click(id: TrayMenuId): boolean;
};

/**
 * Close-to-tray gate for the main-window close handler.
 *
 * FACT `src-tauri/src/lib.rs`: hide (do not destroy) when
 * `close_hides_to_tray` is true — i.e. `system.closeBehavior` is not `"quit"`
 * (default hide-to-tray). `trayActive` is the Electron extra: if tray creation
 * failed there is nowhere to hide to, so close proceeds.
 */
export function shouldHideInsteadOfClose(options: {
  closeToTray: boolean;
  trayActive: boolean;
}): boolean {
  return options.closeToTray && options.trayActive;
}

/**
 * FACT: plan §26.1 names the tray icon `yaqmc-tray`. ELEC-07 staged
 * `icon.ico` / `icon.png` (plus 32/64/128) under `apps/desktop/resources/`;
 * no `yaqmc-tray.*` file exists. Prefer the named asset when present, else
 * the staged ico (Windows) / png (elsewhere).
 */
export function resolveTrayIconPath(
  resourcesDir: string,
  platform: NodeJS.Platform = process.platform,
  exists: (filePath: string) => boolean = existsSync,
): string {
  const named = platform === 'win32' ? 'yaqmc-tray.ico' : 'yaqmc-tray.png';
  const namedPath = path.join(resourcesDir, named);
  if (exists(namedPath)) {
    return namedPath;
  }
  return path.join(resourcesDir, platform === 'win32' ? 'icon.ico' : 'icon.png');
}

export function toggleMainWindow(getMainWindow: () => TrayWindow | undefined): void {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) {
    return;
  }
  if (window.isVisible() && !window.isMinimized()) {
    window.hide();
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

export function createTray(options: CreateTrayOptions): TrayHandle {
  const platform = options.platform ?? process.platform;
  const exists = options.existsSync ?? existsSync;
  const iconPath = resolveTrayIconPath(options.resourcesDir, platform, exists);
  const tray = new options.apis.Tray(iconPath);
  let labels = resolveTrayLabels(options.labels);
  const clicks = new Map<TrayMenuId, () => void>();

  const runPlayer = (method: PlayerInvokeMethod): void => {
    void Promise.resolve(options.invokePlayer(method)).catch((error: unknown) => {
      options.log?.('tray command rejected', { method, error: String(error) });
    });
  };

  const rebuildMenu = (): void => {
    const template: TrayMenuItem[] = [
      {
        id: 'show-hide',
        label: labels['show-hide'],
        click: () => toggleMainWindow(options.getMainWindow),
      },
      { type: 'separator' },
      { id: 'play-pause', label: labels['play-pause'], click: () => runPlayer('toggle') },
      { id: 'previous', label: labels.previous, click: () => runPlayer('previous') },
      { id: 'next', label: labels.next, click: () => runPlayer('next') },
      { type: 'separator' },
      { id: 'settings', label: labels.settings, click: () => options.openSettings() },
      { type: 'separator' },
      { id: 'quit', label: labels.quit, click: () => options.quit() },
    ];
    clicks.clear();
    for (const item of template) {
      if (item.id && item.click && (TRAY_MENU_IDS as readonly string[]).includes(item.id)) {
        clicks.set(item.id as TrayMenuId, item.click);
      }
    }
    tray.setContextMenu(options.apis.Menu.buildFromTemplate(template));
  };

  const applyLabels = (next: Partial<TrayLabels>): void => {
    labels = resolveTrayLabels({ ...labels, ...next });
    rebuildMenu();
  };

  rebuildMenu();
  tray.setToolTip('YAQMC');
  tray.on('click', () => toggleMainWindow(options.getMainWindow));

  return {
    iconPath,
    destroy: () => tray.destroy(),
    applyLabels,
    setLabels: applyLabels,
    click(id) {
      const run = clicks.get(id);
      if (!run) {
        return false;
      }
      run();
      return true;
    },
  };
}
