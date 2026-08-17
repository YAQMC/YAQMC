import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  FACT_SHORTCUT_ACCELERATORS,
  registerGlobalShortcuts,
  SHORTCUT_BINDINGS,
  shouldRegisterGlobalShortcuts,
  toElectronAccelerator,
  unregisterGlobalShortcuts,
  type GlobalShortcutApi,
} from './shortcuts';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rustSource = path.resolve(
  desktopRoot,
  '../../src-tauri/src/desktop_integration.rs',
);

function mockGlobalShortcut(
  registerImpl?: GlobalShortcutApi['register'],
): GlobalShortcutApi & { callbacks: Map<string, () => void> } {
  const callbacks = new Map<string, () => void>();
  return {
    callbacks,
    register: (accelerator, callback) => {
      if (registerImpl) {
        return registerImpl(accelerator, callback);
      }
      callbacks.set(accelerator, callback);
      return true;
    },
    unregisterAll: vi.fn(() => {
      callbacks.clear();
    }),
  };
}

describe('FACT accelerators', () => {
  it('matches desktop_integration.rs SHORTCUTS exactly', () => {
    expect(FACT_SHORTCUT_ACCELERATORS).toEqual([
      'control+alt+Space',
      'control+alt+ArrowLeft',
      'control+alt+ArrowRight',
    ]);
    const rust = readFileSync(rustSource, 'utf8');
    for (const fact of FACT_SHORTCUT_ACCELERATORS) {
      expect(rust).toContain(`"${fact}"`);
    }
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

describe('host boot wiring', () => {
  it('is imported from main/index.ts', () => {
    const source = readFileSync(path.join(desktopRoot, 'main/index.ts'), 'utf8');
    expect(source).toContain("from './services/shortcuts'");
    expect(source).toContain('registerGlobalShortcuts');
  });
});
