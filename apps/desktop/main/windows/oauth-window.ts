import type { AccountLoginMethod, OAuthPrepareResult } from '@yaqmc/client';

/** §11.2: `qqmusic-oauth-{attemptId}` */
export const OAUTH_WINDOW_PREFIX = 'qqmusic-oauth-';
export const OAUTH_PARTITION_PREFIX = 'oauth:';
export const OAUTH_WINDOW_WIDTH = 480;
export const OAUTH_WINDOW_HEIGHT = 640;

export type OAuthNavigationEvent = {
  preventDefault(): void;
};

/** Injected window seam so unit tests never construct a real Electron `BrowserWindow`. */
export type OAuthWindowLike = {
  webContents: {
    on(
      event: 'will-navigate' | 'will-redirect',
      listener: (event: OAuthNavigationEvent, url: string) => void,
    ): void;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  };
  loadURL(url: string): Promise<void> | void;
  close(): void;
  on(event: 'closed', listener: () => void): void;
};

/**
 * Construction table for the OAuth popup (§11.2 / §16.4 / §28.5).
 * No preload. Session comes from injected `fromPartition` (ephemeral, not `persist:`).
 * Packaged builds set `devTools: false`.
 */
export type OAuthWindowCreateOptions = {
  title: string;
  width: number;
  height: number;
  show: true;
  webPreferences: {
    session?: unknown;
    sandbox: true;
    contextIsolation: true;
    nodeIntegration: false;
    webSecurity: true;
    allowRunningInsecureContent: false;
    experimentalFeatures: false;
    spellcheck: false;
    backgroundThrottling: false;
    devTools: boolean;
  };
};

export type OAuthWindowDeps = {
  createWindow: (options: OAuthWindowCreateOptions) => OAuthWindowLike;
  fromPartition: (partition: string, options?: { cache: boolean }) => unknown;
  isPackaged: boolean;
  auth_oauth_prepare: (params: { providerKind: AccountLoginMethod }) => Promise<OAuthPrepareResult>;
  auth_oauth_complete: (params: { attemptId: string; callbackUrl: string }) => Promise<unknown>;
  auth_oauth_cancel: (params: { attemptId: string }) => Promise<unknown>;
};

export function oauthWindowLabel(attemptId: string): string {
  return `${OAUTH_WINDOW_PREFIX}${attemptId}`;
}

export function oauthPartitionName(attemptId: string): string {
  return `${OAUTH_PARTITION_PREFIX}${attemptId}`;
}

export function oauthWindowTitle(kind: AccountLoginMethod): string {
  return kind === 'wechat' ? '微信官方登录 — YAQMC' : 'QQ 官方登录 — YAQMC';
}

/**
 * Core `url_matches_oauth_allowlist`: `https://host/**` matches scheme+host+port;
 * a trailing `**` is a string prefix; anything else is exact.
 */
export function urlMatchesOAuthAllowlist(url: string, allowlist: readonly string[]): boolean {
  const parsed = parseUrl(url);
  if (!parsed) {
    return false;
  }
  return allowlist.some((glob) => globMatchesUrl(glob, url, parsed));
}

export function isOAuthCallbackUrl(url: string, urlPrefix: string): boolean {
  return url.startsWith(urlPrefix);
}

export function oauthWindowCreateOptions(input: {
  title: string;
  session: unknown;
  isPackaged: boolean;
}): OAuthWindowCreateOptions {
  return {
    title: input.title,
    width: OAUTH_WINDOW_WIDTH,
    height: OAUTH_WINDOW_HEIGHT,
    show: true,
    webPreferences: {
      session: input.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: !input.isPackaged,
    },
  };
}

/**
 * Prepare → ephemeral partition → allowlisted navigation → callback complete.
 * User close cancels. Wired from `createHostHandlers` on `qqmusic_auth_oauth_start`
 * (renderer login click only — no auto-open at boot).
 */
export async function openOAuthWindow(
  providerKind: AccountLoginMethod,
  deps: OAuthWindowDeps,
): Promise<{ attemptId: string }> {
  const prepared = await deps.auth_oauth_prepare({ providerKind });
  const attemptId = prepared.attemptId;
  let window: OAuthWindowLike | undefined;
  try {
    const session = deps.fromPartition(oauthPartitionName(attemptId), { cache: false });
    window = deps.createWindow(
      oauthWindowCreateOptions({
        title: oauthWindowTitle(providerKind),
        session,
        isPackaged: deps.isPackaged,
      }),
    );
    attachOAuthWindowGuards(window, prepared, deps);
    void window.loadURL(prepared.url);
  } catch (error) {
    void deps.auth_oauth_cancel({ attemptId });
    window?.close();
    throw error;
  }
  return { attemptId };
}

function attachOAuthWindowGuards(
  window: OAuthWindowLike,
  prepared: OAuthPrepareResult,
  deps: Pick<OAuthWindowDeps, 'auth_oauth_complete' | 'auth_oauth_cancel'>,
): void {
  let phase: 'open' | 'completing' | 'finished' = 'open';
  const attemptId = prepared.attemptId;
  const allowlist = prepared.navigationAllowlist;
  const callbackPrefix = prepared.callbackMatcher.urlPrefix;

  const onNavigate = (event: OAuthNavigationEvent, url: string): void => {
    if (isOAuthCallbackUrl(url, callbackPrefix)) {
      event.preventDefault();
      if (phase !== 'open') {
        return;
      }
      phase = 'completing';
      void deps.auth_oauth_complete({ attemptId, callbackUrl: url }).finally(() => {
        phase = 'finished';
        window.close();
      });
      return;
    }
    if (!urlMatchesOAuthAllowlist(url, allowlist)) {
      event.preventDefault();
    }
  };

  window.webContents.on('will-navigate', onNavigate);
  window.webContents.on('will-redirect', onNavigate);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('closed', () => {
    if (phase !== 'open') {
      return;
    }
    phase = 'finished';
    void deps.auth_oauth_cancel({ attemptId });
  });
}

function globMatchesUrl(glob: string, href: string, parsed: URL): boolean {
  if (glob.endsWith('/**')) {
    const base = parseUrl(glob.slice(0, -3));
    return (
      base !== undefined &&
      parsed.protocol === base.protocol &&
      parsed.hostname === base.hostname &&
      parsed.port === base.port
    );
  }
  if (glob.endsWith('**')) {
    return href.startsWith(glob.slice(0, -2));
  }
  return href === glob;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
