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
  unregister?(accelerator: string): void;
  isRegistered?(accelerator: string): boolean;
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
  for (const binding of SHORTCUT_BINDINGS) {
    if (globalShortcut.isRegistered?.(binding.accelerator)) {
      globalShortcut.unregister?.(binding.accelerator);
    }
  }
  globalShortcut.unregisterAll();
}

/** Matches `src-tauri/src/desktop_integration.rs` native-Wayland enable error. */
export const WAYLAND_SHORTCUTS_UNSUPPORTED =
  'configurable global shortcuts are unavailable on the active native Wayland backend; use MPRIS media keys';

export type ShortcutSessionStatus = {
  globalShortcutsSupported: boolean;
  globalShortcutsEnabled: boolean;
  globalShortcuts: string[];
  shortcutError: string | null;
  registered: string[];
  failed: string[];
};

export type GlobalShortcutSession = {
  setEnabled(enabled: boolean): ShortcutSessionStatus;
  applyPreference(enabled: boolean): ShortcutSessionStatus;
  status(): ShortcutSessionStatus;
  dispose(): void;
};

function conflictMessage(failed: readonly string[]): string {
  return `shortcut conflict for ${failed.join(', ')}`;
}

/**
 * Owns Electron `globalShortcut` lifecycle. Callers must unregister-then-register
 * through this session so a later enable is not reported as a conflict against
 * a boot-time registration.
 */
export function createGlobalShortcutSession(options: {
  globalShortcut: GlobalShortcutApi;
  invokePlayer: (method: ShortcutAction) => void | Promise<void>;
  platform: () => NodeJS.Platform | string;
  wayland: () => boolean;
  log?: ShortcutLogger;
}): GlobalShortcutSession {
  let appliedEnabled = false;
  let last: ShortcutSessionStatus = {
    globalShortcutsSupported: false,
    globalShortcutsEnabled: false,
    globalShortcuts: [...FACT_SHORTCUT_ACCELERATORS],
    shortcutError: null,
    registered: [],
    failed: [],
  };

  const supported = (): boolean =>
    shouldRegisterGlobalShortcuts({
      platform: options.platform(),
      wayland: options.wayland(),
    });

  const snapshot = (
    partial: Pick<ShortcutSessionStatus, 'globalShortcutsEnabled' | 'shortcutError'> &
      Partial<Pick<ShortcutSessionStatus, 'registered' | 'failed'>>,
  ): ShortcutSessionStatus => {
    last = {
      globalShortcutsSupported: supported(),
      globalShortcutsEnabled: partial.globalShortcutsEnabled,
      globalShortcuts: [...FACT_SHORTCUT_ACCELERATORS],
      shortcutError: partial.shortcutError,
      registered: partial.registered ?? last.registered,
      failed: partial.failed ?? last.failed,
    };
    return last;
  };

  const setEnabled = (enabled: boolean): ShortcutSessionStatus => {
    unregisterGlobalShortcuts(options.globalShortcut);
    appliedEnabled = false;

    if (!supported()) {
      const status = snapshot({
        globalShortcutsEnabled: false,
        shortcutError: enabled ? WAYLAND_SHORTCUTS_UNSUPPORTED : null,
        registered: [],
        failed: [],
      });
      if (enabled) {
        throw new Error(WAYLAND_SHORTCUTS_UNSUPPORTED);
      }
      return status;
    }

    if (!enabled) {
      return snapshot({
        globalShortcutsEnabled: false,
        shortcutError: null,
        registered: [],
        failed: [],
      });
    }

    const result = registerGlobalShortcuts({
      globalShortcut: options.globalShortcut,
      invokePlayer: options.invokePlayer,
      platform: options.platform(),
      wayland: options.wayland(),
      log: options.log,
    });
    const error = result.failed.length > 0 ? conflictMessage(result.failed) : null;
    if (result.registered.length === 0) {
      snapshot({
        globalShortcutsEnabled: false,
        shortcutError: error ?? 'globalShortcut.register() failed',
        registered: [],
        failed: result.failed,
      });
      throw new Error(last.shortcutError ?? 'globalShortcut.register() failed');
    }
    appliedEnabled = true;
    return snapshot({
      globalShortcutsEnabled: true,
      shortcutError: error,
      registered: result.registered,
      failed: result.failed,
    });
  };

  return {
    setEnabled,
    applyPreference(enabled: boolean): ShortcutSessionStatus {
      if (enabled === appliedEnabled) {
        return {
          ...last,
          globalShortcutsSupported: supported(),
        };
      }
      try {
        return setEnabled(enabled);
      } catch (error) {
        options.log?.warn('shortcut preference apply failed', { error: String(error) });
        return last;
      }
    },
    status(): ShortcutSessionStatus {
      return {
        ...last,
        globalShortcutsSupported: supported(),
      };
    },
    dispose(): void {
      unregisterGlobalShortcuts(options.globalShortcut);
      appliedEnabled = false;
      snapshot({
        globalShortcutsEnabled: false,
        shortcutError: null,
        registered: [],
        failed: [],
      });
    },
  };
}
