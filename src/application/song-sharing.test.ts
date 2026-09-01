import { describe, expect, it, vi } from 'vitest';
import { allSongs } from '../providers/fake/fixtures';
import type { ShareMusicProvider } from '../providers/music-provider';
import {
  buildYaqmcSongLink,
  copyTextToClipboard,
  formatSongShareText,
  resolveSongShareValue,
  SongShareUnavailableError,
} from './song-sharing';

const song = allSongs[0]!;
const target = {
  providerId: 'qqmusic',
  entityKind: 'song' as const,
  entityId: song.id,
  title: song.title,
  artists: song.artists.map((artist) => artist.name),
  album: song.album.title,
  canonicalHttpsUrl: `https://y.qq.com/n/ryqq/songDetail/${song.id}`,
};

describe('song sharing', () => {
  it('prefers the native clipboard capability over the browser clipboard', async () => {
    const nativeWriteText = vi.fn(async () => undefined);

    await copyTextToClipboard('native share text', nativeWriteText);

    expect(nativeWriteText).toHaveBeenCalledWith('native share text');
  });

  it('builds only the canonical YAQMC catalog song shape', () => {
    expect(buildYaqmcSongLink(target)).toBe(
      `yaqmc://catalog/qqmusic/song?id=${encodeURIComponent(song.id)}`,
    );
    expect(formatSongShareText(target)).toBe(`${song.title} — ${song.artists[0]!.name}`);

    expect(() => buildYaqmcSongLink({ ...target, providerId: 'QQMusic' })).toThrow(
      SongShareUnavailableError,
    );
    expect(() => buildYaqmcSongLink({ ...target, entityId: 'bad\nentity' })).toThrow(
      SongShareUnavailableError,
    );
  });

  it('uses the provider only for public links and builds app/text shares from the visible song', async () => {
    const getSongShareTarget = vi.fn().mockResolvedValue(target);
    const provider: ShareMusicProvider = { getSongShareTarget };

    await expect(resolveSongShareValue(provider, 'qqmusic', song, 'public-link')).resolves.toBe(
      target.canonicalHttpsUrl,
    );
    await expect(resolveSongShareValue(provider, 'qqmusic', song, 'yaqmc-link')).resolves.toBe(
      `yaqmc://catalog/qqmusic/song?id=${song.id}`,
    );
    await expect(resolveSongShareValue(provider, 'qqmusic', song, 'text')).resolves.toBe(
      `${song.title} — ${song.artists[0]!.name}`,
    );
    expect(getSongShareTarget).toHaveBeenCalledTimes(1);
    expect(getSongShareTarget).toHaveBeenCalledWith(song.id, undefined);
  });

  it('fails closed for mismatched targets and missing public links', async () => {
    const mismatched: ShareMusicProvider = {
      getSongShareTarget: vi.fn().mockResolvedValue({ ...target, entityId: 'another-song' }),
    };
    await expect(
      resolveSongShareValue(mismatched, 'qqmusic', song, 'public-link'),
    ).rejects.toMatchObject({ reason: 'target' });

    const privateOnly: ShareMusicProvider = {
      getSongShareTarget: vi.fn().mockResolvedValue({
        ...target,
        canonicalHttpsUrl: undefined,
      }),
    };
    await expect(
      resolveSongShareValue(privateOnly, 'qqmusic', song, 'public-link'),
    ).rejects.toMatchObject({ reason: 'public-link' });
    await expect(resolveSongShareValue(privateOnly, 'qqmusic', song, 'text')).resolves.toContain(
      song.title,
    );
  });
});
