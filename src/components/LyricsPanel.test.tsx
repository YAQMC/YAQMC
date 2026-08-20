import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearArtworkMemoryCache } from '../application/artwork-cache';
import { resetLyricsArtworkFallbackForTests } from '../application/lyrics-artwork-fallback';
import { useLyricsStore } from '../application/lyrics-store';
import { setPlayerCommandAdapter } from '../application/player-command-adapter';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import {
  resetLyricsStageForTests,
  useLyricsStageStore,
} from '../application/lyrics-stage-machine';
import { defaultPreferences, usePreferencesStore } from '../application/preferences';
import {
  applyOverride,
  BUILTIN_CLASSIC_ID,
  BUILTIN_IMMERSIVE_ID,
  BUILTIN_VINYL_ID,
  defaultLyricsPresetState,
  saveAsNewPreset,
} from '../application/lyrics-preset';
import type { LyricDocument } from '../domain/music';
import { allSongs, lyricsBySong } from '../providers/fake/fixtures';
import '../styles/components.css';
import '../styles/lyrics-scene.css';
import '../styles/platform.css';
import { LyricsPanel } from './LyricsPanel';

const nativeArtworkMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('../application/yaqmc-runtime', () => ({
  getHostBridge: () => ({ kind: 'electron' }),
  getYaqmcClient: () => ({
    invoke: nativeArtworkMocks.invoke,
    on: () => () => undefined,
    bridge: { kind: 'electron' },
    host: {
      window: {
        minimize: async () => undefined,
        toggleMaximize: async () => undefined,
        close: async () => undefined,
        setFullscreen: async () => undefined,
      },
      shell: { openExternal: async () => undefined },
    },
  }),
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
    fullscreenError: null,
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

function lyricOffset(container: HTMLElement): number {
  const content = container.querySelector<HTMLElement>('.lyrics-stage__scroll-content');
  const match = /translate3d\(0, (-?[\d.]+)px/.exec(content?.style.transform ?? '');
  return match ? -Number(match[1]) : 0;
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

  const setReducedMotion = (matches: boolean) => {
    reducedMotion = matches;
    const event = { matches } as MediaQueryListEvent;
    mediaListeners.forEach((listener) => listener(event));
  };

  afterEach(() => {
    cleanup();
    resetLyricsStageForTests();
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
    resetLyricsStageForTests();
    resetLyricsArtworkFallbackForTests();
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
      ...defaultPreferences,
      appearance: { ...defaultPreferences.appearance },
      lyrics: { ...defaultPreferences.lyrics },
      lyricsPresets: defaultPreferences.lyricsPresets,
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

  it('enters the lyrics stage with a transform-only compositor animation', () => {
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    const stage = container.querySelector('.lyrics-stage');
    expect(stage).not.toBeNull();

    let fromCss = '';
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSKeyframesRule && rule.name === 'lyrics-stage-enter') {
          fromCss = Array.from(rule.cssRules)
            .map((keyframe) => keyframe.cssText)
            .join(' ');
        }
      }
    }
    expect(fromCss).not.toBe('');
    expect(fromCss).toMatch(/transform/);
    expect(fromCss).not.toMatch(/opacity/);
    expect(stage).toHaveAttribute('data-stage', 'entering');

    act(() => {
      const event = new Event('animationend');
      Object.defineProperty(event, 'animationName', { value: 'lyrics-stage-enter' });
      stage?.dispatchEvent(event);
    });
    expect(stage).toHaveAttribute('data-stage', 'open');
    expect(useLyricsStageStore.getState().stage).toBe('open');
  });

  it('skips the lyrics enter animation when reduced motion is requested', () => {
    reducedMotion = true;
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    expect(container.querySelector('.lyrics-stage')).toHaveAttribute('data-stage', 'open');
  });

  it('exits the lyrics stage with the inverse transform-only compositor animation', () => {
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    const stage = container.querySelector('.lyrics-stage');
    expect(stage).not.toBeNull();

    act(() => {
      const enter = new Event('animationend');
      Object.defineProperty(enter, 'animationName', { value: 'lyrics-stage-enter' });
      stage?.dispatchEvent(enter);
    });
    expect(stage).toHaveAttribute('data-stage', 'open');

    let exitCss = '';
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSKeyframesRule && rule.name === 'lyrics-stage-exit') {
          exitCss = Array.from(rule.cssRules)
            .map((keyframe) => keyframe.cssText)
            .join(' ');
        }
      }
    }
    expect(exitCss).not.toBe('');
    expect(exitCss).toMatch(/transform/);
    expect(exitCss).toMatch(/translateY\(100%\)/);
    expect(exitCss).not.toMatch(/opacity/);

    act(() => {
      usePlayerStore.getState().closePanels();
    });
    const exiting = container.querySelector('.lyrics-stage');
    expect(exiting).toHaveAttribute('data-stage', 'exiting');

    act(() => {
      const exit = new Event('animationend');
      Object.defineProperty(exit, 'animationName', { value: 'lyrics-stage-exit' });
      exiting?.dispatchEvent(exit);
    });
    expect(container.querySelector('.lyrics-stage')).toBeNull();
    expect(useLyricsStageStore.getState().stage).toBe('closed');
  });

  it('ignores a stale enter animationend after close has started exiting', () => {
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    const stage = container.querySelector('.lyrics-stage');
    act(() => {
      const enter = new Event('animationend');
      Object.defineProperty(enter, 'animationName', { value: 'lyrics-stage-enter' });
      stage?.dispatchEvent(enter);
    });

    act(() => {
      usePlayerStore.getState().closePanels();
    });
    const exiting = container.querySelector('.lyrics-stage');
    expect(exiting).toHaveAttribute('data-stage', 'exiting');
    const exitGeneration = useLyricsStageStore.getState().generation;

    act(() => {
      const staleEnter = new Event('animationend');
      Object.defineProperty(staleEnter, 'animationName', { value: 'lyrics-stage-enter' });
      exiting?.dispatchEvent(staleEnter);
    });

    expect(container.querySelector('.lyrics-stage')).toHaveAttribute('data-stage', 'exiting');
    expect(useLyricsStageStore.getState()).toMatchObject({
      stage: 'exiting',
      generation: exitGeneration,
    });
  });

  it('seeks a preview lyric line on the same file clock Core reports', () => {
    const song = allSongs.find((candidate) => candidate.id === 'quiet-light');
    if (!song) throw new Error('quiet-light fixture is missing');
    usePlayerStore.setState({
      queue: [
        {
          ...song,
          durationMs: 193_000,
          playbackCapability: { status: 'preview', startMs: 32_155, endMs: 66_974 },
        },
      ],
      positionMs: 4_360,
      playbackDurationMs: 60_000,
      sourceSelection: {
        requestedQuality: 'automatic',
        resolvedQuality: 'standard',
        fallbackReason: 'preview-only',
        preview: true,
      },
    });

    render(<LyricsPanel {...presentationProps()} />);
    expect(screen.getByRole('slider', { name: 'Playback position' })).toHaveValue('4360');
    expect(screen.getByText('1:00')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /A quiet light across the floor/i }));

    expect(usePlayerStore.getState().positionMs).toBe(18_000);
  });

  it('highlights lyrics from Core position without a try_begin shift', async () => {
    const song = allSongs.find((candidate) => candidate.id === 'quiet-light');
    if (!song) throw new Error('quiet-light fixture is missing');
    usePlayerStore.setState({
      queue: [
        {
          ...song,
          durationMs: 193_000,
          playbackCapability: { status: 'preview', startMs: 32_155, endMs: 66_974 },
        },
      ],
      positionMs: 4_360,
      playbackDurationMs: 60_000,
      observedAtMs: performance.now(),
      sourceSelection: {
        requestedQuality: 'automatic',
        resolvedQuality: 'standard',
        fallbackReason: 'preview-only',
        preview: true,
      },
    });
    useLyricsStore.setState({
      songId: song.id,
      status: 'ready',
      document: lyricsBySong[song.id] ?? null,
      error: null,
    });

    render(<LyricsPanel {...presentationProps()} />);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /The room keeps the shape of the evening/i }),
      ).toHaveAttribute('aria-current', 'true'),
    );
    expect(
      screen.getByRole('button', { name: /Nothing asks to be remembered/i }),
    ).not.toHaveAttribute('aria-current');
  });

  it('renders word timing as text rather than preformatted provider HTML', () => {
    render(<LyricsPanel {...presentationProps()} />);

    const line = screen.getByRole('button', {
      name: 'The room keeps the shape of the evening',
    });
    expect(line.querySelectorAll('.lyrics-word')).toHaveLength(8);
    expect(screen.queryByText('Word synced')).not.toBeInTheDocument();
  });

  it('recenters when the song changes even when the active line index stays the same', async () => {
    const rect = (top: number, height = 50) =>
      ({ top, height, bottom: top + height, left: 0, right: 0, width: 0 }) as DOMRect;
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: vi.fn(function (this: HTMLElement) {
        if (this.classList.contains('lyrics-stage__scroll')) return rect(0, 400);
        if (this.classList.contains('lyrics-stage__scroll-content')) return rect(0, 1_200);
        if (this.hasAttribute('data-line-index')) return rect(600);
        return rect(0, 0);
      }),
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 400,
    });
    usePlayerStore.setState({ positionMs: 5_000 });
    const { container } = render(<LyricsPanel {...presentationProps()} />);

    await waitFor(() => expect(lyricOffset(container)).toBeGreaterThan(0));
    const settled = lyricOffset(container);

    const nextSong = allSongs.find((candidate) => candidate.id !== 'quiet-light');
    if (!nextSong) throw new Error('second song fixture is missing');
    const nextDocument = {
      ...(lyricsBySong['quiet-light'] ?? timedDocument()),
      songId: nextSong.id,
    };
    act(() => {
      usePlayerStore.setState((state) => ({
        queue: [nextSong],
        currentIndex: 0,
        timelineRevision: state.timelineRevision + 1,
      }));
      useLyricsStore.setState({
        songId: nextSong.id,
        status: 'ready',
        document: nextDocument,
        error: null,
      });
    });

    await waitFor(() => expect(lyricOffset(container)).toBeGreaterThan(settled));
  });

  it('clears the previous cursor while an automatically advanced track loads its lyrics', () => {
    usePlayerStore.setState({ positionMs: 19_000, observedAtMs: performance.now() });
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    expect(container.querySelector('[data-active="true"]')).not.toBeNull();

    const nextSong = allSongs.find((candidate) => candidate.id !== 'quiet-light');
    if (!nextSong) throw new Error('second song fixture is missing');
    act(() => {
      usePlayerStore.setState((state) => ({
        queue: [nextSong],
        currentIndex: 0,
        currentQueueEntryId: 'auto-next',
        positionMs: 0,
        observedAtMs: performance.now(),
        timelineRevision: state.timelineRevision + 1,
      }));
      useLyricsStore.getState().startLoading(nextSong.id);
    });

    expect(container.querySelector('[data-active="true"]')).toBeNull();
    expect(screen.getByText('Loading lyrics')).toBeVisible();
  });

  it('does not expose the redundant fullscreen button in either presentation state', () => {
    const props = presentationProps();
    const { rerender } = render(<LyricsPanel {...props} />);

    expect(screen.queryByRole('button', { name: 'Enter fullscreen lyrics' })).toBeNull();
    rerender(<LyricsPanel {...props} fullscreen />);
    expect(screen.queryByRole('button', { name: 'Exit fullscreen lyrics' })).toBeNull();
  });

  it('delegates the collapse button only and leaves visibility to the application callback', () => {
    const props = presentationProps();
    render(<LyricsPanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse lyrics page' }));

    expect(props.onClose).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().lyricsOpen).toBe(true);
  });

  it('exposes semantic presentation state', () => {
    render(<LyricsPanel {...presentationProps({ focus: true, fullscreen: true })} />);

    const stage = screen.getByRole('region', { name: 'Synchronized lyrics' });
    expect(stage).toHaveAttribute('data-focus');
    expect(stage).toHaveAttribute('data-fullscreen');
  });

  it('reveals fullscreen top chrome only at the top edge or from keyboard interaction', () => {
    vi.useFakeTimers();
    render(<LyricsPanel {...presentationProps({ fullscreen: true })} />);

    const stage = screen.getByRole('region', { name: 'Synchronized lyrics' });
    const topbar = document.querySelector('.lyrics-stage__topbar');
    expect(topbar).toHaveAttribute('data-hidden');

    fireEvent.pointerMove(stage, { clientY: 320 });
    expect(topbar).toHaveAttribute('data-hidden');

    fireEvent.pointerMove(stage, { clientY: 20 });
    expect(topbar).not.toHaveAttribute('data-hidden');
    act(() => vi.advanceTimersByTime(2_400));
    expect(topbar).toHaveAttribute('data-hidden');

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(topbar).not.toHaveAttribute('data-hidden');
    act(() => vi.advanceTimersByTime(2_400));
    expect(topbar).toHaveAttribute('data-hidden');
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
    const rect = (top: number, height = 50) =>
      ({ top, height, bottom: top + height, left: 0, right: 0, width: 0 }) as DOMRect;
    const scrollAreaRect = vi.fn(() => rect(0, 400));
    const contentRect = vi.fn(() => rect(0, 1_200));
    const lineRect = vi.fn(() => rect(600));
    const getRect = vi.fn(function (this: HTMLElement) {
      if (this.classList.contains('lyrics-stage__scroll')) return scrollAreaRect();
      if (this.classList.contains('lyrics-stage__scroll-content')) return contentRect();
      if (this.hasAttribute('data-line-index')) return lineRect();
      return rect(0, 0);
    });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: getRect,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 400,
    });

    usePlayerStore.setState({ positionMs: 5_000 });
    const props = presentationProps();
    const { container, rerender } = render(<LyricsPanel {...props} />);
    const scrollArea = container.querySelector<HTMLElement>('.lyrics-stage__scroll');
    if (!scrollArea) throw new Error('lyrics scroll area is missing');

    await waitFor(() => expect(lyricOffset(container)).toBeGreaterThan(0));

    const settled = lyricOffset(container);
    rerender(<LyricsPanel {...props} focus />);
    await waitFor(() => expect(lyricOffset(container)).toBeGreaterThan(settled));

    fireEvent.wheel(scrollArea, { deltaY: 40 });
    const unfollowed = lyricOffset(container);
    rerender(<LyricsPanel {...props} focus fullscreen />);
    expect(lyricOffset(container)).toBe(unfollowed);
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
      expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === expectedDelay)).toHaveLength(
        1,
      );
    },
  );

  it('retains no cursor timer or cursor frame while paused', () => {
    vi.useFakeTimers();
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    usePlayerStore.setState({
      positionMs: 1_100,
      observedAtMs: performance.now(),
      isPlaying: false,
      playbackState: 'paused',
    });
    useLyricsStore.setState({ document: timedDocument(), status: 'ready' });

    const { container } = render(<LyricsPanel {...presentationProps()} />);
    act(() => {
      const stage = container.querySelector('.lyrics-stage');
      const event = new Event('animationend');
      Object.defineProperty(event, 'animationName', { value: 'lyrics-stage-enter' });
      stage?.dispatchEvent(event);
    });
    setTimeoutSpy.mockClear();
    requestFrame.mockClear();

    expect(setTimeoutSpy.mock.calls.filter((call) => (call[1] as number) <= 600)).toHaveLength(0);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('keeps the lyric cursor timer while the document is hidden (PLAY-03)', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    documentHidden = true;
    usePlayerStore.setState({
      positionMs: 1_100,
      observedAtMs: performance.now(),
      isPlaying: true,
      playbackState: 'playing',
    });
    useLyricsStore.setState({ document: timedDocument(), status: 'ready' });

    render(<LyricsPanel {...presentationProps()} />);

    expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 500)).toHaveLength(1);
  });

  it('moves the cursor on seek while hidden without waiting for visibility restore', () => {
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

    expect(screen.getByRole('button', { name: 'Second line' })).toHaveAttribute(
      'aria-current',
      'true',
    );
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

  it('moves a whole Latin word together and keeps non-active lines unhighlighted in jump mode', () => {
    usePreferencesStore.setState((state) => ({
      lyrics: { ...state.lyrics, wordEffect: 'jump' },
    }));
    usePlayerStore.setState({
      positionMs: 1_000,
      observedAtMs: performance.now(),
      isPlaying: false,
      playbackState: 'paused',
    });
    useLyricsStore.setState({
      document: timedDocument({}, true),
      status: 'ready',
    });
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    const jumpWord = container.querySelector<HTMLElement>('.lyrics-word--jump');
    expect(jumpWord).not.toBeNull();
    const characters = jumpWord?.querySelectorAll<HTMLElement>('[data-char-index]') ?? [];
    expect(characters).toHaveLength(1);
    expect(characters[0]).toHaveStyle({ '--char-progress': '0' });

    act(() => usePlayerStore.getState().seek(5_000));

    expect(characters[0]).toHaveStyle({ '--char-progress': '0.5' });
  });

  it('keeps past and upcoming lines plain without jump spans', () => {
    usePreferencesStore.setState((state) => ({
      lyrics: { ...state.lyrics, wordEffect: 'jump' },
    }));
    usePlayerStore.setState({
      positionMs: 1_100,
      observedAtMs: performance.now(),
      isPlaying: false,
      playbackState: 'paused',
    });
    useLyricsStore.setState({ document: timedDocument({}, true), status: 'ready' });
    const { container } = render(<LyricsPanel {...presentationProps()} />);

    expect(container.querySelectorAll('.lyrics-word--jump')).toHaveLength(1);
    const lines = container.querySelectorAll<HTMLElement>('.lyrics-line');
    expect(lines[0]).toHaveAttribute('data-active');
    expect(lines[1]).not.toHaveAttribute('data-active');
    expect(container.querySelectorAll('.lyrics-line[data-active] .lyrics-word--jump')).toHaveLength(
      1,
    );
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

  it('writes current-word progress and keeps a frame while the document is hidden (PLAY-03)', () => {
    documentHidden = true;
    usePlayerStore.setState({
      positionMs: 2_000,
      observedAtMs: performance.now(),
      isPlaying: true,
      playbackState: 'playing',
    });
    useLyricsStore.setState({ document: timedDocument({}, true), status: 'ready' });
    const { container } = render(<LyricsPanel {...presentationProps()} />);

    expect(container.querySelector('.lyrics-word')).not.toHaveStyle({ '--word-progress': '0%' });
    expect(requestAnimationFrame).toHaveBeenCalled();
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

  it('centers a far active multiline lyric and preserves manual follow across later seeks', () => {
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
          : this.classList.contains('lyrics-stage__scroll-content')
            ? 0
            : this.dataset.lineIndex === '2'
              ? 900
              : 200;
        const height = this.classList.contains('lyrics-stage__scroll-content')
          ? 1_200
          : this.dataset.lineIndex === '2'
            ? 100
            : 40;
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
    const scrollArea = container.querySelector<HTMLElement>('.lyrics-stage__scroll');
    if (!scrollArea) throw new Error('lyrics scroll area is missing');

    const runFrames = (count: number) => {
      for (let step = 0; step < count; step += 1) {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(performance.now() + step * 16);
      }
    };
    runFrames(400);
    expect(lyricOffset(container)).toBeCloseTo(710, 0);

    expect(screen.getByText('A secondary line that wraps')).toBeVisible();
    expect(screen.getByText('A second secondary line')).toBeVisible();

    fireEvent.wheel(scrollArea, { deltaY: 40 });
    const unfollowed = lyricOffset(container);
    act(() => usePlayerStore.getState().seek(5_500));
    runFrames(10);
    expect(lyricOffset(container)).toBe(unfollowed);
  });

  it('does not apply live inactive-line blur on Linux auto graphics', async () => {
    document.documentElement.setAttribute('data-platform', 'linux');
    document.documentElement.removeAttribute('data-graphics-mode');
    usePlayerStore.setState({ positionMs: 1_100, isPlaying: false, playbackState: 'paused' });
    useLyricsStore.setState({ document: timedDocument(), status: 'ready' });
    render(<LyricsPanel {...presentationProps()} />);
    const inactive = await screen.findByRole('button', { name: 'Second line' });
    expect(getComputedStyle(inactive).filter).toBe('none');
  });

  it('does not apply live inactive-line blur on Windows', async () => {
    document.documentElement.setAttribute('data-platform', 'windows');
    document.documentElement.removeAttribute('data-graphics-mode');
    usePlayerStore.setState({ positionMs: 1_100, isPlaying: false, playbackState: 'paused' });
    useLyricsStore.setState({ document: timedDocument(), status: 'ready' });
    render(<LyricsPanel {...presentationProps()} />);
    const inactive = await screen.findByRole('button', { name: 'Second line' });
    expect(getComputedStyle(inactive).filter).toBe('none');
  });

  it('does not mount the lyrics stage while the panel is closed', () => {
    usePlayerStore.setState({ lyricsOpen: false });
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    expect(container.querySelector('.lyrics-stage')).toBeNull();
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
      expect(getComputedStyle(inactive).filter).toBe('none');
      expect(getComputedStyle(active).filter).toBe('none');
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
      lyricsPresets: applyOverride(defaultLyricsPresetState, BUILTIN_CLASSIC_ID, {
        background: { fit: 'contain' },
      }),
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
    expect(container.querySelector('.lyrics-stage__control-panel img')).not.toBeInTheDocument();
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

  it('fills built-in presets with the cover artwork behind lyrics', () => {
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    const backdrop = container.querySelector('.lyrics-stage__backdrop') as HTMLElement | null;
    expect(backdrop).not.toBeNull();
    expect(backdrop?.style.backgroundImage).toMatch(/^url\(/);
    expect(backdrop?.style.opacity).toBe('1');
    expect(backdrop?.style.filter).toBe('');
  });

  it('mounts the shared lyrics scene and applies font scale to computed line size', () => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        if (this.classList.contains('lyrics-scene')) return 800;
        if (this.classList.contains('lyrics-stage__scroll')) return 400;
        return 0;
      },
    });
    useLyricsStore.setState({ document: timedDocument(), status: 'ready' });
    usePreferencesStore.setState({
      lyricsPresets: applyOverride(defaultLyricsPresetState, BUILTIN_CLASSIC_ID, {
        typography: { fontScale: 0.7 },
      }),
    });
    const { container, unmount } = render(<LyricsPanel {...presentationProps()} />);
    expect(container.querySelector('[data-lyrics-scene]')).not.toBeNull();
    const small = container.querySelector<HTMLElement>('.lyrics-scene');
    expect(small?.style.getPropertyValue('--lyrics-font-scale')).toBe('0.7');
    expect(small?.style.getPropertyValue('--lyrics-font-size')).toBe('31.36px');
    expect(container.querySelector<HTMLElement>('[data-widget="lyrics"]')?.style.fontSize).toBe(
      '31.36px',
    );
    unmount();

    usePreferencesStore.setState({
      lyricsPresets: applyOverride(defaultLyricsPresetState, BUILTIN_CLASSIC_ID, {
        typography: { fontScale: 1.45 },
      }),
    });
    const again = render(<LyricsPanel {...presentationProps()} />);
    const large = again.container.querySelector<HTMLElement>('.lyrics-scene');
    expect(
      Number.parseFloat(large?.style.getPropertyValue('--lyrics-font-size') ?? '0'),
    ).toBeCloseTo(64.96, 2);
    const smallPx = Number.parseFloat(small?.style.getPropertyValue('--lyrics-font-size') ?? '0');
    const largePx = Number.parseFloat(large?.style.getPropertyValue('--lyrics-font-size') ?? '0');
    expect(largePx / smallPx).toBeGreaterThan(2);
    expect(large?.querySelector<HTMLElement>('[data-widget="lyrics"]')?.style.fontSize).toBe(
      '64.96px',
    );
    expect(small?.style.getPropertyValue('--lyrics-line-gap')).toBe('0.75cqh');
    expect(large?.style.getPropertyValue('--lyrics-line-gap')).toBe('0.75cqh');
  });

  it('cycles a saved custom full preset from the cover button', () => {
    const created = saveAsNewPreset(defaultLyricsPresetState, BUILTIN_IMMERSIVE_ID, {
      name: 'Studio',
    });
    usePreferencesStore.setState({
      lyricsPresets: { ...created.state, selectedId: BUILTIN_CLASSIC_ID },
    });
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    const stage = container.querySelector('.lyrics-stage');
    expect(stage).toHaveAttribute('data-cover-layout', 'split');

    fireEvent.click(screen.getByRole('button', { name: 'Full-window cover' }));
    expect(usePreferencesStore.getState().lyricsPresets.selectedId).toBe(BUILTIN_IMMERSIVE_ID);
    expect(stage).toHaveAttribute('data-cover-layout', 'full');

    fireEvent.click(screen.getByRole('button', { name: 'Studio' }));
    expect(usePreferencesStore.getState().lyricsPresets.selectedId).toBe(created.id);
    expect(stage).toHaveAttribute('data-cover-layout', 'full');

    fireEvent.click(screen.getByRole('button', { name: 'Vinyl record' }));
    expect(usePreferencesStore.getState().lyricsPresets.selectedId).toBe(BUILTIN_VINYL_ID);
    expect(stage).toHaveAttribute('data-cover-layout', 'vinyl');
  });

  it('suspends follow on wheel and forces resume without a line change', async () => {
    const rect = (top: number, height = 50) =>
      ({ top, height, bottom: top + height, left: 0, right: 0, width: 0 }) as DOMRect;
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) {
        if (this.classList.contains('lyrics-stage__scroll')) return rect(0, 400);
        if (this.classList.contains('lyrics-stage__scroll-content')) return rect(0, 1_200);
        if (this.hasAttribute('data-line-index')) return rect(200);
        return rect(0, 0);
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 400,
    });
    usePlayerStore.setState({ positionMs: 1_100, isPlaying: false, playbackState: 'paused' });
    useLyricsStore.setState({ document: timedDocument(), status: 'ready' });
    const { container } = render(<LyricsPanel {...presentationProps()} />);
    const scrollArea = container.querySelector<HTMLElement>('.lyrics-stage__scroll');
    if (!scrollArea) throw new Error('lyrics scroll area is missing');
    await waitFor(() => expect(lyricOffset(container)).toBeGreaterThanOrEqual(0));

    fireEvent.pointerDown(scrollArea);
    expect(screen.queryByRole('button', { name: 'Follow current line' })).not.toBeInTheDocument();

    fireEvent.wheel(scrollArea, { deltaY: 80 });
    const suspended = lyricOffset(container);
    expect(screen.getByRole('button', { name: 'Follow current line' })).toBeVisible();

    act(() => usePlayerStore.setState({ positionMs: 5_500, timelineRevision: 2 }));
    expect(lyricOffset(container)).toBe(suspended);

    fireEvent.click(screen.getByRole('button', { name: 'Follow current line' }));
    await waitFor(() => expect(lyricOffset(container)).not.toBe(suspended));
    expect(screen.queryByRole('button', { name: 'Follow current line' })).not.toBeInTheDocument();
  });
});
