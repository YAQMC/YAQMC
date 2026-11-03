import type { LyricDocument, LyricLine, Song } from '../domain/music';

/**
 * Project website demo song: a tour of YAQMC's features sung to the public-domain
 * melody of "Twinkle, Twinkle, Little Star" (小星星), one Han character per note.
 */
export const WEBSITE_SONG_ID = 'website-little-star';

const BEAT_MS = 600;
const INTRO_MS = 4 * BEAT_MS;
const PHRASE_MS = 8 * BEAT_MS;

const C3 = 48;
const F3 = 53;
const G3 = 55;
const C4 = 60;
const D4 = 62;
const E4 = 64;
const F4 = 65;
const G4 = 67;
const A4 = 69;
const PHRASES = {
  a: { melody: [C4, C4, G4, G4, A4, A4, G4], bass: [C3, C3, F3, C3] },
  b: { melody: [F4, F4, E4, E4, D4, D4, C4], bass: [F3, C3, G3, C3] },
  c: { melody: [G4, G4, F4, F4, E4, E4, D4], bass: [C3, F3, C3, G3] },
};

// Two verses of the tune, one feature per line.
const LINES: Array<[keyof typeof PHRASES, string, string, string]> = [
  ['a', '逐字歌词随声亮', 'Zhú zì gēcí suí shēng liàng', 'Every word lights up in turn'],
  ['b', '翻译注音一起唱', 'Fānyì zhùyīn yìqǐ chàng', 'Translate, romanize, and learn'],
  ['c', '桌面歌词浮窗上', 'Zhuōmiàn gēcí fú chuāng shàng', 'Float the lyrics on your screen'],
  ['c', '歌词岛上放光芒', 'Gēcí dǎo shàng fàng guāngmáng', 'Lyrics Island, always seen'],
  ['a', '播放队列不慌忙', 'Bōfàng duìliè bù huāngmáng', 'Rust keeps every beat in time'],
  ['b', '音质进度记心上', 'Yīnzhì jìndù jì xīn shàng', 'Queue and quality in line'],
  ['a', '搜索歌手和专辑', 'Sōusuǒ gēshǒu hé zhuānjí', 'Search a song, an artist, more'],
  ['b', '顺着喜欢去寻觅', 'Shùnzhe xǐhuan qù xúnmì', 'Albums open every door'],
  ['c', '登录打开音乐库', 'Dēnglù dǎkāi yīnyuè kù', 'Sign in, find your library'],
  ['c', '分享链接给朋友', 'Fēnxiǎng liànjiē gěi péngyou', 'Share a link for friends to see'],
  ['a', '桌面手机都能用', 'Zhuōmiàn shǒujī dōu néng yòng', 'Windows, Linux, Android too'],
  ['b', '插件让它更出众', 'Chājiàn ràng tā gèng chūzhòng', 'Plugins dress it up for you'],
];

export interface WebsiteNote {
  startMs: number;
  durationMs: number;
  midi: number;
  bass: boolean;
}

const notes: WebsiteNote[] = [];
const lines: LyricLine[] = LINES.map(([key, text, romanization, translation], index) => {
  const phrase = PHRASES[key];
  const characters = [...text];
  const lineStart = INTRO_MS + index * PHRASE_MS;
  let cursor = lineStart;
  // Six quarter notes and a closing half note.
  const words = phrase.melody.map((midi, note) => {
    const durationMs = (note === phrase.melody.length - 1 ? 2 : 1) * BEAT_MS;
    notes.push({ startMs: cursor, durationMs, midi, bass: false });
    const word = { startMs: cursor, endMs: cursor + durationMs, text: characters[note] ?? '' };
    cursor += durationMs;
    return word;
  });
  phrase.bass.forEach((midi, beat) =>
    notes.push({
      startMs: lineStart + beat * 2 * BEAT_MS,
      durationMs: 2 * BEAT_MS,
      midi,
      bass: true,
    }),
  );
  return {
    id: `ls-${index + 1}`,
    startMs: lineStart,
    endMs: cursor,
    text,
    romanization,
    translation,
    words,
  };
});

export const websiteNotes: readonly WebsiteNote[] = notes;

export const websiteLyrics: LyricDocument = {
  songId: WEBSITE_SONG_ID,
  syncMode: 'word',
  metadata: {
    sourceLabel: 'YAQMC website demo · melody: Twinkle, Twinkle, Little Star (traditional)',
    language: 'zh-Hans',
    translatedLanguage: 'en',
    offsetMs: 0,
  },
  vocalists: [{ id: 'lead', displayName: 'Lead vocal' }],
  lines,
};

export const websiteSong: Song = {
  id: WEBSITE_SONG_ID,
  title: '小星星 · Little Star',
  artists: [{ id: 'artist-yaqmc', name: 'YAQMC' }],
  album: { id: 'album-every-word', title: 'Every Word' },
  artwork: {
    src: '/artwork/orbit.svg',
    alt: 'Small moon crossing a cobalt field',
    dominantColor: '#535e9c',
  },
  durationMs: INTRO_MS + LINES.length * PHRASE_MS + INTRO_MS,
  trackNumber: 1,
  isFavorite: true,
  quality: 'lossless',
  availability: { status: 'available' },
};
