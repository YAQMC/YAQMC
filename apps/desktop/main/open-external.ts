/**
 * §28.6 `shell.openExternal` allowlist. Main is the chokepoint; this module is
 * wired from `index.ts` through `IpcRouter` as `shell.openExternal`. Callers inject the opener so
 * unit tests can use a mock instead of Electron `shell`.
 *
 * FACT sources:
 * - `src/application/external-links.ts` opens `productMetadata.links` (all
 *   `https://github.com/YAQMC/YAQMC…`).
 * - `src/application/issue-reporter.ts` + Rust `validate_open_url` require
 *   `https://github.com/YAQMC/YAQMC/issues/new…`.
 * - The pre-migration opener allowed only
 *   `https://github.com/YAQMC/YAQMC` and `https://github.com/YAQMC/YAQMC/*`.
 *
 * Plan §28.6 widens the Electron Main list to the org prefix
 * `https://github.com/YAQMC/*`, QQ Music / provider help `https://y.qq.com/*`,
 * and exact https URLs the user typed in settings. Non-https and everything
 * else: log + return false. Never throw into the renderer.
 */

export const GITHUB_ORG_HOST = 'github.com';
export const GITHUB_ORG_PATH = '/YAQMC';
export const PROVIDER_HELP_HOST = 'y.qq.com';

export type ExternalOpener = (url: string) => Promise<unknown> | unknown;

function hasWhitespace(url: string): boolean {
  return /[\s]/u.test(url);
}

/**
 * https-only, no credentials, default port only. Invalid input returns undefined
 * instead of throwing.
 */
export function parseSafeHttpsUrl(url: string): URL | undefined {
  if (typeof url !== 'string' || url.length === 0 || hasWhitespace(url)) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return undefined;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return undefined;
    }
    if (parsed.port !== '') {
      return undefined;
    }
    if (parsed.hostname.length === 0) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isGithubOrgUrl(parsed: URL): boolean {
  if (parsed.hostname.toLowerCase() !== GITHUB_ORG_HOST) {
    return false;
  }
  const expectedOrg = GITHUB_ORG_PATH.slice(1).toLowerCase();
  const org = parsed.pathname.split('/')[1];
  return org !== undefined && org.toLowerCase() === expectedOrg;
}

function isProviderHelpUrl(parsed: URL): boolean {
  return parsed.hostname.toLowerCase() === PROVIDER_HELP_HOST;
}

function isExplicitUserTypedUrl(parsed: URL, extraHttpsUrls: readonly string[]): boolean {
  return extraHttpsUrls.some((raw) => {
    const extra = parseSafeHttpsUrl(raw);
    return extra !== undefined && extra.href === parsed.href;
  });
}

/**
 * True iff `url` may be handed to `shell.openExternal`.
 * `extraHttpsUrls` are exact settings values; each must itself be https.
 */
export function isAllowedExternalUrl(url: string, extraHttpsUrls: readonly string[] = []): boolean {
  const parsed = parseSafeHttpsUrl(url);
  if (!parsed) {
    return false;
  }
  return (
    isGithubOrgUrl(parsed) ||
    isProviderHelpUrl(parsed) ||
    isExplicitUserTypedUrl(parsed, extraHttpsUrls)
  );
}

function previewUrl(url: string): string {
  return url.length > 200 ? `${url.slice(0, 200)}…` : url;
}

function logDenied(url: string): void {
  console.warn(`openExternal: denied ${previewUrl(url)}`);
}

/**
 * Allowlist then call `openFn`. Denied / opener failures log and return false.
 */
export async function openExternalIfAllowed(
  openFn: ExternalOpener,
  url: string,
  extraHttpsUrls: readonly string[] = [],
): Promise<boolean> {
  if (!isAllowedExternalUrl(url, extraHttpsUrls)) {
    logDenied(url);
    return false;
  }
  try {
    await openFn(url);
    return true;
  } catch (error) {
    console.warn(`openExternal: opener failed ${previewUrl(url)}: ${String(error)}`);
    return false;
  }
}
