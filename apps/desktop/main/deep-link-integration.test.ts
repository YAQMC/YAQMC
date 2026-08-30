import { describe, expect, it, vi } from 'vitest';
import { deepLinkFromArgv, type CatalogSongDeepLink } from './deep-link';
import { acquireSingleInstanceLock, type SingleInstanceApp } from './single-instance';

describe('Electron deep-link single-instance integration', () => {
  it('focuses the existing window and emits one typed navigation target', () => {
    let secondInstance:
      ((event: unknown, commandLine: string[], workingDirectory: string) => void) | undefined;
    const electronApp: SingleInstanceApp = {
      requestSingleInstanceLock: () => true,
      quit: vi.fn(),
      on: (_event, listener) => {
        secondInstance = listener;
      },
    };
    const focus = vi.fn();
    const received: CatalogSongDeepLink[] = [];
    acquireSingleInstanceLock(
      electronApp,
      () => ({
        isDestroyed: () => false,
        isMinimized: () => false,
        restore: vi.fn(),
        show: vi.fn(),
        focus,
      }),
      (commandLine) => {
        const target = deepLinkFromArgv(commandLine);
        if (target) received.push(target);
      },
    );

    secondInstance?.(
      {},
      ['YAQMC.exe', 'yaqmc://catalog/qqmusic/song?id=qqmusic%3Atrack%3A001'],
      'C:\\',
    );

    expect(received).toEqual([{ providerId: 'qqmusic', entityId: 'qqmusic:track:001' }]);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
