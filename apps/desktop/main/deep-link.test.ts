import { describe, expect, it, vi } from 'vitest';
import {
  clipboardDeepLinksEnabledFromPreferences,
  deepLinkFromArgv,
  deepLinksEnabledFromPreferences,
  DeepLinkInbox,
  parseYaqmcDeepLink,
  registerYaqmcDeepLinkProtocol,
  type ProtocolClientApp,
} from './deep-link';

describe('YAQMC deep links', () => {
  it('round-trips the only accepted catalog song route', () => {
    const entityId = 'qqmusic:track:歌 /? #1';
    expect(
      parseYaqmcDeepLink(`yaqmc://catalog/qqmusic/song?id=${encodeURIComponent(entityId)}`),
    ).toEqual({ providerId: 'qqmusic', entityId });
  });

  it.each([
    '',
    'https://catalog/qqmusic/song?id=track',
    'yaqmc://user@catalog/qqmusic/song?id=track',
    'yaqmc://catalog:42/qqmusic/song?id=track',
    'yaqmc://catalog/qqmusic/song?id=track#play',
    'yaqmc://catalog/qqmusic/song',
    'yaqmc://catalog/qqmusic/song/',
    'yaqmc://catalog/QQMusic/song?id=track',
    'yaqmc://catalog/qqmusic/album?id=album',
    'yaqmc://catalog/qqmusic/song?id=one&id=two',
    'yaqmc://catalog/qqmusic/song?id=track&play=1',
    'yaqmc://catalog/qqmusic/song?id=%ZZ',
    'yaqmc://catalog/qqmusic/song?id=%0Atrack',
    `yaqmc://catalog/qqmusic/song?id=${'x'.repeat(257)}`,
    `yaqmc://catalog/qqmusic/song?id=${'x'.repeat(2_100)}`,
  ])('rejects invalid or command-shaped input: %s', (value) => {
    expect(parseYaqmcDeepLink(value)).toBeNull();
  });

  it('accepts one argv link and rejects ambiguous launches', () => {
    const link = 'yaqmc://catalog/qqmusic/song?id=track';
    expect(deepLinkFromArgv(['YAQMC.exe', '--flag', link])).toEqual({
      providerId: 'qqmusic',
      entityId: 'track',
    });
    expect(deepLinkFromArgv(['YAQMC.exe', link, link])).toBeNull();
    expect(deepLinkFromArgv(['YAQMC.exe', 'yaqmc://invalid'])).toBeNull();
  });

  it('registers only packaged builds and reports OS rejection without throwing', () => {
    const app: ProtocolClientApp = {
      setAsDefaultProtocolClient: vi.fn(() => true),
      isDefaultProtocolClient: vi.fn(() => true),
    };
    expect(registerYaqmcDeepLinkProtocol(app, { packaged: false })).toEqual({
      supported: false,
      registered: false,
      error: null,
    });
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();

    expect(registerYaqmcDeepLinkProtocol(app, { packaged: true })).toEqual({
      supported: true,
      registered: true,
      error: null,
    });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('yaqmc');
  });

  it('defaults protocol links on and clipboard fallback off for old preferences', () => {
    expect(deepLinksEnabledFromPreferences(undefined)).toBe(true);
    expect(deepLinksEnabledFromPreferences('{"system":{}}')).toBe(true);
    expect(deepLinksEnabledFromPreferences({ system: { deepLinksEnabled: false } })).toBe(false);
    expect(clipboardDeepLinksEnabledFromPreferences(undefined)).toBe(false);
    expect(clipboardDeepLinksEnabledFromPreferences('{"system":{}}')).toBe(false);
    expect(
      clipboardDeepLinksEnabledFromPreferences({
        system: { clipboardDeepLinksEnabled: true },
      }),
    ).toBe(true);
  });

  it('delivers a cold or warm link once and drops it when disabled', () => {
    const cold = { providerId: 'qqmusic', entityId: 'cold' };
    const inbox = new DeepLinkInbox(cold);
    expect(inbox.take(true)).toEqual(cold);
    expect(inbox.take(true)).toBeNull();

    inbox.offer({ providerId: 'qqmusic', entityId: 'warm' });
    expect(inbox.take(false)).toBeNull();
    expect(inbox.take(true)).toBeNull();
  });
});
