import { describe, expect, it, vi } from 'vitest';
import {
  createGlobalShortcutSession,
  FACT_SHORTCUT_ACCELERATORS,
  registerGlobalShortcuts,
  SHORTCUT_BINDINGS,
  shouldRegisterGlobalShortcuts,
  toElectronAccelerator,
  unregisterGlobalShortcuts,
  WAYLAND_SHORTCUTS_UNSUPPORTED,
  type GlobalShortcutApi,
} from './shortcuts';

function mockGlobalShortcut(
  registerImpl?: GlobalShortcutApi['register'],
): GlobalShortcutApi & { callbacks: Map<string, () => void> } {
  const callbacks = new Map<string, () => void>();
  return {
    callbacks,
    register: vi.fn((accelerator, callback) => {
      if (registerImpl) {
        return registerImpl(accelerator, callback);
      }
      callbacks.set(accelerator, callback);
      return true;
    }),
    unregisterAll: vi.fn(() => {
      callbacks.clear();
    }),
  };
}

describe('FACT accelerators', () => {
  it('keeps the canonical play-pause, previous, and next accelerators', () => {
    expect(FACT_SHORTCUT_ACCELERATORS).toEqual([
      'control+alt+Space',
      'control+alt+ArrowLeft',
      'control+alt+ArrowRight',
    ]);
  });

  it('maps FACT strings onto Electron accelerators', () => {
    expect(toElectronAccelerator('control+alt+Space')).toBe('Control+Alt+Space');
    expect(toElectronAccelerator('control+alt+ArrowLeft')).toBe('Control+Alt+Left');
    expect(toElectronAccelerator('control+alt+ArrowRight')).toBe('Control+Alt+Right');
    expect(SHORTCUT_BINDINGS.map((binding) => binding.action)).toEqual([
      'toggle',
      'previous',
      'next',
    ]);
  });
});

describe('shouldRegisterGlobalShortcuts', () => {
  it('is false on native Wayland and true elsewhere', () => {
    expect(shouldRegisterGlobalShortcuts({ platform: 'linux', wayland: true })).toBe(false);
    expect(shouldRegisterGlobalShortcuts({ platform: 'linux', wayland: false })).toBe(true);
    expect(shouldRegisterGlobalShortcuts({ platform: 'win32', wayland: true })).toBe(true);
    expect(shouldRegisterGlobalShortcuts({ platform: 'darwin', wayland: false })).toBe(true);
  });
});

describe('registerGlobalShortcuts', () => {
  it('registers the three play-pause/next/prev bindings and invokes the player stub', () => {
    const shortcuts = mockGlobalShortcut();
    const invokePlayer = vi.fn();
    const result = registerGlobalShortcuts({
      globalShortcut: shortcuts,
      invokePlayer,
      platform: 'win32',
      wayland: false,
    });
    expect(result.registered).toEqual([...FACT_SHORTCUT_ACCELERATORS]);
    expect(result.failed).toEqual([]);
    expect([...shortcuts.callbacks.keys()]).toEqual([
      'Control+Alt+Space',
      'Control+Alt+Left',
      'Control+Alt+Right',
    ]);

    shortcuts.callbacks.get('Control+Alt+Space')?.();
    shortcuts.callbacks.get('Control+Alt+Right')?.();
    shortcuts.callbacks.get('Control+Alt+Left')?.();
    expect(invokePlayer.mock.calls).toEqual([['toggle'], ['next'], ['previous']]);
  });

  it('logs registration failure and does not throw', () => {
    const log = { warn: vi.fn() };
    const shortcuts = mockGlobalShortcut((accelerator) => accelerator !== 'Control+Alt+Left');
    expect(() =>
      registerGlobalShortcuts({
        globalShortcut: shortcuts,
        invokePlayer: vi.fn(),
        log,
      }),
    ).not.toThrow();
    const result = registerGlobalShortcuts({
      globalShortcut: mockGlobalShortcut(() => {
        throw new Error('already taken');
      }),
      invokePlayer: vi.fn(),
      log,
    });
    expect(result.registered).toEqual([]);
    expect(result.failed).toEqual([...FACT_SHORTCUT_ACCELERATORS]);
    expect(log.warn).toHaveBeenCalled();
    expect(
      log.warn.mock.calls.some((call) => String(call[0]).includes('shortcut conflict')),
    ).toBe(true);
  });

  it('skips registration on native Wayland', () => {
    const shortcuts = mockGlobalShortcut();
    const result = registerGlobalShortcuts({
      globalShortcut: shortcuts,
      invokePlayer: vi.fn(),
      platform: 'linux',
      wayland: true,
    });
    expect(result.registered).toEqual([]);
    expect(shortcuts.callbacks.size).toBe(0);
  });

  it('unregisters through the injected API', () => {
    const shortcuts = mockGlobalShortcut();
    registerGlobalShortcuts({ globalShortcut: shortcuts, invokePlayer: vi.fn() });
    unregisterGlobalShortcuts(shortcuts);
    expect(shortcuts.unregisterAll).toHaveBeenCalledTimes(1);
  });

  it('does not append Chromium switches', () => {
    const source = readFileSync(path.join(desktopRoot, 'main/services/shortcuts.ts'), 'utf8');
    expect(source).not.toContain('appendSwitch');
    expect(source).not.toMatch(/app\.commandLine/);
  });
});

describe('createGlobalShortcutSession', () => {
  it('allows Windows to enable all three FACT accelerators', () => {
    const shortcuts = mockGlobalShortcut();
    const session = createGlobalShortcutSession({
      globalShortcut: shortcuts,
      invokePlayer: vi.fn(),
      platform: () => 'win32',
      wayland: () => true,
    });
    const status = session.setEnabled(true);
    expect(status.globalShortcutsSupported).toBe(true);
    expect(status.globalShortcutsEnabled).toBe(true);
    expect(status.registered).toEqual([...FACT_SHORTCUT_ACCELERATORS]);
    expect(status.failed).toEqual([]);
    expect(status.shortcutError).toBeNull();
    expect([...shortcuts.callbacks.keys()]).toEqual([
      'Control+Alt+Space',
      'Control+Alt+Left',
      'Control+Alt+Right',
    ]);
  });

  it('keeps the feature enabled when one accelerator conflicts', () => {
    const log = { warn: vi.fn() };
    const session = createGlobalShortcutSession({
      globalShortcut: mockGlobalShortcut((accelerator) => accelerator !== 'Control+Alt+Left'),
      invokePlayer: vi.fn(),
      platform: () => 'win32',
      wayland: () => false,
      log,
    });
    const status = session.setEnabled(true);
    expect(status.globalShortcutsEnabled).toBe(true);
    expect(status.registered).toEqual(['control+alt+Space', 'control+alt+ArrowRight']);
    expect(status.failed).toEqual(['control+alt+ArrowLeft']);
    expect(status.shortcutError).toBe('shortcut conflict for control+alt+ArrowLeft');
    expect(log.warn).toHaveBeenCalled();
  });

  it('does not fake success when every register() fails', () => {
    const session = createGlobalShortcutSession({
      globalShortcut: mockGlobalShortcut(() => false),
      invokePlayer: vi.fn(),
      platform: () => 'win32',
      wayland: () => false,
    });
    expect(() => session.setEnabled(true)).toThrow(/shortcut conflict/);
    expect(session.status().globalShortcutsEnabled).toBe(false);
    expect(session.status().shortcutError).toContain('shortcut conflict');
  });

  it('refuses native Wayland enable without registering Chromium shortcuts', () => {
    const shortcuts = mockGlobalShortcut();
    const session = createGlobalShortcutSession({
      globalShortcut: shortcuts,
      invokePlayer: vi.fn(),
      platform: () => 'linux',
      wayland: () => true,
    });
    expect(() => session.setEnabled(true)).toThrow(WAYLAND_SHORTCUTS_UNSUPPORTED);
    expect(session.status().globalShortcutsSupported).toBe(false);
    expect(session.status().globalShortcutsEnabled).toBe(false);
    expect(session.status().shortcutError).toBe(WAYLAND_SHORTCUTS_UNSUPPORTED);
    expect(shortcuts.callbacks.size).toBe(0);
    expect(session.setEnabled(false).globalShortcutsEnabled).toBe(false);
  });

  it('unregisters before a later enable so boot leftovers are not conflicts', () => {
    const shortcuts = mockGlobalShortcut();
    const session = createGlobalShortcutSession({
      globalShortcut: shortcuts,
      invokePlayer: vi.fn(),
      platform: () => 'win32',
      wayland: () => false,
    });
    session.setEnabled(true);
    session.setEnabled(true);
    expect(shortcuts.unregisterAll).toHaveBeenCalledTimes(2);
    expect(session.status().registered).toEqual([...FACT_SHORTCUT_ACCELERATORS]);
  });

  it('applies a persisted preference only when the enabled flag changes', () => {
    const shortcuts = mockGlobalShortcut();
    const session = createGlobalShortcutSession({
      globalShortcut: shortcuts,
      invokePlayer: vi.fn(),
      platform: () => 'win32',
      wayland: () => false,
    });
    session.applyPreference(false);
    expect(shortcuts.register).not.toHaveBeenCalled();
    session.applyPreference(true);
    expect(session.status().globalShortcutsEnabled).toBe(true);
    session.applyPreference(true);
    expect(shortcuts.unregisterAll).toHaveBeenCalledTimes(1);
    session.applyPreference(false);
    expect(session.status().globalShortcutsEnabled).toBe(false);
  });

  it('does not throw from applyPreference when registration fails at boot', () => {
    const session = createGlobalShortcutSession({
      globalShortcut: mockGlobalShortcut(() => false),
      invokePlayer: vi.fn(),
      platform: () => 'win32',
      wayland: () => false,
    });
    expect(() => session.applyPreference(true)).not.toThrow();
    expect(session.status().globalShortcutsEnabled).toBe(false);
  });
});

describe('host boot wiring', () => {
  it('is imported from main/index.ts', () => {
    const source = readFileSync(path.join(desktopRoot, 'main/index.ts'), 'utf8');
    expect(source).toContain("from './services/shortcuts'");
    expect(source).toContain('createGlobalShortcutSession');
    expect(source).toContain('applyShortcutsFromPreferences');
    expect(source).not.toMatch(/registerGlobalShortcuts\(\{/);
  });
});
