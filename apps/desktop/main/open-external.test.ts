import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GITHUB_ORG_HOST,
  GITHUB_ORG_PATH,
  isAllowedExternalUrl,
  openExternalIfAllowed,
  parseSafeHttpsUrl,
  PROVIDER_HELP_HOST,
} from './open-external';

const productLinks = [
  'https://github.com/YAQMC/YAQMC',
  'https://github.com/YAQMC/YAQMC/releases',
  'https://github.com/YAQMC/YAQMC/issues/new/choose',
  'https://github.com/YAQMC/YAQMC/tree/main/docs',
  'https://github.com/YAQMC/YAQMC/blob/main/ACKNOWLEDGEMENTS.md',
  'https://github.com/YAQMC/YAQMC/blob/main/THIRD_PARTY_NOTICES.md',
];

const issueUrl = 'https://github.com/YAQMC/YAQMC/issues/new?title=x';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('§28.6 openExternal allowlist', () => {
  it('allows FACT product links, issue-reporter URLs, and the GitHub org prefix', () => {
    for (const url of productLinks) {
      expect(isAllowedExternalUrl(url), url).toBe(true);
    }
    expect(isAllowedExternalUrl(issueUrl)).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/YAQMC')).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/YAQMC/qm-api-rs')).toBe(true);
    expect(isAllowedExternalUrl('https://GITHUB.COM/yaqmc/YAQMC')).toBe(true);
  });

  it('allows QQ Music / provider help pages on y.qq.com', () => {
    expect(isAllowedExternalUrl('https://y.qq.com')).toBe(true);
    expect(isAllowedExternalUrl('https://y.qq.com/')).toBe(true);
    expect(isAllowedExternalUrl('https://y.qq.com/n/ryqq/player')).toBe(true);
    expect(isAllowedExternalUrl('https://y.qq.com/portal/vip.html')).toBe(true);
  });

  it('allows exact https URLs the user typed in settings and nothing else from that list', () => {
    const extra = ['https://docs.example/help', 'http://insecure.example/docs'];
    expect(isAllowedExternalUrl('https://docs.example/help', extra)).toBe(true);
    expect(isAllowedExternalUrl('https://docs.example/help/more', extra)).toBe(false);
    expect(isAllowedExternalUrl('http://insecure.example/docs', extra)).toBe(false);
    expect(isAllowedExternalUrl('https://docs.example/help')).toBe(false);
  });

  it('denies non-https, credentials, non-default ports, siblings, and everything else', () => {
    const denied = [
      'http://github.com/YAQMC/YAQMC',
      'http://y.qq.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://github.com/YAQMC/YAQMC',
      '//github.com/YAQMC/YAQMC',
      'https://user:pass@github.com/YAQMC/YAQMC',
      'https://github.com:444/YAQMC/YAQMC',
      'https://github.com.evil.example/YAQMC/YAQMC',
      'https://github.com/other/repo',
      'https://github.com/YAQMCevil/x',
      'https://github.com/YAQMC.evil/x',
      'https://qpic.y.qq.com/a.jpg',
      'https://not-y.qq.com/',
      'https://y.qq.com.evil.example/',
      'https://example.invalid/docs',
      'not a url',
      'https://github.com/YAQMC/YAQMC extra',
      '',
    ];
    for (const url of denied) {
      expect(isAllowedExternalUrl(url), url).toBe(false);
    }
  });

  it('parseSafeHttpsUrl rejects whitespace and non-https without throwing', () => {
    expect(parseSafeHttpsUrl('https://github.com/YAQMC/YAQMC')?.hostname).toBe(GITHUB_ORG_HOST);
    expect(parseSafeHttpsUrl('https://y.qq.com/')?.hostname).toBe(PROVIDER_HELP_HOST);
    expect(parseSafeHttpsUrl(' https://github.com/YAQMC/YAQMC')).toBeUndefined();
    expect(parseSafeHttpsUrl('http://y.qq.com/')).toBeUndefined();
    expect(GITHUB_ORG_PATH).toBe('/YAQMC');
  });
});

describe('openExternalIfAllowed', () => {
  it('calls the injected opener only for allowlisted URLs', async () => {
    const openFn = vi.fn(async () => undefined);
    await expect(openExternalIfAllowed(openFn, productLinks[0]!)).resolves.toBe(true);
    expect(openFn).toHaveBeenCalledOnce();
    expect(openFn).toHaveBeenCalledWith(productLinks[0]);
  });

  it('logs and returns false without calling the opener when denied', async () => {
    const openFn = vi.fn(async () => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(openExternalIfAllowed(openFn, 'https://evil.example/')).resolves.toBe(false);
    expect(openFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('openExternal: denied'));
  });

  it('does not throw into the caller when the opener fails', async () => {
    const openFn = vi.fn(async () => {
      throw new Error('shell failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(openExternalIfAllowed(openFn, productLinks[0]!)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('openExternal: opener failed'));
  });

  it('passes extra https settings URLs through to the opener', async () => {
    const openFn = vi.fn(async () => undefined);
    const extra = ['https://notes.example/guide'];
    await expect(openExternalIfAllowed(openFn, extra[0]!, extra)).resolves.toBe(true);
    expect(openFn).toHaveBeenCalledWith(extra[0]);
  });
});
