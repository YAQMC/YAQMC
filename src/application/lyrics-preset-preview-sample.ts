import type { LyricDocument, Song } from '../domain/music';

export const PREVIEW_SAMPLE_SONG_ID = 'preview:yaqmc-studio';

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

/** Product-owned content used to preview lyric styling before a track is available. */
export const previewSampleSong: Song = {
  id: PREVIEW_SAMPLE_SONG_ID,
  title: '一起听见',
  artists: [{ id: 'preview:yaqmc-studio', name: 'YAQMC Studio' }],
  album: { id: 'preview:preset-preview', title: 'Preset Preview' },
  artwork: {
    src: '/artwork/preset-preview.svg',
    alt: 'Warm geometric mark over a dusk field',
    dominantColor: '#c45c6a',
  },
  durationMs: 46_000,
  trackNumber: 1,
  isFavorite: false,
  quality: 'high',
  availability: { status: 'available' },
};

export const previewSampleLyrics: LyricDocument = {
  songId: PREVIEW_SAMPLE_SONG_ID,
  syncMode: 'word',
  metadata: {
    sourceLabel: 'YAQMC built-in preset preview',
    language: 'zh',
    translatedLanguage: 'en',
    offsetMs: 0,
  },
  vocalists: [],
  lines: [
    line('p1', 1_200, 5_400, '沿着微光出发', 'Follow the first light', 'yan zhe wei guang chu fa'),
    line(
      'p2',
      5_600,
      10_200,
      '让旋律慢慢回答',
      'Let the melody answer',
      'rang xuan lv man man hui da',
    ),
    line('p3', 10_500, 15_800, '每一次呼吸', 'With every breath', 'mei yi ci hu xi'),
    line('p4', 16_200, 21_000, '都有新的回响', 'A new echo begins', 'dou you xin de hui xiang'),
    line(
      'p5',
      21_400,
      26_400,
      '穿过安静夜空',
      'Across the quiet night',
      'chuan guo an jing ye kong',
    ),
    line(
      'p6',
      26_800,
      32_200,
      '把星光写进节奏',
      'Write starlight into rhythm',
      'ba xing guang xie jin jie zou',
    ),
    line(
      'p7',
      32_600,
      38_400,
      '此刻一起听见',
      'Hear this moment together',
      'ci ke yi qi ting jian',
    ),
    line(
      'p8',
      38_800,
      44_800,
      '明天仍会相逢',
      'We will meet again tomorrow',
      'ming tian reng hui xiang feng',
    ),
  ],
};
