import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FRAME_HARD_CAP_BYTES, type OAuthPrepareResult } from '@yaqmc/client';
import {
  isOAuthCallbackUrl,
  oauthPartitionName,
  oauthWindowCreateOptions,
  oauthWindowLabel,
  oauthWindowTitle,
  openOAuthWindow,
  urlMatchesOAuthAllowlist,
  type OAuthNavigationEvent,
  type OAuthWindowCreateOptions,
  type OAuthWindowDeps,
  type OAuthWindowLike,
} from './oauth-window';

const CALLBACK_PREFIX = 'https://y.qq.com/portal/wx_redirect.html';
const AUTH_URL = 'https://graph.qq.com/oauth2.0/show?client_id=1';
const PREPARED: OAuthPrepareResult = {
  attemptId: 'attempt-0',
  url: AUTH_URL,
  navigationAllowlist: [
    'https://graph.qq.com/**',
    'https://xui.ptlogin2.qq.com/**',
    `${CALLBACK_PREFIX}**`,
  ],
  callbackMatcher: { urlPrefix: CALLBACK_PREFIX },
};

type MockOAuthWindow = OAuthWindowLike & {
  emitNavigate(url: string): { preventDefault: ReturnType<typeof vi.fn> };
  emitRedirect(url: string): { preventDefault: ReturnType<typeof vi.fn> };
  emitClosed(): void;
};

function mockWindow(): MockOAuthWindow {
  const contentsListeners: Record<
    'will-navigate' | 'will-redirect',
    Array<(event: OAuthNavigationEvent, url: string) => void>
  > = {
    'will-navigate': [],
    'will-redirect': [],
  };
  const closedListeners: Array<() => void> = [];

  const emit = (
    event: 'will-navigate' | 'will-redirect',
    url: string,
  ): { preventDefault: ReturnType<typeof vi.fn> } => {
    const preventDefault = vi.fn();
    for (const listener of contentsListeners[event]) {
      listener({ preventDefault }, url);
    }
    return { preventDefault };
  };

  const window: MockOAuthWindow = {
    webContents: {
      on: vi.fn((event, listener) => {
        contentsListeners[event].push(listener);
      }),
      setWindowOpenHandler: vi.fn(),
    },
    loadURL: vi.fn(),
    close: vi.fn(() => {
      window.emitClosed();
    }),
    on: vi.fn((event, listener) => {
      if (event === 'closed') {
        closedListeners.push(listener);
      }
    }),
    emitNavigate: (url) => emit('will-navigate', url),
    emitRedirect: (url) => emit('will-redirect', url),
    emitClosed: () => {
      for (const listener of closedListeners.splice(0)) {
        listener();
      }
    },
  };
  return window;
}

function depsFor(
  window: MockOAuthWindow,
  overrides: Partial<OAuthWindowDeps> = {},
): {
  deps: OAuthWindowDeps;
  createWindow: ReturnType<typeof vi.fn>;
  fromPartition: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  options: () => OAuthWindowCreateOptions;
} {
  const session = { partition: 'mock-oauth-session' };
  let captured: OAuthWindowCreateOptions | undefined;
  const createWindow = vi.fn((options: OAuthWindowCreateOptions) => {
    captured = options;
    return window;
  });
  const fromPartition = vi.fn(() => session);
  const prepare = vi.fn(async () => PREPARED);
  const complete = vi.fn(async () => ({ ok: true }));
  const cancel = vi.fn(async () => ({ ok: true }));
  return {
    createWindow,
    fromPartition,
    prepare,
    complete,
    cancel,
    options: () => {
      if (!captured) {
        throw new Error('createWindow was not called');
      }
      return captured;
    },
    deps: {
      createWindow,
      fromPartition,
      isPackaged: true,
      auth_oauth_prepare: prepare,
      auth_oauth_complete: complete,
      auth_oauth_cancel: cancel,
      ...overrides,
    },
  };
}

describe('oauth partition and construction', () => {
  it('uses an ephemeral oauth: partition, no preload, and 480×640', async () => {
    const window = mockWindow();
    const harness = depsFor(window);
    await openOAuthWindow('qq', harness.deps);

    expect(harness.prepare).toHaveBeenCalledWith({ providerKind: 'qq' });
    expect(harness.fromPartition).toHaveBeenCalledWith('oauth:attempt-0', { cache: false });
    expect(oauthPartitionName('attempt-0').startsWith('persist:')).toBe(false);
    expect(oauthWindowLabel('attempt-0')).toBe('qqmusic-oauth-attempt-0');

    const options = harness.options();
    expect(options).toMatchObject({
      title: oauthWindowTitle('qq'),
      width: 480,
      height: 640,
      show: true,
    });
    expect(options.webPreferences).toEqual({
      session: { partition: 'mock-oauth-session' },
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: false,
    });
    expect(options.webPreferences).not.toHaveProperty('preload');
    expect(window.loadURL).toHaveBeenCalledWith(AUTH_URL);
    expect(window.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
  });

  it('disables devtools only when packaged', () => {
    const packaged = oauthWindowCreateOptions({
      title: 't',
      session: {},
      isPackaged: true,
    });
    const unpackaged = oauthWindowCreateOptions({
      title: 't',
      session: {},
      isPackaged: false,
    });
    expect(packaged.webPreferences.devTools).toBe(false);
    expect(unpackaged.webPreferences.devTools).toBe(true);
    expect(packaged.webPreferences).not.toHaveProperty('preload');
  });
});

describe('oauth allowlist globs', () => {
  const allowlist = PREPARED.navigationAllowlist;

  it('allows prepare-host /** globs and denies everything else', () => {
    expect(urlMatchesOAuthAllowlist(AUTH_URL, allowlist)).toBe(true);
    expect(urlMatchesOAuthAllowlist('https://xui.ptlogin2.qq.com/cgi-bin/xlogin', allowlist)).toBe(
      true,
    );
    expect(
      urlMatchesOAuthAllowlist('https://graph.qq.com.evil.example/oauth2.0/show', allowlist),
    ).toBe(false);
    expect(urlMatchesOAuthAllowlist('http://graph.qq.com/oauth2.0/show', allowlist)).toBe(false);
    expect(urlMatchesOAuthAllowlist('https://evil.test/', allowlist)).toBe(false);
    expect(urlMatchesOAuthAllowlist('file:///etc/passwd', allowlist)).toBe(false);
    expect(urlMatchesOAuthAllowlist('javascript:alert(1)', allowlist)).toBe(false);
  });

  it('treats callbackMatcher.urlPrefix as the capture signal', () => {
    const callback = `${CALLBACK_PREFIX}?code=abc&state=1`;
    expect(isOAuthCallbackUrl(callback, CALLBACK_PREFIX)).toBe(true);
    expect(isOAuthCallbackUrl('https://evil.test/?next=' + CALLBACK_PREFIX, CALLBACK_PREFIX)).toBe(
      false,
    );
    expect(urlMatchesOAuthAllowlist(callback, allowlist)).toBe(true);
  });
});

describe('oauth navigation and lifecycle', () => {
  it('denies navigation off the prepare allowlist', async () => {
    const window = mockWindow();
    const harness = depsFor(window);
    await openOAuthWindow('qq', harness.deps);

    const allowed = window.emitNavigate(AUTH_URL);
    expect(allowed.preventDefault).not.toHaveBeenCalled();

    const denied = window.emitNavigate('https://evil.test/phish');
    expect(denied.preventDefault).toHaveBeenCalledOnce();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('captures will-navigate and will-redirect callback URLs via auth_oauth_complete', async () => {
    const window = mockWindow();
    const harness = depsFor(window);
    await openOAuthWindow('wechat', harness.deps);
    expect(harness.prepare).toHaveBeenCalledWith({ providerKind: 'wechat' });

    const callback = `${CALLBACK_PREFIX}?code=from-navigate`;
    const blocked = window.emitNavigate(callback);
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(harness.complete).toHaveBeenCalledWith({
        attemptId: 'attempt-0',
        callbackUrl: callback,
      });
    });
    expect(window.close).toHaveBeenCalledOnce();
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('captures a will-redirect callback without a second complete', async () => {
    const window = mockWindow();
    const harness = depsFor(window);
    await openOAuthWindow('qq', harness.deps);

    const callback = `${CALLBACK_PREFIX}?code=from-redirect`;
    window.emitRedirect(callback);
    await vi.waitFor(() => {
      expect(harness.complete).toHaveBeenCalledTimes(1);
    });
    window.emitNavigate(callback);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('calls auth_oauth_cancel when the user closes the window', async () => {
    const window = mockWindow();
    const harness = depsFor(window);
    await openOAuthWindow('qq', harness.deps);

    window.emitClosed();
    await vi.waitFor(() => {
      expect(harness.cancel).toHaveBeenCalledWith({ attemptId: 'attempt-0' });
    });
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it('does not cancel after a callback capture even if closed fires', async () => {
    const window = mockWindow();
    let finishComplete: (() => void) | undefined;
    const complete = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finishComplete = () => resolve({ ok: true });
        }),
    );
    const harness = depsFor(window, { auth_oauth_complete: complete });
    await openOAuthWindow('qq', harness.deps);

    window.emitNavigate(`${CALLBACK_PREFIX}?code=pending`);
    expect(complete).toHaveBeenCalledOnce();
    window.emitClosed();
    expect(harness.cancel).not.toHaveBeenCalled();
    finishComplete?.();
    await vi.waitFor(() => {
      expect(window.close).toHaveBeenCalledOnce();
    });
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('cancels the attempt when window construction fails', async () => {
    const window = mockWindow();
    const harness = depsFor(window, {
      createWindow: () => {
        throw new Error('no display');
      },
    });
    await expect(openOAuthWindow('qq', harness.deps)).rejects.toThrow('no display');
    expect(harness.cancel).toHaveBeenCalledWith({ attemptId: 'attempt-0' });
    expect(harness.complete).not.toHaveBeenCalled();
  });
});

describe('wired status', () => {
  it('is not auto-opened from Main index.ts', () => {
    const index = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.ts'),
      'utf8',
    );
    expect(index).toContain('session.fromPartition');
    expect(index).toContain('createOAuthBrowserWindow');
    expect(index).not.toContain('openOAuthWindow');
  });

  it('does not attach a preload or scrape console-message', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./oauth-window.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('No preload');
    expect(source).not.toContain('preload:');
    expect(source).not.toContain('console-message');
  });
});

describe('protocol cap', () => {
  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
