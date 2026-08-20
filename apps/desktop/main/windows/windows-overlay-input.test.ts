import { describe, expect, it, vi } from 'vitest';
import {
  applyLockedSurfaceInput,
  applyUnlockedSurfaceInput,
  applyUnlockOverlayInput,
  LYRICS_LOCKED_ALWAYS_ON_TOP_LEVEL,
  showOverlayInactive,
  type OverlayInputWindow,
} from './windows-overlay-input';

function mockWindow(): OverlayInputWindow & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    setIgnoreMouseEvents: vi.fn((ignore: boolean, options?: { forward: boolean }) => {
      order.push(
        options?.forward ? `ignore:${String(ignore)}:forward` : `ignore:${String(ignore)}`,
      );
    }),
    setFocusable: vi.fn((focusable: boolean) => {
      order.push(`focusable:${String(focusable)}`);
    }),
    setResizable: vi.fn(),
    setAlwaysOnTop: vi.fn((flag: boolean, level?: string) => {
      order.push(`alwaysOnTop:${String(flag)}:${level ?? ''}`);
    }),
    setSkipTaskbar: vi.fn((skip: boolean) => {
      order.push(`skipTaskbar:${String(skip)}`);
    }),
    moveTop: vi.fn(() => {
      order.push('moveTop');
    }),
    showInactive: vi.fn(),
    show: vi.fn(),
  };
}

describe('Windows overlay input', () => {
  it('locks with true click-through after restacking behind the taskbar', () => {
    const window = mockWindow();
    applyLockedSurfaceInput(window);
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, LYRICS_LOCKED_ALWAYS_ON_TOP_LEVEL);
    expect(window.setFocusable).toHaveBeenCalledWith(false);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalledWith(true, { forward: true });
    expect(window.order.indexOf('alwaysOnTop:true:floating')).toBeLessThan(
      window.order.indexOf('ignore:true'),
    );
    expect(window.order).not.toContain('ignore:true:forward');
  });

  it('unlocks by restoring mouse before restacking above the taskbar', () => {
    const window = mockWindow();
    applyLockedSurfaceInput(window);
    applyUnlockedSurfaceInput(window, true, 'screen-saver');
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(window.setFocusable).toHaveBeenCalledWith(true);
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true);
    expect(window.setResizable).toHaveBeenCalledWith(true);
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
  });

  it('makes the unlock pill clickable without forwarding mouse or showing on the taskbar', () => {
    const window = mockWindow();
    applyUnlockOverlayInput(window, 'screen-saver');
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(window.setFocusable).toHaveBeenCalledWith(true);
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true);
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
    expect(window.moveTop).toHaveBeenCalledTimes(1);
    expect(window.order.indexOf('focusable:true')).toBeLessThan(
      window.order.indexOf('skipTaskbar:true'),
    );
  });

  it('skips optional Electron APIs when absent', () => {
    const window: OverlayInputWindow = {
      setIgnoreMouseEvents: vi.fn(),
      setFocusable: vi.fn(),
    };
    applyLockedSurfaceInput(window);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    applyUnlockOverlayInput(window, 'screen-saver');
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
  });

  it('showOverlayInactive prefers showInactive', () => {
    const window = mockWindow();
    showOverlayInactive(window);
    expect(window.showInactive).toHaveBeenCalledTimes(1);
    expect(window.show).not.toHaveBeenCalled();
  });
});
