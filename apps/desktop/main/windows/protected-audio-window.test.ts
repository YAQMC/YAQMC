import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { ProtectedAudioWindows, parseProtectedAudioUrl } from './protected-audio-window';

const TOKEN = 'a'.repeat(43);
const PAGE_URL = `http://127.0.0.1:43123/${TOKEN}/player`;

function fakeWindow(options: BrowserWindowConstructorOptions) {
  let destroyed = false;
  const window = {
    options,
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    },
    loadURL: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
  };
  return window as unknown as BrowserWindow & typeof window;
}

describe('protected audio window', () => {
  it('accepts only the loopback player shape', () => {
    expect(parseProtectedAudioUrl(PAGE_URL)).toBe(PAGE_URL);
    expect(parseProtectedAudioUrl(`https://127.0.0.1:43123/${TOKEN}/player`)).toBeNull();
    expect(parseProtectedAudioUrl(`http://localhost:43123/${TOKEN}/player`)).toBeNull();
    expect(parseProtectedAudioUrl(`http://127.0.0.1:43123/${TOKEN}/player?secret=1`)).toBeNull();
    expect(parseProtectedAudioUrl(`http://127.0.0.1:43123/player`)).toBeNull();
  });

  it('creates one hidden sandboxed window and closes it by session', () => {
    const windows: ReturnType<typeof fakeWindow>[] = [];
    const report = vi.fn();
    const createWindow = vi.fn((options: BrowserWindowConstructorOptions) => {
      const window = fakeWindow(options);
      windows.push(window);
      return window;
    });
    const owner = new ProtectedAudioWindows(createWindow, report);

    expect(owner.open(7, PAGE_URL)).toBe(true);
    expect(owner.open(7, PAGE_URL)).toBe(true);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(windows[0].options).toMatchObject({
      show: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    expect(windows[0].loadURL).toHaveBeenCalledWith(PAGE_URL);
    expect(report).toHaveBeenCalledWith('protected audio window opened session=7');

    owner.close(8);
    expect(windows[0].destroy).not.toHaveBeenCalled();
    owner.close(7);
    expect(windows[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('logs load and renderer failures without the private loopback URL', () => {
    const windows: ReturnType<typeof fakeWindow>[] = [];
    const reports: string[] = [];
    const owner = new ProtectedAudioWindows(
      (options) => {
        const window = fakeWindow(options);
        windows.push(window);
        return window;
      },
      (message) => reports.push(message),
    );
    owner.open(9, PAGE_URL);
    const handlers = windows[0].webContents.on.mock.calls;
    const didFailLoad = handlers.find(([event]) => event === 'did-fail-load')?.[1];
    const rendererGone = handlers.find(([event]) => event === 'render-process-gone')?.[1];
    expect(didFailLoad).toBeTypeOf('function');
    expect(rendererGone).toBeTypeOf('function');
    didFailLoad?.({}, -105, 'ERR_NAME_NOT_RESOLVED', PAGE_URL, true);
    rendererGone?.({}, { reason: 'crashed', exitCode: 1 });
    expect(reports).toContain('protected audio page load failed session=9 code=-105');
    expect(reports).toContain('protected audio renderer exited session=9 reason=crashed code=1');
    expect(reports.join('\n')).not.toContain(TOKEN);
  });

  it('rejects arbitrary URLs and malformed session ids', () => {
    const createWindow = vi.fn();
    const owner = new ProtectedAudioWindows(createWindow);
    expect(owner.open(1, 'https://open.spotify.com/')).toBe(false);
    expect(owner.open(0, PAGE_URL)).toBe(false);
    expect(owner.open(Number.NaN, PAGE_URL)).toBe(false);
    expect(createWindow).not.toHaveBeenCalled();
  });
});
