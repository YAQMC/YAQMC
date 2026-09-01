import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderContext } from '../application/provider-context';
import { allSongs } from '../providers/fake/fixtures';
import type { MusicProvider, ShareMusicProvider } from '../providers/music-provider';
import { SongShareMenuItems } from './SongShareActions';

const mocks = vi.hoisted(() => ({
  writeText: vi.fn(async () => undefined),
  pushNotice: vi.fn(),
}));

vi.mock('../application/yaqmc-runtime', () => ({
  getHostBridge: () => ({
    kind: 'electron',
    clipboard: { writeText: mocks.writeText },
  }),
}));

vi.mock('../application/plugin-notifications', () => ({
  pushPluginNotice: mocks.pushNotice,
}));

describe('SongShareMenuItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies every share variant through the native clipboard', async () => {
    const song = allSongs[0]!;
    const publicUrl = `https://y.qq.com/n/ryqq/songDetail/${song.id}`;
    const getSongShareTarget = vi.fn(async () => ({
      providerId: 'qqmusic',
      entityKind: 'song' as const,
      entityId: song.id,
      title: song.title,
      artists: song.artists.map((artist) => artist.name),
      album: song.album.title,
      canonicalHttpsUrl: publicUrl,
    }));
    const provider = {
      id: 'qqmusic',
      displayName: 'QQ Music',
      getSongShareTarget,
    } as unknown as MusicProvider & ShareMusicProvider;
    const onSelect = vi.fn();

    render(
      <ProviderContext.Provider value={provider}>
        <SongShareMenuItems song={song} onSelect={onSelect} />
      </ProviderContext.Provider>,
    );

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy public song link' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy YAQMC link' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy song and artist' }));

    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(3));
    expect(mocks.writeText).toHaveBeenCalledWith(publicUrl);
    expect(mocks.writeText).toHaveBeenCalledWith(
      `yaqmc://catalog/qqmusic/song?id=${encodeURIComponent(song.id)}`,
    );
    expect(mocks.writeText).toHaveBeenCalledWith(`${song.title} — ${song.artists[0]!.name}`);
    expect(getSongShareTarget).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledTimes(3);
  });
});
