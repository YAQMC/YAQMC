import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  createTray,
  OPEN_SETTINGS_CHANNEL,
  resolveTrayIconPath,
  shouldHideInsteadOfClose,
  toggleMainWindow,
  type TrayApis,
  type TrayInstance,
  type TrayMenuItem,
  type TrayWindow,
} from './tray';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resourcesDir = path.join(desktopRoot, 'resources');
const mainIndex = path.join(desktopRoot, 'main/index.ts');

class FakeTray implements TrayInstance {
  contextMenu: unknown;
  tooltip: string | undefined;
  click: (() => void) | undefined;
  destroyed = false;

  constructor(readonly icon: string) {}

  setContextMenu(menu: unknown): void {
    this.contextMenu = menu;
  }

  setToolTip(tooltip: string): void {
    this.tooltip = tooltip;
  }

  on(event: 'click', listener: () => void): this {
    if (event === 'click') {
      this.click = listener;
    }
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function mockWindow(overrides: Partial<TrayWindow> = {}): TrayWindow {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    show: vi.fn(),
    hide: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    ...overrides,
  };
}

function createApis(trays: FakeTray[] = []): { apis: TrayApis; template: TrayMenuItem[] } {
  const template: TrayMenuItem[] = [];
  const apis: TrayApis = {
    Tray: class extends FakeTray {
      constructor(icon: string) {
        super(icon);
        trays.push(this);
      }
    },
    Menu: {
      buildFromTemplate(items) {
        template.splice(0, template.length, ...items);
        return { items };
      },
    },
  };
  return { apis, template };
}

function clickMenu(template: TrayMenuItem[], id: string): void {
  const item = template.find((entry) => entry.id === id);
  item?.click?.();
}

describe('close-to-tray preference', () => {
  it('hides only when hide-to-tray is on and the tray is alive', () => {
    expect(shouldHideInsteadOfClose({ closeToTray: true, trayActive: true })).toBe(true);
    expect(shouldHideInsteadOfClose({ closeToTray: true, trayActive: false })).toBe(false);
    expect(shouldHideInsteadOfClose({ closeToTray: false, trayActive: true })).toBe(false);
    expect(shouldHideInsteadOfClose({ closeToTray: false, trayActive: false })).toBe(false);
  });
});

describe('tray icon path', () => {
  it('uses ELEC-07 staged ico/png because yaqmc-tray is not in resources', () => {
    expect(existsSync(path.join(resourcesDir, 'yaqmc-tray.ico'))).toBe(false);
    expect(existsSync(path.join(resourcesDir, 'yaqmc-tray.png'))).toBe(false);
    expect(resolveTrayIconPath(resourcesDir, 'win32')).toBe(path.join(resourcesDir, 'icon.ico'));
    expect(resolveTrayIconPath(resourcesDir, 'linux')).toBe(path.join(resourcesDir, 'icon.png'));
    expect(resolveTrayIconPath(resourcesDir, 'darwin')).toBe(path.join(resourcesDir, 'icon.png'));
  });

  it('prefers yaqmc-tray when that name is present', () => {
    const exists = (filePath: string) => filePath.endsWith('yaqmc-tray.ico');
    expect(resolveTrayIconPath('/resources', 'win32', exists)).toBe(
      path.join('/resources', 'yaqmc-tray.ico'),
    );
  });
});

describe('createTray', () => {
  it('builds show/hide, play/pause, next, previous, settings, and quit', () => {
    const trays: FakeTray[] = [];
    const { apis, template } = createApis(trays);
    const invokePlayer = vi.fn();
    const openSettings = vi.fn();
    const quit = vi.fn();
    const window = mockWindow();

    const handle = createTray({
      apis,
      resourcesDir,
      platform: 'win32',
      getMainWindow: () => window,
      invokePlayer,
      openSettings,
      quit,
    });

    expect(handle.iconPath).toBe(path.join(resourcesDir, 'icon.ico'));
    expect(trays[0]?.icon).toBe(handle.iconPath);
    expect(trays[0]?.tooltip).toBe('YAQMC');
    expect(template.map((item) => item.id ?? item.type)).toEqual([
      'show-hide',
      'separator',
      'play-pause',
      'previous',
      'next',
      'separator',
      'settings',
      'separator',
      'quit',
    ]);

    clickMenu(template, 'play-pause');
    clickMenu(template, 'next');
    clickMenu(template, 'previous');
    expect(invokePlayer.mock.calls).toEqual([['toggle'], ['next'], ['previous']]);

    clickMenu(template, 'settings');
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(OPEN_SETTINGS_CHANNEL).toBe('app://open-settings');

    clickMenu(template, 'quit');
    expect(quit).toHaveBeenCalledTimes(1);

    handle.destroy();
    expect(trays[0]?.destroyed).toBe(true);
  });

  it('toggles the main window from the menu and left-click', () => {
    const trays: FakeTray[] = [];
    const { apis, template } = createApis(trays);
    const visible = { value: true };
    const window = mockWindow({
      isVisible: () => visible.value,
      hide: vi.fn(() => {
        visible.value = false;
      }),
      show: vi.fn(() => {
        visible.value = true;
      }),
    });

    createTray({
      apis,
      resourcesDir,
      platform: 'linux',
      getMainWindow: () => window,
      invokePlayer: vi.fn(),
      openSettings: vi.fn(),
      quit: vi.fn(),
    });

    clickMenu(template, 'show-hide');
    expect(window.hide).toHaveBeenCalledTimes(1);
    trays[0]?.click?.();
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('does not send IPC itself', () => {
    const source = readFileSync(path.join(desktopRoot, 'main/services/tray.ts'), 'utf8');
    expect(source).not.toMatch(/webContents\.send|ipcMain|ipcRenderer/);
  });
});

describe('toggleMainWindow', () => {
  it('hides a visible window and restores a minimized one', () => {
    const visible = mockWindow({ isVisible: () => true, isMinimized: () => false });
    toggleMainWindow(() => visible);
    expect(visible.hide).toHaveBeenCalledTimes(1);

    const minimized = mockWindow({ isVisible: () => false, isMinimized: () => true });
    toggleMainWindow(() => minimized);
    expect(minimized.restore).toHaveBeenCalledTimes(1);
    expect(minimized.show).toHaveBeenCalledTimes(1);
    expect(minimized.focus).toHaveBeenCalledTimes(1);
  });

  it('ignores a missing or destroyed window', () => {
    expect(() => toggleMainWindow(() => undefined)).not.toThrow();
    const destroyed = mockWindow({ isDestroyed: () => true });
    toggleMainWindow(() => destroyed);
    expect(destroyed.hide).not.toHaveBeenCalled();
    expect(destroyed.show).not.toHaveBeenCalled();
  });
});

describe('host boot wiring', () => {
  it('is imported from main/index.ts', () => {
    const source = readFileSync(mainIndex, 'utf8');
    expect(source).toContain("from './services/tray'");
    expect(source).toContain('createTray');
    expect(source).toContain('shouldHideInsteadOfClose');
  });
});
