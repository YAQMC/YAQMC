import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export type ProtectedAudioWindowFactory = (
  options: BrowserWindowConstructorOptions,
) => BrowserWindow;

export type ProtectedAudioDiagnostic = (message: string) => void;

export function parseProtectedAudioUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9_-]{32,128}\/player$/.test(url.pathname)
  ) {
    return null;
  }
  return url.toString();
}

/**
 * Owns the one hidden Chromium window used for provider-owned EME playback.
 * The window never appears in the taskbar and is destroyed when Core closes
 * the matching playback session.
 */
export class ProtectedAudioWindows {
  private current: { sessionId: number; window: BrowserWindow } | null = null;

  constructor(
    private readonly createWindow: ProtectedAudioWindowFactory,
    private readonly report: ProtectedAudioDiagnostic = () => {},
  ) {}

  open(sessionId: unknown, pageUrl: unknown): boolean {
    if (!Number.isSafeInteger(sessionId) || (sessionId as number) <= 0) {
      return false;
    }
    const normalized = parseProtectedAudioUrl(pageUrl);
    if (!normalized) {
      return false;
    }
    const id = sessionId as number;
    if (this.current?.sessionId === id && !this.current.window.isDestroyed()) {
      return true;
    }
    this.close();
    const window = this.createWindow({
      width: 1,
      height: 1,
      show: false,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        spellcheck: false,
        partition: 'yaqmc-protected-audio',
      },
    });
    this.current = { sessionId: id, window };
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame) {
        this.report(`protected audio page load failed session=${id} code=${errorCode}`);
      }
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      this.report(
        `protected audio renderer exited session=${id} reason=${safeDiagnosticToken(details.reason)} code=${details.exitCode}`,
      );
    });
    window.webContents.on('will-navigate', (event, target) => {
      if (target !== normalized) {
        event.preventDefault();
      }
    });
    window.on('closed', () => {
      if (this.current?.window === window) {
        this.current = null;
      }
    });
    this.report(`protected audio window opened session=${id}`);
    void window.loadURL(normalized).catch((error: unknown) => {
      const name = error instanceof Error ? error.name : 'unknown';
      this.report(
        `protected audio page load rejected session=${id} error=${safeDiagnosticToken(name)}`,
      );
    });
    return true;
  }

  close(sessionId?: unknown): void {
    if (sessionId !== undefined && sessionId !== this.current?.sessionId) {
      return;
    }
    const current = this.current;
    this.current = null;
    if (current && !current.window.isDestroyed()) {
      current.window.destroy();
    }
  }
}

function safeDiagnosticToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown';
}
