import type { BrowserWindow, Session } from 'electron';
import { APP_SCHEME } from './protocol';

/** Vite `server.host` + `server.port` in `vite.config.ts`. */
export const VITE_DEV_ORIGIN = 'http://127.0.0.1:1420';

export type NavigationPolicy = {
  allowViteDevServer: boolean;
};

export type WindowOpenClassification = {
  action: 'deny';
  externalHttpUrl?: string;
};

export type PermissionSession = Pick<
  Session,
  'setPermissionRequestHandler' | 'setDisplayMediaRequestHandler'
> & {
  webRequest?: Pick<Session['webRequest'], 'onBeforeSendHeaders'>;
};

export const ARTWORK_CDN_REFERER = 'https://y.qq.com/';

const ARTWORK_CDN_HOSTS = new Set(['y.gtimg.cn', 'qpic.y.qq.com', 'music-file.y.qq.com']);
const Y_QQ_ARTWORK_PATH_PREFIXES = ['/m/resource/calendar/', '/music/common/upload/'] as const;

export function isArtworkCdnUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const allowedHost =
      ARTWORK_CDN_HOSTS.has(parsed.hostname) ||
      (parsed.hostname === 'y.qq.com' &&
        Y_QQ_ARTWORK_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix)));
    return (
      parsed.protocol === 'https:' &&
      allowedHost &&
      parsed.username === '' &&
      parsed.password === '' &&
      (parsed.port === '' || parsed.port === '443')
    );
  } catch {
    return false;
  }
}

export function withArtworkCdnReferer(
  url: string,
  requestHeaders: Record<string, string>,
): Record<string, string> {
  if (!isArtworkCdnUrl(url)) {
    return requestHeaders;
  }
  return { ...requestHeaders, Referer: ARTWORK_CDN_REFERER };
}

const recordedExternalOpens: string[] = [];

/**
 * §28.4: no geolocation, camera, mic, notifications, or display-capture.
 * Playback is native (rodio); the renderer never needs media permission.
 */
export function isPermissionAllowed(permission: string): false {
  void permission;
  return false;
}

export function isAppUrl(url: string): boolean {
  try {
    return new URL(url).protocol === `${APP_SCHEME}:`;
  } catch {
    return false;
  }
}

export function isViteDevServerUrl(url: string): boolean {
  try {
    return new URL(url).origin === VITE_DEV_ORIGIN;
  } catch {
    return false;
  }
}

/** App windows: `app://` always; Vite 1420 only when Main opts in (unpackaged `YAQMC_VITE_DEV`). */
export function isAllowedAppNavigation(url: string, policy: NavigationPolicy): boolean {
  if (isAppUrl(url)) {
    return true;
  }
  return policy.allowViteDevServer && isViteDevServerUrl(url);
}

/**
 * §28.5: always deny `window.open` / `target=_blank`. http(s) is recorded for the
 * later §28.6 external-links allowlist (not opened here).
 */
export function classifyWindowOpen(url: string): WindowOpenClassification {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { action: 'deny', externalHttpUrl: parsed.href };
    }
  } catch {
    // invalid URL
  }
  return { action: 'deny' };
}

export function recordDeniedExternalOpen(url: string): void {
  recordedExternalOpens.push(url);
}

export function deniedExternalOpens(): readonly string[] {
  return recordedExternalOpens;
}

export function resetDeniedExternalOpens(): void {
  recordedExternalOpens.length = 0;
}

/**
 * ACCT-01 owns `oauth-window.ts` (partition, capture, cancel-on-close).
 * Packaged OAuth windows only allow prefixes from `auth_oauth_prepare`.
 */
export function isOAuthNavigationAllowed(url: string, allowlist: readonly string[]): boolean {
  return allowlist.some((allowed) => url === allowed || url.startsWith(allowed));
}

export function applySessionSecurity(target: PermissionSession): void {
  target.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(isPermissionAllowed(_permission));
  });
  target.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  });
  target.webRequest?.onBeforeSendHeaders(
    {
      urls: [
        'https://y.gtimg.cn/*',
        'https://qpic.y.qq.com/*',
        'https://music-file.y.qq.com/*',
        'https://y.qq.com/m/resource/calendar/*',
        'https://y.qq.com/music/common/upload/*',
      ],
    },
    (details, callback) => {
      callback({
        requestHeaders: withArtworkCdnReferer(
          details.url,
          details.requestHeaders as Record<string, string>,
        ),
      });
    },
  );
}

export function applyAppWindowGuards(window: BrowserWindow, policy: NavigationPolicy): void {
  const block = (event: { preventDefault: () => void }, url: string): void => {
    if (!isAllowedAppNavigation(url, policy)) {
      event.preventDefault();
    }
  };
  window.webContents.on('will-navigate', block);
  window.webContents.on('will-redirect', block);
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = classifyWindowOpen(url);
    if (decision.externalHttpUrl) {
      recordDeniedExternalOpen(decision.externalHttpUrl);
    }
    return { action: 'deny' };
  });
}
