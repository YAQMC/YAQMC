import { resolveArtworkSource } from './artwork-resolver';
import { logger } from './logger';
import { previewSampleLyrics, useLyricsPresetPreviewStore } from './lyrics-preset-preview';
import type { MusicProvider } from '../providers/music-provider';

export const PREVIEW_HYDRATE_QUERY = '一起听见 YAQMC Studio';

export async function hydrateLyricsPresetPreview(
  provider: Pick<MusicProvider, 'search' | 'getLyrics'>,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await provider.search(PREVIEW_HYDRATE_QUERY, 'song', signal, 1, 8);
    if (signal?.aborted) return;
    const match =
      result.kind === 'song'
        ? (result.items.find((song) => song.title.includes('一起听见')) ?? result.items[0])
        : undefined;
    if (!match) {
      useLyricsPresetPreviewStore.getState().fallback();
      return;
    }
    const lyrics = (await provider.getLyrics(match.id, signal)) ?? previewSampleLyrics;
    if (signal?.aborted) return;
    const artworkSrc = resolveArtworkSource(match.artwork, 'fullscreen');
    useLyricsPresetPreviewStore.getState().hydrate({
      song: match,
      lyrics,
      artworkSrc,
    });
  } catch (caught) {
    if (signal?.aborted) return;
    logger.warn('lyrics.preview.fallback', 'preset preview hydrate failed', {
      error: String(caught),
    });
    useLyricsPresetPreviewStore.getState().fallback();
  }
}
