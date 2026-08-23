import { describe, expect, it, vi } from 'vitest';
import { resolveArtworkSource } from './artwork-resolver';
import { hydrateLyricsPresetPreview, PREVIEW_HYDRATE_QUERY } from './lyrics-preset-preview-hydrate';
import { previewFixtureSong, useLyricsPresetPreviewStore } from './lyrics-preset-preview';
import { initialPlayerState, usePlayerStore } from './player-store';
import type { LyricDocument, Song } from '../domain/music';

const hydratedSong: Song = {
  ...previewFixtureSong,
  id: 'qq:gem-together',
  artwork: {
    src: 'https://y.gtimg.cn/music/photo_new/small.jpg',
    alt: 'Album cover',
    dominantColor: '#c45c6a',
    variants: [{ src: 'https://y.gtimg.cn/music/photo_new/large.jpg', width: 800, height: 800 }],
  },
};

const hydratedLyrics: LyricDocument = {
  songId: 'qq:gem-together',
  syncMode: 'word',
  metadata: { sourceLabel: 'test', offsetMs: 0 },
  vocalists: [],
  lines: [{ id: 'one', text: '多远都要在一起', startMs: 0, endMs: 1000, words: [] }],
};

describe('lyrics preset preview hydrate', () => {
  it('updates bindings from a read-only provider search and ArtworkResolver', async () => {
    usePlayerStore.setState(initialPlayerState);
    useLyricsPresetPreviewStore.getState().reset();
    const search = vi.fn(async () => ({
      kind: 'song' as const,
      query: PREVIEW_HYDRATE_QUERY,
      page: 1,
      hasMore: false,
      items: [hydratedSong],
    }));
    const getLyrics = vi.fn(async () => hydratedLyrics);
    const setFavorite = vi.fn();
    await hydrateLyricsPresetPreview({ search, getLyrics });
    const preview = useLyricsPresetPreviewStore.getState();
    expect(search).toHaveBeenCalledWith(PREVIEW_HYDRATE_QUERY, 'song', undefined, 1, 8);
    expect(preview.song.id).toBe('qq:gem-together');
    expect(preview.artworkSrc).toBe(resolveArtworkSource(hydratedSong.artwork, 'fullscreen'));
    expect(preview.artworkSrc).toContain('large.jpg');
    expect(preview.lyrics.songId).toBe('qq:gem-together');
    expect(preview.offline).toBe(false);
    expect(usePlayerStore.getState().queue).toEqual(initialPlayerState.queue);
    expect(setFavorite).not.toHaveBeenCalled();
  });

  it('keeps the local fixture when hydrate fails', async () => {
    useLyricsPresetPreviewStore.getState().reset();
    await hydrateLyricsPresetPreview({
      search: vi.fn(async () => {
        throw new Error('offline');
      }),
      getLyrics: vi.fn(),
    });
    const preview = useLyricsPresetPreviewStore.getState();
    expect(preview.song.id).toBe(previewFixtureSong.id);
    expect(preview.offline).toBe(true);
    expect(preview.artworkSrc).toBe('/artwork/gem-together.svg');
  });
});
