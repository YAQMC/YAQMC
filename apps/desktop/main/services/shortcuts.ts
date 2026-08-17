/**
 * FACT accelerators from `src-tauri/src/desktop_integration.rs` `SHORTCUTS`:
 * play-pause, previous, next. Not user-configurable.
 */
export const FACT_SHORTCUT_ACCELERATORS = [
  'control+alt+Space',
  'control+alt+ArrowLeft',
  'control+alt+ArrowRight',
] as const;

export type ShortcutAction = 'toggle' | 'previous' | 'next';

export type ShortcutBinding = {
  fact: (typeof FACT_SHORTCUT_ACCELERATORS)[number];
  accelerator: string;
  action: ShortcutAction;
};

/**
 * Map Tauri/FACT accelerator strings onto Electron's Accelerator grammar
 * (`Control+Alt+Space`, `Left` / `Right` rather than `ArrowLeft` / `ArrowRight`).
 */
export function toElectronAccelerator(fact: string): string {
  return fact
    .split('+')
    .map((token) => {
      if (token === 'control') {
        return 'Control';
      }
      if (token === 'alt') {
        return 'Alt';
      }
      if (token === 'ArrowLeft') {
        return 'Left';
      }
      if (token === 'ArrowRight') {
        return 'Right';
      }
      return token;
    })
    .join('+');
}

export const SHORTCUT_BINDINGS: readonly ShortcutBinding[] = [
  {
    fact: 'control+alt+Space',
    accelerator: toElectronAccelerator('control+alt+Space'),
    action: 'toggle',
  },
  {
    fact: 'control+alt+ArrowLeft',
    accelerator: toElectronAccelerator('control+alt+ArrowLeft'),
    action: 'previous',
  },
  {
    fact: 'control+alt+ArrowRight',
    accelerator: toElectronAccelerator('control+alt+ArrowRight'),
    action: 'next',
  },
];

export type GlobalShortcutApi = {
  register(accelerator: string, callback: () => void): boolean;
  unregisterAll(): void;
};

export type ShortcutLogger = {
  warn(message: string, extra?: Record<string, unknown>): void;
};

export type RegisterShortcutsOptions = {
  globalShortcut: GlobalShortcutApi;
  invokePlayer: (method: ShortcutAction) => void | Promise<void>;
  platform?: NodeJS.Platform | string;
  wayland?: boolean;
  log?: ShortcutLogger;
};

export type ShortcutRegistration = {
  registered: string[];
  failed: string[];
};

/**
 * Native Wayland cannot use Chromium `globalShortcut` (parity with
 * `global_shortcuts_supported` in `desktop_integration.rs`, which is false
 * when the window backend is `wayland-native`). XWayland / X11 / Windows
 * still register. Callers pass the already-detected native-Wayland flag;
 * this module never registers Chromium switches.
 */
export function shouldRegisterGlobalShortcuts(options: {
  platform: NodeJS.Platform | string;
  wayland: boolean;
}): boolean {
  return !(options.platform === 'linux' && options.wayland);
}

export function registerGlobalShortcuts(
  options: RegisterShortcutsOptions,
): ShortcutRegistration {
  const registered: string[] = [];
  const failed: string[] = [];
  const platform = options.platform ?? process.platform;
  const wayland = options.wayland ?? false;

  if (!shouldRegisterGlobalShortcuts({ platform, wayland })) {
    return { registered, failed };
  }

  for (const binding of SHORTCUT_BINDINGS) {
    try {
      const ok = options.globalShortcut.register(binding.accelerator, () => {
        void Promise.resolve(options.invokePlayer(binding.action)).catch((error: unknown) => {
          options.log?.warn('shortcut command rejected', {
            shortcut: binding.fact,
            error: String(error),
          });
        });
      });
      if (!ok) {
        failed.push(binding.fact);
        options.log?.warn(`shortcut conflict for ${binding.fact}`, {
          accelerator: binding.accelerator,
        });
        continue;
      }
      registered.push(binding.fact);
    } catch (error) {
      failed.push(binding.fact);
      options.log?.warn(`shortcut conflict for ${binding.fact}: ${String(error)}`, {
        accelerator: binding.accelerator,
      });
    }
  }

  return { registered, failed };
}

export function unregisterGlobalShortcuts(globalShortcut: GlobalShortcutApi): void {
  globalShortcut.unregisterAll();
}
