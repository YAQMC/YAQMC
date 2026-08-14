import type { LyricDocument, Song } from '../domain/music';

export const PREVIEW_FIXTURE_SONG_ID = 'fixture:gem-together';

function words(
  startMs: number,
  endMs: number,
  text: string,
): Array<{ startMs: number; endMs: number; text: string }> {
  const segments = text.match(/\p{Script=Han}|[^\p{Script=Han}\s]+\s*/gu) ?? [text];
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  let cursor = startMs;
  return segments.map((segment, index) => {
    const duration =
      index === segments.length - 1
        ? endMs - cursor
        : Math.round(((endMs - startMs) * segment.length) / total);
    const word = { startMs: cursor, endMs: cursor + duration, text: segment };
    cursor += duration;
    return word;
  });
}

function line(
  id: string,
  startMs: number,
  endMs: number,
  text: string,
  translation: string,
  romanization: string,
) {
  return {
    id,
    startMs,
    endMs,
    text,
    translation,
    romanization,
    words: words(startMs, endMs, text),
  };
}

export const previewFixtureSong: Song = {
  id: PREVIEW_FIXTURE_SONG_ID,
  title: '多远都要在一起',
  artists: [{ id: 'fixture:gem', name: 'G.E.M. 邓紫棋' }],
  album: { id: 'fixture:gem-album', title: '新的心跳' },
  artwork: {
    src: '/artwork/gem-together.svg',
    alt: 'Warm geometric gem over a dusk field',
    dominantColor: '#c45c6a',
  },
  durationMs: 46_000,
  trackNumber: 1,
  isFavorite: false,
  quality: 'high',
  availability: { status: 'available' },
};

export const previewFixtureLyrics: LyricDocument = {
  songId: PREVIEW_FIXTURE_SONG_ID,
  syncMode: 'word',
  metadata: {
    sourceLabel: 'YAQMC preset preview fixture',
    language: 'zh',
    translatedLanguage: 'en',
    offsetMs: 0,
  },
  vocalists: [],
  lines: [
    line(
      'g1',
      1_200,
      5_400,
      '就算世界再大',
      'Even if the world is vast',
      'jiu suan shi jie zai da',
    ),
    line('g2', 5_600, 10_200, '我都要找到你', 'I will still find you', 'wo dou yao zhao dao ni'),
    line(
      'g3',
      10_500,
      15_800,
      '多远都要在一起',
      'No matter how far, stay together',
      'duo yuan dou yao zai yi qi',
    ),
    line('g4', 16_200, 21_000, '你是我的勇气', 'You are my courage', 'ni shi wo de yong qi'),
    line('g5', 21_400, 26_400, '黑夜有多安静', 'However quiet the night', 'hei ye you duo an jing'),
    line(
      'g6',
      26_800,
      32_200,
      '心跳都听得清',
      'I can hear every heartbeat',
      'xin tiao dou ting de qing',
    ),
    line(
      'g7',
      32_600,
      38_400,
      '多远都要在一起',
      'No matter how far, stay together',
      'duo yuan dou yao zai yi qi',
    ),
    line('g8', 38_800, 44_800, '请你不要怀疑', 'Please do not doubt it', 'qing ni bu yao huai yi'),
  ],
};
