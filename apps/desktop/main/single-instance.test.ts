import { describe, expect, it, vi } from 'vitest';
import { acquireSingleInstanceLock, type MainWindowLike, type SingleInstanceApp } from './single-instance';

function mockWindow(overrides: Partial<MainWindowLike> = {}): MainWindowLike {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides,
  };
}

describe('single instance lock', () => {
  it('quits immediately when the lock is already held', () => {
    const electronApp: SingleInstanceApp = {
      requestSingleInstanceLock: () => false,
      quit: vi.fn(),
      on: vi.fn(),
    };
    expect(acquireSingleInstanceLock(electronApp, () => undefined)).toBe(false);
    expect(electronApp.quit).toHaveBeenCalledTimes(1);
    expect(electronApp.on).not.toHaveBeenCalled();
  });

  it('focuses, restores, and shows the main window on a second launch', () => {
    let secondInstance: (() => void) | undefined;
    const electronApp: SingleInstanceApp = {
      requestSingleInstanceLock: () => true,
      quit: vi.fn(),
      on: (_event, listener) => {
        secondInstance = listener;
      },
    };
    const window = mockWindow({ isMinimized: () => true });
    expect(acquireSingleInstanceLock(electronApp, () => window)).toBe(true);
    expect(electronApp.quit).not.toHaveBeenCalled();
    secondInstance?.();
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('ignores a second launch when the main window is gone', () => {
    let secondInstance: (() => void) | undefined;
    const electronApp: SingleInstanceApp = {
      requestSingleInstanceLock: () => true,
      quit: vi.fn(),
      on: (_event, listener) => {
        secondInstance = listener;
      },
    };
    expect(acquireSingleInstanceLock(electronApp, () => undefined)).toBe(true);
    expect(() => secondInstance?.()).not.toThrow();
  });
});
