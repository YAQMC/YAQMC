import { describe, expect, it, vi } from 'vitest';
import {
  applyAppWindowGuards,
  applySessionSecurity,
  classifyWindowOpen,
  deniedExternalOpens,
  isAllowedAppNavigation,
  isAppUrl,
  isArtworkCdnUrl,
  isOAuthNavigationAllowed,
  isPermissionAllowed,
  isViteDevServerUrl,
  resetDeniedExternalOpens,
  withArtworkCdnReferer,
  ARTWORK_CDN_REFERER,
  VITE_DEV_ORIGIN,
  type PermissionSession,
} from './security';
import { appIndexUrl } from './protocol';
import type { BrowserWindow } from 'electron';

describe('permission policy', () => {
  it('denies geolocation, camera/mic, notifications, and display-capture', () => {
    for (const permission of [
      'geolocation',
      'media',
      'mediaKeySystem',
      'notifications',
      'display-capture',
      'clipboard-read',
      'openExternal',
    ]) {
      expect(isPermissionAllowed(permission)).toBe(false);
    }
  });
});

describe('navigation containment', () => {
  const appUrl = appIndexUrl('?provider=fake');
  const viteUrl = `${VITE_DEV_ORIGIN}/src/main.tsx`;

  it('allows app:// and blocks external http(s)', () => {
    expect(isAppUrl(appUrl)).toBe(true);
    expect(isAllowedAppNavigation(appUrl, { allowViteDevServer: false })).toBe(true);
    expect(isAllowedAppNavigation('https://example.test/', { allowViteDevServer: false })).toBe(
      false,
    );
    expect(isAllowedAppNavigation('http://example.test/', { allowViteDevServer: true })).toBe(
      false,
    );
    expect(isAllowedAppNavigation('file:///etc/passwd', { allowViteDevServer: true })).toBe(false);
    expect(isAllowedAppNavigation('javascript:alert(1)', { allowViteDevServer: true })).toBe(false);
  });

  it('allows the Vite 1420 origin only when Main opts in', () => {
    expect(isViteDevServerUrl(viteUrl)).toBe(true);
    expect(isViteDevServerUrl('http://localhost:1420/')).toBe(false);
    expect(isViteDevServerUrl('http://127.0.0.1:1421/')).toBe(false);
    expect(isAllowedAppNavigation(viteUrl, { allowViteDevServer: false })).toBe(false);
    expect(isAllowedAppNavigation(viteUrl, { allowViteDevServer: true })).toBe(true);
    expect(
      isAllowedAppNavigation(`${VITE_DEV_ORIGIN}/?provider=fake`, { allowViteDevServer: true }),
    ).toBe(true);
  });
});

describe('window-open handler', () => {
  it('denies every opener and records http(s) for later external-links', () => {
    resetDeniedExternalOpens();
    expect(classifyWindowOpen('https://github.com/YAQMC/yaqmc')).toEqual({
      action: 'deny',
      externalHttpUrl: 'https://github.com/YAQMC/yaqmc',
    });
    expect(classifyWindowOpen('http://127.0.0.1:1420/')).toEqual({
      action: 'deny',
      externalHttpUrl: 'http://127.0.0.1:1420/',
    });
    expect(classifyWindowOpen(appIndexUrl())).toEqual({ action: 'deny' });
    expect(classifyWindowOpen('not a url')).toEqual({ action: 'deny' });
  });
});

describe('oauth navigation stub', () => {
  it('denies unless the URL is on the auth_oauth_prepare allowlist', () => {
    expect(isOAuthNavigationAllowed('https://graph.qq.com/oauth2.0/authorize', [])).toBe(false);
    expect(
      isOAuthNavigationAllowed('https://graph.qq.com/oauth2.0/authorize?x=1', [
        'https://graph.qq.com/oauth2.0/authorize',
      ]),
    ).toBe(true);
    expect(
      isOAuthNavigationAllowed('https://evil.test/', ['https://graph.qq.com/oauth2.0/authorize']),
    ).toBe(false);
  });
});

describe('session and window wiring', () => {
  it('installs deny-all permission and display-media handlers', () => {
    const permissionHandler = vi.fn();
    const displayHandler = vi.fn();
    const target: PermissionSession = {
      setPermissionRequestHandler: permissionHandler,
      setDisplayMediaRequestHandler: displayHandler,
    };
    applySessionSecurity(target);
    expect(permissionHandler).toHaveBeenCalledOnce();
    expect(displayHandler).toHaveBeenCalledOnce();

    const permissionCallback = vi.fn();
    const registeredPermission = permissionHandler.mock.calls[0]?.[0] as (
      webContents: unknown,
      permission: string,
      callback: (grant: boolean) => void,
    ) => void;
    registeredPermission({}, 'geolocation', permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);

    const displayCallback = vi.fn();
    const registeredDisplay = displayHandler.mock.calls[0]?.[0] as (
      request: unknown,
      callback: (streams: Record<string, never>) => void,
    ) => void;
    registeredDisplay({}, displayCallback);
    expect(displayCallback).toHaveBeenCalledWith({});
  });

  it('rewrites QQ artwork CDN referers to y.qq.com without touching other hosts', () => {
    expect(isArtworkCdnUrl('https://qpic.y.qq.com/playlist.jpg')).toBe(true);
    expect(isArtworkCdnUrl('https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg')).toBe(
      true,
    );
    expect(isArtworkCdnUrl('https://example.test/cover.jpg')).toBe(false);
    expect(
      withArtworkCdnReferer('https://qpic.y.qq.com/playlist.jpg', { Accept: 'image/*' }),
    ).toEqual({ Accept: 'image/*', Referer: ARTWORK_CDN_REFERER });
    expect(
      withArtworkCdnReferer('https://example.test/cover.jpg', { Referer: 'https://app/' }),
    ).toEqual({
      Referer: 'https://app/',
    });
  });

  it('installs an artwork CDN header rewrite on the session', () => {
    const permissionHandler = vi.fn();
    const displayHandler = vi.fn();
    const onBeforeSendHeaders = vi.fn();
    const target: PermissionSession = {
      setPermissionRequestHandler: permissionHandler,
      setDisplayMediaRequestHandler: displayHandler,
      webRequest: { onBeforeSendHeaders },
    };
    applySessionSecurity(target);
    expect(onBeforeSendHeaders).toHaveBeenCalledOnce();
    const filter = onBeforeSendHeaders.mock.calls[0]?.[0] as { urls: string[] };
    expect(filter.urls).toEqual(['https://y.gtimg.cn/*', 'https://qpic.y.qq.com/*']);
    const listener = onBeforeSendHeaders.mock.calls[0]?.[1] as (
      details: { url: string; requestHeaders: Record<string, string> },
      callback: (response: { requestHeaders: Record<string, string> }) => void,
    ) => void;
    const callback = vi.fn();
    listener(
      { url: 'https://qpic.y.qq.com/cover.jpg', requestHeaders: { Accept: 'image/*' } },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { Accept: 'image/*', Referer: ARTWORK_CDN_REFERER },
    });
  });

  it('prevents will-navigate to an external URL and denies window.open', () => {
    resetDeniedExternalOpens();
    const preventDefault = vi.fn();
    const on = vi.fn();
    const setWindowOpenHandler = vi.fn();
    const window = {
      webContents: { on, setWindowOpenHandler },
    } as unknown as BrowserWindow;
    applyAppWindowGuards(window, { allowViteDevServer: false });

    const navigate = on.mock.calls.find((call) => call[0] === 'will-navigate')?.[1] as (
      event: { preventDefault: () => void },
      url: string,
    ) => void;
    const redirect = on.mock.calls.find((call) => call[0] === 'will-redirect')?.[1] as (
      event: { preventDefault: () => void },
      url: string,
    ) => void;
    expect(navigate).toBeTypeOf('function');
    expect(redirect).toBeTypeOf('function');
    navigate({ preventDefault }, 'https://example.test/escape');
    expect(preventDefault).toHaveBeenCalledOnce();
    preventDefault.mockClear();
    navigate({ preventDefault }, appIndexUrl());
    expect(preventDefault).not.toHaveBeenCalled();

    const openHandler = setWindowOpenHandler.mock.calls[0]?.[0] as (details: { url: string }) => {
      action: 'deny';
    };
    expect(openHandler({ url: 'https://y.qq.com/help' })).toEqual({ action: 'deny' });
    expect(deniedExternalOpens()).toEqual(['https://y.qq.com/help']);
  });
});
