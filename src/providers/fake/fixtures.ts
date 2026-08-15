import type {
  Album,
  AreaFeed,
  ArtistSummary,
  DiscoverFeed,
  HomeFeed,
  LibrarySnapshot,
  LyricDocument,
  LyricLine,
  LyricWord,
  Playlist,
  Song,
} from '../../domain/music';

const artists = {
  mira: { id: 'artist-mira-vale', name: 'Mira Vale' },
  atlas: { id: 'artist-atlas-week', name: 'Atlas Week' },
  linnea: { id: 'artist-linnea', name: 'Linnea' },
  noa: { id: 'artist-noa-sora', name: 'Noa Sora' },
  jun: { id: 'artist-juniper', name: 'Juniper' },
} satisfies Record<string, ArtistSummary>;

const artwork = {
  afterglow: {
    src: '/artwork/afterglow.svg',
    alt: 'Abstract amber light over a dark horizon',
    dominantColor: '#b9683b',
  },
  glasshouse: {
    src: '/artwork/glasshouse.svg',
    alt: 'Geometric glass forms in soft green',
    dominantColor: '#668e7c',
  },
  sunroom: {
    src: '/artwork/sunroom.svg',
    alt: 'Warm yellow room with long window shadows',
    dominantColor: '#c99949',
  },
  tide: {
    src: '/artwork/tide.svg',
    alt: 'Deep blue water lines at dusk',
    dominantColor: '#345e72',
  },
  orbit: {
    src: '/artwork/orbit.svg',
    alt: 'Small moon crossing a cobalt field',
    dominantColor: '#535e9c',
  },
  nightDrive: {
    src: '/artwork/night-drive.svg',
    alt: 'Night road lights seen through rain',
    dominantColor: '#5c4f76',
  },
  stillness: {
    src: '/artwork/stillness.svg',
    alt: 'Minimal pale stones on muted sand',
    dominantColor: '#9b9483',
  },
  daybreak: {
    src: '/artwork/daybreak.svg',
    alt: 'Coral dawn behind a distant ridge',
    dominantColor: '#b85b52',
  },
} as const;

function makeSong(
  id: string,
  title: string,
  artist: ArtistSummary,
  albumId: string,
  albumTitle: string,
  cover: (typeof artwork)[keyof typeof artwork],
  durationMs: number,
  trackNumber: number,
  isFavorite = false,
): Song {
  return {
    id,
    title,
    artists: [artist],
    album: { id: albumId, title: albumTitle },
    artwork: cover,
    durationMs,
    trackNumber,
    isFavorite,
    quality: 'lossless',
    availability: { status: 'available' },
  };
}

const afterglowTracks = [
  ['quiet-light', 'Quiet Light', 252_000, true],
  ['night-geometry', 'Night Geometry', 228_000, false],
  ['still-water', 'Still Water', 304_000, true],
  ['soft-static', 'Soft Static', 211_000, false],
  ['north-window', 'North Window', 284_000, false],
  ['afterglow-track', 'Afterglow', 245_000, true],
  ['second-weather', 'Second Weather', 236_000, false],
  ['home-signal', 'Home Signal', 267_000, false],
].map(([id, title, duration, favorite], index) =>
  makeSong(
    String(id),
    String(title),
    artists.mira,
    'album-afterglow',
    'Afterglow',
    artwork.afterglow,
    Number(duration),
    index + 1,
    Boolean(favorite),
  ),
);

const glasshouseTracks = [
  ['open-frame', 'Open Frame', 222_000],
  ['small-hours', 'Small Hours', 263_000],
  ['green-line', 'Green Line', 198_000],
  ['somewhere-clear', 'Somewhere Clear', 289_000],
].map(([id, title, duration], index) =>
  makeSong(
    String(id),
    String(title),
    artists.atlas,
    'album-glasshouse',
    'Glasshouse',
    artwork.glasshouse,
    Number(duration),
    index + 1,
    index === 1,
  ),
);

const sunroomTracks = [
  ['paper-sun', 'Paper Sun', 207_000],
  ['april-in-reverse', 'April in Reverse', 241_000],
  ['the-long-way', 'The Long Way', 232_000],
  ['ordinary-gold', 'Ordinary Gold', 215_000],
].map(([id, title, duration], index) =>
  makeSong(
    String(id),
    String(title),
    artists.linnea,
    'album-sunroom',
    'Sun Room',
    artwork.sunroom,
    Number(duration),
    index + 1,
    index === 0,
  ),
);

const tideTracks = [
  ['low-tide', 'Low Tide', 247_000],
  ['blue-hour', 'Blue Hour', 271_000],
  ['shoreline-sleep', 'Shoreline Sleep', 318_000],
].map(([id, title, duration], index) =>
  makeSong(
    String(id),
    String(title),
    artists.noa,
    'album-tide-maps',
    'Tide Maps',
    artwork.tide,
    Number(duration),
    index + 1,
    false,
  ),
);

export const albums: Album[] = [
  {
    id: 'album-afterglow',
    title: 'Afterglow',
    artist: artists.mira,
    artwork: artwork.afterglow,
    releaseYear: 2026,
    genre: 'Electronic',
    description:
      'A patient record built from warm synths, close percussion, and the quiet left after a long day.',
    tracks: afterglowTracks,
  },
  {
    id: 'album-glasshouse',
    title: 'Glasshouse',
    artist: artists.atlas,
    artwork: artwork.glasshouse,
    releaseYear: 2025,
    genre: 'Alternative',
    description: 'Clear-edged songs with soft centers and a sense of open air.',
    tracks: glasshouseTracks,
  },
  {
    id: 'album-sunroom',
    title: 'Sun Room',
    artist: artists.linnea,
    artwork: artwork.sunroom,
    releaseYear: 2026,
    genre: 'Indie Pop',
    description: 'Small observations rendered in warm guitars and unhurried melodies.',
    tracks: sunroomTracks,
  },
  {
    id: 'album-tide-maps',
    title: 'Tide Maps',
    artist: artists.noa,
    artwork: artwork.tide,
    releaseYear: 2024,
    genre: 'Ambient',
    description: 'Slow-moving pieces for late evenings and open windows.',
    tracks: tideTracks,
  },
];

const mixedPool = [
  afterglowTracks[0],
  sunroomTracks[0],
  glasshouseTracks[1],
  tideTracks[1],
  afterglowTracks[4],
  glasshouseTracks[3],
  sunroomTracks[2],
  tideTracks[0],
].filter((song): song is Song => song !== undefined);

export const playlists: Playlist[] = [
  {
    id: 'playlist-night-drive',
    title: 'Night Drive',
    description: 'Low light, open roads, and songs that leave room to think.',
    owner: { id: 'editorial', displayName: 'YAQMC Editors' },
    artwork: artwork.nightDrive,
    updatedLabel: 'Updated Friday',
    tracks: mixedPool,
  },
  {
    id: 'playlist-soft-current',
    title: 'Soft Current',
    description: 'A steady stream of gentle electronic and ambient detail.',
    owner: { id: 'for-you', displayName: 'Made for you' },
    artwork: artwork.tide,
    updatedLabel: 'Refreshed today',
    tracks: [...tideTracks, ...afterglowTracks.slice(0, 4)],
  },
  {
    id: 'playlist-sunday',
    title: 'Sunday Morning',
    description: 'Easy starts, warm rooms, and nothing urgent.',
    owner: { id: 'editorial', displayName: 'YAQMC Editors' },
    artwork: artwork.daybreak,
    updatedLabel: 'Updated weekly',
    tracks: [...sunroomTracks, ...glasshouseTracks.slice(0, 2)],
  },
  {
    id: 'playlist-stillness',
    title: 'A Little Stillness',
    description: 'Quiet music for reading, writing, or simply being here.',
    owner: { id: 'for-you', displayName: 'Made for you' },
    artwork: artwork.stillness,
    updatedLabel: 'Refreshed yesterday',
    tracks: [...afterglowTracks.slice(2), ...tideTracks],
  },
  {
    id: 'playlist-orbit',
    title: 'Night Orbit',
    description: 'Measured rhythm and wide, cinematic space.',
    owner: { id: 'editorial', displayName: 'YAQMC Editors' },
    artwork: artwork.orbit,
    updatedLabel: 'Updated this month',
    tracks: [...glasshouseTracks, ...afterglowTracks.slice(1, 5)],
  },
];

export const homeFeed: HomeFeed = {
  featured: { eyebrow: 'FEATURED ALBUM', album: albums[0]! },
  recentlyPlayed: [
    { type: 'playlist', item: playlists[0]! },
    { type: 'album', item: albums[1]! },
    { type: 'album', item: albums[2]! },
    { type: 'playlist', item: playlists[3]! },
    { type: 'album', item: albums[3]! },
  ],
  madeForYou: [playlists[1]!, playlists[2]!, playlists[3]!, playlists[4]!],
  newReleases: [albums[0]!, albums[2]!, albums[1]!, albums[3]!],
  guessSonglist: playlists[1]!,
  recommendedSonglists: [playlists[1]!, playlists[2]!, playlists[3]!, playlists[4]!],
  dailySonglist: playlists[0]!,
  newSongSonglist: playlists[2]!,
  radarBasedOnSong: albums[0]!.tracks[0]?.title ?? null,
  radarSongs: [...albums[2]!.tracks.slice(0, 4), ...albums[3]!.tracks.slice(0, 3)],
};

export const discoverFeed: DiscoverFeed = {
  charts: [playlists[0]!, playlists[1]!, playlists[2]!, playlists[3]!],
  newSongs: playlists[2]!,
  newAlbums: [albums[0]!, albums[2]!, albums[1]!, albums[3]!],
  popularSonglists: [playlists[0]!, playlists[2]!, playlists[3]!, playlists[4]!],
  categories: [
    { encArea: 'area-classic', title: '经典', cover: albums[0]!.artwork.src },
    { encArea: 'area-ambient', title: '轻音乐', cover: albums[2]!.artwork.src },
    { encArea: 'area-cnpop', title: '华语流行', cover: albums[1]!.artwork.src },
  ],
  podcasts: [
    { id: 'podcast-1', title: '夜航电台', subtitle: '深夜陪伴', cover: albums[0]!.artwork.src },
    { id: 'podcast-2', title: '音乐漫谈', subtitle: '每周更新', cover: albums[2]!.artwork.src },
    { id: 'podcast-3', title: '拾光片场', subtitle: '影视原声', cover: albums[3]!.artwork.src },
  ],
  newMvs: [
    { id: 'mv-1', title: '夜航 (Live)', cover: albums[0]!.artwork.src, durationMs: 240000, artist: 'Mira Vale' },
    { id: 'mv-2', title: '余晖', cover: albums[2]!.artwork.src, durationMs: 210000, artist: 'Linnea' },
    { id: 'mv-3', title: '无眠', cover: albums[3]!.artwork.src, durationMs: 195000, artist: 'Noa Sora' },
  ],
  featured: [
    { id: 'focus-1', title: '春日特辑', subtitle: '编辑推荐', cover: albums[0]!.artwork.src },
    { id: 'focus-2', title: '深夜书房', subtitle: '安静时光', cover: albums[1]!.artwork.src },
    { id: 'focus-3', title: '新声集结', subtitle: '新人精选', cover: albums[2]!.artwork.src },
  ],
};

export const areaFeeds: Record<string, AreaFeed> = {
  'area-classic': {
    title: '经典专区',
    songlists: [playlists[1]!, playlists[2]!],
    playlists: [playlists[0]!, playlists[3]!, playlists[4]!],
    artists: [
      { id: 'artist-1', name: 'Mira Vale', cover: albums[0]!.artwork.src },
      { id: 'artist-2', name: 'Atlas Week', cover: albums[1]!.artwork.src },
      { id: 'artist-3', name: 'Linnea', cover: albums[2]!.artwork.src },
    ],
  },
};

export const librarySnapshot: LibrarySnapshot = {  favoriteSongs: [...afterglowTracks, ...glasshouseTracks, ...sunroomTracks].filter(
    (song) => song.isFavorite,
  ),
  savedAlbums: [albums[0]!, albums[2]!, albums[3]!],
  savedPlaylists: [playlists[0]!, playlists[3]!],
};

function words(startMs: number, endMs: number, text: string): LyricWord[] {
  // Treat Han characters as independently timed glyphs while keeping whitespace
  // attached to Latin-script words. This makes mixed-language fixtures useful
  // without pretending that whitespace tokenization is universal.
  const segments = text.match(/\p{Script=Han}|[^\p{Script=Han}\s]+\s*/gu) ?? [text];
  const totalCharacters = segments.reduce((sum, segment) => sum + segment.length, 0);
  let cursor = startMs;

  return segments.map((segment, index) => {
    const remaining = endMs - cursor;
    const duration =
      index === segments.length - 1
        ? remaining
        : Math.round(((endMs - startMs) * segment.length) / totalCharacters);
    const word = { startMs: cursor, endMs: cursor + duration, text: segment };
    cursor += duration;
    return word;
  });
}

function timedLine(
  id: string,
  startMs: number,
  endMs: number,
  text: string,
  options: Partial<Pick<LyricLine, 'translation' | 'romanization' | 'vocalistId'>> = {},
  wordTimed = false,
): LyricLine {
  return {
    id,
    startMs,
    endMs,
    text,
    words: wordTimed ? words(startMs, endMs, text) : [],
    ...options,
  };
}

function lyricDocument(
  songId: string,
  syncMode: LyricDocument['syncMode'],
  lines: LyricLine[],
  metadata: Partial<LyricDocument['metadata']> = {},
): LyricDocument {
  return {
    songId,
    syncMode,
    metadata: { sourceLabel: 'Offline development fixture', offsetMs: 0, ...metadata },
    vocalists: [
      { id: 'lead', displayName: 'Lead vocal' },
      { id: 'response', displayName: 'Response vocal' },
    ],
    lines,
  };
}

export const lyricsBySong: Record<string, LyricDocument | null> = {
  'quiet-light': {
    songId: 'quiet-light',
    syncMode: 'word',
    metadata: {
      sourceLabel: 'Word-synchronized development fixture',
      language: 'en',
      offsetMs: 0,
    },
    vocalists: [{ id: 'lead', displayName: 'Mira Vale' }],
    lines: [
      timedLine('ql-1', 4_000, 16_000, 'The room keeps the shape of the evening', {}, true),
      timedLine('ql-2', 18_000, 31_500, 'A quiet light across the floor', {}, true),
      timedLine('ql-3', 35_000, 47_000, 'Nothing asks to be remembered', {}, true),
      timedLine('ql-4', 51_000, 64_500, 'Still I stay a little more', {}, true),
      timedLine('ql-5', 74_000, 89_000, 'Slow down, let the silence find us', {}, true),
      timedLine('ql-6', 96_000, 110_000, 'Every shadow settling right', {}, true),
      timedLine('ql-7', 119_000, 133_500, 'No map, no need to name it', {}, true),
      timedLine('ql-8', 143_000, 159_000, 'Only this quiet light', {}, true),
    ],
  },
  'night-geometry': lyricDocument('night-geometry', 'line', [
    timedLine('ng-1', 7_000, 20_000, 'Street lines fold into the rain'),
    timedLine('ng-2', 22_000, 35_500, 'Every corner turns the same'),
    timedLine('ng-3', 39_000, 53_000, 'We draw a city out of silence'),
    timedLine('ng-4', 57_000, 72_000, 'Then watch it disappear again'),
  ]),
  'still-water': lyricDocument('still-water', 'line', [
    timedLine(
      'sw-1',
      8_000,
      28_000,
      'There is a long and patient distance between the sound of leaving and the moment everything becomes still',
    ),
    timedLine('sw-2', 31_000, 47_000, 'I hear the whole horizon breathing in'),
    timedLine('sw-3', 52_000, 69_000, 'The water keeps no record of the wind'),
  ]),
  'soft-static': lyricDocument('soft-static', 'word', [
    timedLine('ss-1', 2_000, 5_200, 'Wake up', { vocalistId: 'lead' }, true),
    timedLine('ss-2', 5_350, 8_800, 'Stay close', { vocalistId: 'response' }, true),
    timedLine('ss-3', 9_000, 13_000, 'Small sparks in the radio', { vocalistId: 'lead' }, true),
    timedLine('ss-4', 13_100, 16_600, 'Move fast', { vocalistId: 'response' }, true),
    timedLine('ss-5', 16_800, 21_000, 'Then let it go', { vocalistId: 'lead' }, true),
  ]),
  'home-signal': lyricDocument('home-signal', 'unsynchronized', [
    { id: 'hs-1', startMs: null, endMs: null, text: 'Leave a light beside the doorway', words: [] },
    { id: 'hs-2', startMs: null, endMs: null, text: 'I will know the road from here', words: [] },
    { id: 'hs-3', startMs: null, endMs: null, text: 'Every quiet room is calling', words: [] },
    { id: 'hs-4', startMs: null, endMs: null, text: 'Like a signal, warm and clear', words: [] },
  ]),
  'paper-sun': lyricDocument(
    'paper-sun',
    'word',
    [
      timedLine(
        'ps-1',
        5_000,
        17_000,
        '折一束晨光放在窗前',
        {
          translation: 'Fold a ray of morning light beside the window',
          romanization: 'Zhé yī shù chénguāng fàng zài chuāngqián',
        },
        true,
      ),
      timedLine(
        'ps-2',
        20_000,
        33_000,
        '让今天慢一点出现',
        {
          translation: 'Let today arrive a little more slowly',
          romanization: 'Ràng jīntiān màn yīdiǎn chūxiàn',
        },
        true,
      ),
      timedLine(
        'ps-3',
        37_000,
        51_000,
        '我们把影子留给昨天',
        {
          translation: 'We leave our shadows to yesterday',
          romanization: 'Wǒmen bǎ yǐngzi liú gěi zuótiān',
        },
        true,
      ),
    ],
    { language: 'zh-Hans', translatedLanguage: 'en' },
  ),
  'blue-hour': lyricDocument('blue-hour', 'line', [
    timedLine('bh-1', 6_000, 18_000, 'Before the color leaves the sky'),
    timedLine('bh-2', 20_000, 31_000, 'We hold the blue hour still'),
    timedLine('bh-3', 58_000, 70_000, 'After the instruments fall quiet'),
    timedLine('bh-4', 73_000, 86_000, 'The shoreline answers from the hill'),
  ]),
  'shoreline-sleep': null,
};

export const allSongs = albums.flatMap((album) => album.tracks);
