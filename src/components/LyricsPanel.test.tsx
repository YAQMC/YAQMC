import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearArtworkMemoryCache } from '../application/artwork-cache';
import { useLyricsStore } from '../application/lyrics-store';
import { setPlayerCommandAdapter } from '../application/player-command-adapter';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { defaultPreferences, usePreferencesStore } from '../application/preferences';
import type { LyricDocument } from '../domain/music';
import { allSongs, lyricsBySong } from '../providers/fake/fixtures';
import '../styles/components.css';
import '../styles/platform.css';
import { LyricsPanel } from './LyricsPanel';

const nativeArtworkMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: nativeArtworkMocks.invoke,
  isTauri: () => true,
}));

const safeArtwork = 'data:image/png;base64,AA==';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function presentationProps(overrides: Partial<React.ComponentProps<typeof LyricsPanel>> = {}) {
  return {
    focus: false,
    fullscreen: false,
    fullscreenPending: false,
    fullscreenError: null,
    onToggleFocus: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function timedDocument(overrides: Partial<LyricDocument> = {}, wordTimed = false): LyricDocument {
  return {
    songId: 'quiet-light',
    syncMode: wordTimed ? 'word' : 'line',
    metadata: { sourceLabel: 'test', offsetMs: 0 },
    vocalists: [],
    lines: [
      {
        id: 'one',
        text: 'First line',
        startMs: 1_000,
        endMs: wordTimed ? 9_000 : 2_000,
        words: wordTimed ? [{ text: 'Long word', startMs: 1_000, endMs: 9_000 }] : [],
      },
      { id: 'two', text: 'Second line', startMs: 5_000, endMs: 7_000, words: [] },
    ],
    ...overrides,
  };
}

describe('LyricsPanel', () => {
  let scrollToDescriptor: PropertyDescriptor | undefined;
  let getBoundingClientRectDescriptor: PropertyDescriptor | undefined;
  let clientHeightDescriptor: PropertyDescriptor | undefined;
  let hiddenDescriptor: PropertyDescriptor | undefined;
  let visibilityStateDescriptor: PropertyDescriptor | undefined;
  let documentHidden = false;
  let reducedMotion = false;
  let mediaListeners: Set<(event: MediaQueryListEvent) => void>;
  let previousPlatform: string | null;
  let previousGraphicsMode: string | null;

  const setDocumentHidden = (hidden: boolean) => {
    documentHidden = hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  const setReducedMotion = (matches: boolean) => {
    reducedMotion = matches;
    const event = { matches } as MediaQueryListEvent;
    mediaListeners.forEach((listener) => listener(event));
  };

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearArtworkMemoryCache();
    if (scrollToDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    }
    if (getBoundingClientRectDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        'getBoundingClientRect',
        getBoundingClientRectDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect');
    }
    if (clientHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDescriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    }
    if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor);
    else Reflect.deleteProperty(document, 'hidden');
    if (visibilityStateDescriptor) {
      Object.defineProperty(document, 'visibilityState', visibilityStateDescriptor);
    } else {
      Reflect.deleteProperty(document, 'visibilityState');
    }
    if (previousPlatform === null) document.documentElement.removeAttribute('data-platform');
    else document.documentElement.setAttribute('data-platform', previousPlatform);
    if (previousGraphicsMode === null)
      document.documentElement.removeAttribute('data-graphics-mode');
    else document.documentElement.setAttribute('data-graphics-mode', previousGraphicsMode);
  });

  beforeEach(() => {
    nativeArtworkMocks.invoke.mockReset();
    nativeArtworkMocks.invoke.mockResolvedValue(safeArtwork);
    clearArtworkMemoryCache();
    scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    getBoundingClientRectDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'getBoundingClientRect',
    );
    clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
    visibilityStateDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    previousPlatform = document.documentElement.getAttribute('data-platform');
    previousGraphicsMode = document.documentElement.getAttribute('data-graphics-mode');
    documentHidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => documentHidden,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (documentHidden ? 'hidden' : 'visible'),
    });
    reducedMotion = false;
    mediaListeners = new Set();
    setPlayerCommandAdapter(null);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'matchMedia',
      vi.fn(
        () =>
          ({
            get matches() {
              return reducedMotion;
            },
            media: '(prefers-reduced-motion: reduce)',
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(
              (_type: string, listener: (event: MediaQueryListEvent) => void) =>
                mediaListeners.add(listener),
            ),
            removeEventListener: vi.fn(
              (_type: string, listener: (event: MediaQueryListEvent) => void) =>
                mediaListeners.delete(listener),
            ),
            dispatchEvent: vi.fn(() => true),
          }) as MediaQueryList,
      ),
    );

    const song = allSongs.find((candidate) => candidate.id === 'quiet-light');
    if (!song) throw new Error('quiet-light fixture is missing');
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [song],
      currentIndex: 0,
      lyricsOpen: true,
    });
    useLyricsStore.setState({
      songId: song.id,
      status: 'ready',
      document: lyricsBySong[song.id] ?? null,
      error: null,
    });
    usePreferencesStore.setState({
      appearance: { ...defaultPreferences.appearance },
      lyrics: { ...defaultPreferences.lyrics },
      backgroundImageData: null,
      backgroundImageMissing: false,
    });
  });

  it.each([false, true])(
    'seeks through the shared player contract when a timed line is clicked with focus=%s',
    (focus) => {
      render(<LyricsPanel {...presentationProps({ focus })} />);

      fireEvent.click(screen.getByRole('button', { name: /A quiet light across the floor/i }));

      expect(usePlayerStore.getState().positionMs).toBe(18_000);
    },
  );

  it('renders word timing as text rather than preformatted provider HTML', () => {
    render(<LyricsPanel {...presentationProps()} />);

    const line = screen.getByRole('button', {
      name: 'The room keeps the shape of the evening',
    });
    expect(line.querySelectorAll('.lyrics-word')).toHaveLength(8);
    expect(screen.getByText('Word synced')).toBeVisible();
  });

  it('delegates focus and fullscreen controls and updates their accessible labels', () => {
    const props = presentationProps();
    const { rerender } = render(<LyricsPanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide navigation' }));
    expect(props.onToggleFocus).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen lyrics' }));
    expect(props.onToggleFullscreen).toHaveBeenCalledOnce();

    rerender(<LyricsPanel {...props} focus fullscreen />);
    expect(screen.getByRole('button', { name: 'Show navigation' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Exit fullscreen lyrics' })).toBeVisible();
  });

  it('delegates the close button only and leaves visibility to the application callback', () => {
    const props = presentationProps();
    render(<LyricsPanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close lyrics' }));

    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onToggleFocus).not.toHaveBeenCalled();
    expect(props.onToggleFullscreen).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().lyricsOpen).toBe(true);
  });

  it('exposes semantic presentation state and disables fullscreen while pending', () => {
    render(
      <LyricsPanel
        {...presentationProps({ focus: true, fullscreen: true, fullscreenPending: true })}
      />,
    );

    const stage = screen.getByRole('region', { name: 'Synchronized lyrics' });
    expect(stage).toHaveAttribute('data-focus');
    expect(stage).toHaveAttribute('data-fullscreen');
    expect(screen.getByRole('button', { name: 'Exit fullscreen lyrics' })).toBeDisabled();
  });

  it('does not mount the compact transport outside fullscreen', () => {
    render(<LyricsPanel {...presentationProps()} />);

    expect(screen.queryByRole('group', { name: 'Music player' })).not.toBeInTheDocument();
  });

  it('reveals hidden fullscreen transport from stage movement without breaking controls or seek', () => {
    vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    usePlayerStore.setState({ isPlaying: true, playbackState: 'playing' });
    const props = presentationProps({ fullscreen: true });
    render(<LyricsPanel {...props} />);

    const stage = screen.getByRole('region', { name: 'Synchronized lyrics' });
    const transport = screen.getByRole('group', { name: 'Music player' });
    act(() => vi.advanceTimersByTime(2_400));
    expect(transport).not.toHaveAttribute('data-visible');

    fireEvent.pointerMove(stage);
    expect(transport).toHaveAttribute('data-visible', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Hide navigation' }));
    expect(props.onToggleFocus).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: /A quiet light across the floor/i }));
    expect(usePlayerStore.getState().positionMs).toBe(18_000);

    act(() => vi.advanceTimersByTime(2_400));
    expect(transport).not.toHaveAttribute('data-visible');
  });

  it('renders only a localized fullscreen failure status without exposing the native error', () => {
    const nativeError = 'native fullscreen denial: secret compositor detail';
    render(<LyricsPanel {...presentationProps({ fullscreenError: nativeError })} />);

    expect(screen.getByRole('status')).toHaveTextContent('Fullscreen could not be changed.');
    expect(screen.queryByText(nativeError)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(nativeError)).not.toBeInTheDocument();
    expect(screen.queryByTitle(nativeError)).not.toBeInTheDocument();
  });

  it('recenters on presentation changes only while lyric following remains active', async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    usePlayerStore.setState({ positionMs: 5_000 });
    const props = presentationProps();
    const { container, rerender } = render(<LyricsPanel {...props} />);

    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    scrollTo.mockClear();
    rerender(<LyricsPanel {...props} focus />);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledOnce());

    const scrollArea = container.querySelector('.lyrics-stage__scroll');
    if (!scrollArea) throw new Error('lyrics scroll area is missing');
    fireEvent.wheel(scrollArea);
    scrollTo.mockClear();
    rerender(<LyricsPanel {...props} focus fullscreen />);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it.each([
    { positionMs: 1_100, expectedDelay: 500 },
    { positionMs: 1_999, expectedDelay: 16 },
  ])(
    'uses one bounded boundary timeout instead of cursor animation-frame polling at $positionMs ms',
    ({ positionMs, expectedDelay }) => {
      vi.useFakeTimers();
      const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
      const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
      usePlayerStore.setState({
        positionMs,
        observedAtMs: performance.now(),
        isPlaying: true,
        playbackState: 'playing',
      });
      useLyricsStore.setState({ document: timedDocument(), status: 'ready' });

      render(<LyricsPanel {...presentationProps()} />);

      expect(requestFrame).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === expectedDelay)).toBe(true);
    },
  );

  it.each([
    { label: 'paused', hidden: false, isPlaying: false },
    { label: 'hidden', hidden: true, isPlaying: true },
  ])('retains no cursor timer or cursor frame while $label', ({ hidden, isPlaying }) => {
    vi.useFakeTimers();
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    documentHidden = hidden;
    usePlayerStore.setState({
      positionMs: 1_100,
      observedAtMs: performance.now(),
      isPlaying,
      playbackState: isPlaying ? 'playing' : 'paused',
    });
    useLyricsStore.setState({ document: timedDocument(), status: 'ready' });

    render(<LyricsPanel {...presentationProps()} />);

    expect(vi.getTimerCount()).toBe(0);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('corrects the cursor immediately on visibility restore and schedules one fresh timeout', () => {
    vi.useFakeTimers();
    documentHidden = true;
    usePlayerStore.setState({
      positionMs: 1_100,
      observedAtMs: performance.now(),
      isPlaying: true,
      playbackState: 'playing',
    });
    useLyricsStore.setState({ document: timedDocument(), status: 'ready' });
    render(<LyricsPanel {...presentationProps()} />);

    act(() => usePlayerStore.getState().seek(5_500));
    act(() => setDocumentHidden(false));

    expect(screen.getByRole('button', { name: 'Second line' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(vi.getTimerCount()).toBe(1);
  });

  it('wakes a paused cursor immediately when timeline revision changes', () => {
    usePlayerStore.setState({
      positionMs: 1_100,
      observedAtMs: performance.now(),
      isPlaying: false,
      playbackState: 'paused',
    });
    useLyricsStore.setState({ document: timedDocument(), status: 'ready' });
    render(<LyricsPanel {...presentationProps()} />);
    expect(screen.getByRole('button', { name: 'First line' })).toHaveAttribute(
      'aria-current',
      'true',
    );

    act(() => usePlayerStore.getState().seek(5_500));

    expect(screen.getByRole('button', { name: 'Second line' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('recomputes paused progress after a seek inside the same long word', () => {
    usePlayerStore.setState({
      positionMs: 2_000,
      observedAtMs: performance.now(),
      isPlaying: false,
      playbackState: 'paused',
    });
    useLyricsStore.setState({ document: timedDocument({}, true), status: 'ready' });
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    const word = container.querySelector<HTMLElement>('.lyrics-word');
    expect(word).toHaveStyle({ '--word-progress': '12.5%' });

    act(() => usePlayerStore.getState().seek(5_000));

    expect(word).toHaveStyle({ '--word-progress': '50%' });
  });

  it('switches the current word to discrete completion without a frame when reduced motion changes', () => {
    let nextFrame = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextFrame;
        frames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => frames.delete(id)),
    );
    usePlayerStore.setState({
      positionMs: 2_000,
      observedAtMs: performance.now(),
      isPlaying: true,
      playbackState: 'playing',
    });
    useLyricsStore.setState({ document: timedDocument({}, true), status: 'ready' });
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    const word = container.querySelector<HTMLElement>('.lyrics-word');
    expect(frames.size).toBe(1);

    act(() => setReducedMotion(true));

    expect(word).toHaveStyle({ '--word-progress': '100%' });
    expect(frames.size).toBe(0);
  });

  it('does not write current-word progress or retain a frame while the document is hidden', () => {
    documentHidden = true;
    usePlayerStore.setState({
      positionMs: 2_000,
      observedAtMs: performance.now(),
      isPlaying: true,
      playbackState: 'playing',
    });
    useLyricsStore.setState({ document: timedDocument({}, true), status: 'ready' });
    const { container } = render(<LyricsPanel {...presentationProps()} />);

    expect(container.querySelector('.lyrics-word')).toHaveStyle({ '--word-progress': '0%' });
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('does not commit for a content-equivalent ordinary native position snapshot', async () => {
    usePlayerStore.setState({
      positionMs: 1_100,
      observedAtMs: performance.now(),
      isPlaying: false,
      playbackState: 'paused',
      playbackDurationMs: 252_000,
    });
    useLyricsStore.setState({ document: timedDocument(), status: 'ready' });
    const onRender = vi.fn();
    render(
      <Profiler id="lyrics" onRender={onRender}>
        <LyricsPanel {...presentationProps()} />
      </Profiler>,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'First line' })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    );
    const commitsBeforeSnapshot = onRender.mock.calls.length;
    const state = usePlayerStore.getState();

    act(() =>
      state.applyExternalSnapshot({
        queue: state.queue.map((song) => ({
          ...song,
          artists: song.artists.map((artist) => ({ ...artist })),
          artwork: { ...song.artwork },
        })),
        currentIndex: state.currentIndex,
        positionMs: state.positionMs,
        isPlaying: state.isPlaying,
        volume: state.volume,
        isMuted: state.isMuted,
        repeat: state.repeat,
        shuffle: state.shuffle,
        playbackState: state.playbackState,
        playbackDurationMs: state.playbackDurationMs,
        playbackError: state.playbackError,
      }),
    );

    expect(onRender).toHaveBeenCalledTimes(commitsBeforeSnapshot);
  });

  it('does not render a stale lyric document whose song ID differs from the current track', () => {
    useLyricsStore.setState({
      document: timedDocument({ songId: 'another-track' }),
      status: 'ready',
    });

    render(<LyricsPanel {...presentationProps()} />);

    expect(screen.queryByRole('button', { name: 'First line' })).not.toBeInTheDocument();
    expect(screen.getByText('No lyrics found')).toBeVisible();
  });

  it('uses document and presentation offsets together for click seek', () => {
    usePreferencesStore.setState({
      lyrics: { ...defaultPreferences.lyrics, timingOffsetMs: 200 },
    });
    const lyrics = lyricsBySong['quiet-light'];
    if (!lyrics) throw new Error('quiet-light lyrics fixture is missing');
    useLyricsStore.setState({
      document: { ...lyrics, metadata: { ...lyrics.metadata, offsetMs: 300 } },
      status: 'ready',
    });
    render(<LyricsPanel {...presentationProps()} />);

    fireEvent.click(screen.getByRole('button', { name: /A quiet light across the floor/i }));

    expect(usePlayerStore.getState().positionMs).toBe(18_100);
  });

  it('centers a far active multiline lyric and preserves manual follow across later seeks', async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return this.classList.contains('lyrics-stage__scroll') ? 400 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) {
        const top = this.classList.contains('lyrics-stage__scroll')
          ? 100
          : this.dataset.lineIndex === '2'
            ? 900
            : 200;
        const height = this.dataset.lineIndex === '2' ? 100 : 40;
        return {
          x: 0,
          y: top,
          top,
          right: 100,
          bottom: top + height,
          left: 0,
          width: 100,
          height,
          toJSON: () => ({}),
        };
      },
    });
    usePlayerStore.setState({ positionMs: 9_500, isPlaying: false, playbackState: 'paused' });
    usePreferencesStore.setState({
      lyrics: {
        ...defaultPreferences.lyrics,
        translation: 'show',
        romanization: 'show',
      },
    });
    useLyricsStore.setState({
      document: timedDocument({
        lines: [
          { id: 'one', text: 'One', startMs: 1_000, endMs: 2_000, words: [] },
          { id: 'two', text: 'Two', startMs: 5_000, endMs: 6_000, words: [] },
          {
            id: 'three',
            text: 'Three',
            translation: 'A secondary line that wraps',
            romanization: 'A second secondary line',
            startMs: 9_000,
            endMs: 10_000,
            words: [],
          },
        ],
      }),
      status: 'ready',
    });
    const { container } = render(<LyricsPanel {...presentationProps()} />);

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 650, behavior: 'smooth' }));
    expect(screen.getByText('A secondary line that wraps')).toBeVisible();
    expect(screen.getByText('A second secondary line')).toBeVisible();

    const scrollArea = container.querySelector('.lyrics-stage__scroll');
    if (!scrollArea) throw new Error('lyrics scroll area is missing');
    fireEvent.wheel(scrollArea);
    scrollTo.mockClear();
    act(() => usePlayerStore.getState().seek(5_500));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it.each(['software', 'safe'])(
    'contains lyric lines and removes only active scale in Linux %s mode',
    async (graphicsMode) => {
      document.documentElement.setAttribute('data-platform', 'linux');
      document.documentElement.setAttribute('data-graphics-mode', graphicsMode);
      usePlayerStore.setState({ positionMs: 1_100, isPlaying: false, playbackState: 'paused' });
      useLyricsStore.setState({ document: timedDocument(), status: 'ready' });
      render(<LyricsPanel {...presentationProps()} />);
      const active = await screen.findByRole('button', { name: 'First line' });
      const inactive = screen.getByRole('button', { name: 'Second line' });

      expect(getComputedStyle(active).transform).toBe('translateX(7px)');
      expect(getComputedStyle(active).getPropertyValue('content-visibility')).toBe('visible');
      expect(getComputedStyle(inactive).getPropertyValue('content-visibility')).toBe('auto');
      expect(getComputedStyle(inactive).contain).toBe('layout paint style');
    },
  );

  it('projects persisted image and color backgrounds without remounting the lyrics stage', () => {
    const managedImage = 'data:image/webp;base64,AQ==';
    usePreferencesStore.setState({
      appearance: {
        ...defaultPreferences.appearance,
        backgroundMode: 'image',
        backgroundFit: 'contain',
      },
      backgroundImageData: managedImage,
    });
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    const stage = screen.getByRole('region', { name: 'Synchronized lyrics' });

    expect(stage).toHaveAttribute('data-background-mode', 'image');
    expect(stage).toHaveAttribute('data-image-fit', 'contain');
    expect(stage).toHaveAttribute('data-song-id', 'quiet-light');
    expect(container.querySelector('.lyrics-stage__backdrop')).toHaveStyle({
      backgroundImage: `url("${managedImage}")`,
    });

    act(() =>
      usePreferencesStore.setState((state) => ({
        appearance: {
          ...state.appearance,
          backgroundMode: 'color',
          backgroundColor: '#abc',
        },
      })),
    );

    expect(screen.getByRole('region', { name: 'Synchronized lyrics' })).toBe(stage);
    expect(stage).toHaveAttribute('data-background-mode', 'color');
    expect(stage.style.backgroundColor).toBe('rgb(170, 187, 204)');
    expect(stage.style.getPropertyValue('--lyrics-stage-base')).toBe('#AABBCC');
    expect(container.querySelector('.lyrics-stage__backdrop')).not.toBeInTheDocument();
  });

  it('keeps native remote artwork out of every Lyrics DOM surface while caching is pending', async () => {
    const pending = deferred<unknown>();
    const remote = 'https://qpic.y.qq.com/private-pending.jpg';
    nativeArtworkMocks.invoke.mockReturnValue(pending.promise);
    const current = usePlayerStore.getState().queue[0];
    if (!current) throw new Error('current fixture is missing');
    usePlayerStore.setState({
      queue: [{ ...current, artwork: { ...current.artwork, src: remote } }],
    });
    usePreferencesStore.setState((state) => ({
      appearance: { ...state.appearance, backgroundMode: 'artwork' },
    }));
    const { container } = render(<LyricsPanel {...presentationProps({ fullscreen: true })} />);

    await waitFor(() =>
      expect(nativeArtworkMocks.invoke).toHaveBeenCalledWith('qqmusic_cache_artwork', {
        url: remote,
      }),
    );
    expect(container.innerHTML).not.toContain(remote);
    expect(container.querySelector('.lyrics-stage__backdrop')).not.toBeInTheDocument();
    expect(container.querySelector('.lyrics-stage__track img')).not.toBeInTheDocument();
    expect(container.querySelector('.lyrics-fullscreen-transport img')).not.toBeInTheDocument();

    await act(async () => pending.resolve(safeArtwork));
    await waitFor(() =>
      expect(container.querySelector('.lyrics-stage__backdrop')).toHaveStyle({
        backgroundImage: `url("${safeArtwork}")`,
      }),
    );
    for (const image of container.querySelectorAll('img')) {
      expect(image).toHaveAttribute('src', safeArtwork);
    }
    expect(container.innerHTML).not.toContain(remote);
  });

  it('keeps failed native remote artwork out of Lyrics DOM without a raw fallback', async () => {
    const remote = 'https://y.gtimg.cn/private-failed.jpg';
    nativeArtworkMocks.invoke.mockRejectedValue(new Error('cache failed'));
    const current = usePlayerStore.getState().queue[0];
    if (!current) throw new Error('current fixture is missing');
    usePlayerStore.setState({
      queue: [{ ...current, artwork: { ...current.artwork, src: remote } }],
    });
    usePreferencesStore.setState((state) => ({
      appearance: { ...state.appearance, backgroundMode: 'artwork' },
    }));
    const { container } = render(<LyricsPanel {...presentationProps({ fullscreen: true })} />);

    await waitFor(() => expect(nativeArtworkMocks.invoke).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(container.innerHTML).not.toContain(remote);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('.lyrics-stage__backdrop')).not.toBeInTheDocument();
  });

  it('tracks the primitive current song ID without retaining a stale fixture identity', () => {
    const next = allSongs.find((candidate) => candidate.id === 'paper-sun');
    if (!next) throw new Error('paper-sun fixture is missing');
    render(<LyricsPanel {...presentationProps()} />);
    const stage = screen.getByRole('region', { name: 'Synchronized lyrics' });
    expect(stage).toHaveAttribute('data-song-id', 'quiet-light');

    act(() => usePlayerStore.setState({ queue: [next], currentIndex: 0 }));

    expect(stage).toHaveAttribute('data-song-id', 'paper-sun');
  });
});
