import { memo, useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  AlignLeft,
  ChevronDown,
  Heart,
  Image,
  LocateFixed,
  Maximize2,
  Minimize2,
  Music2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { useAccountStore, useFavoriteState } from '../application/account-runtime';
import { useLyricsStore } from '../application/lyrics-store';
import {
  emptyLyricCursor,
  lastSungLineIndex,
  lyricInterludeRemainingMs,
  nextLyricBoundaryMs,
  selectLyricCursor,
  wordProgress,
  type LyricCursor,
} from '../application/lyrics-timing';
import { getEstimatedPositionMs, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import { isAccountMusicProvider } from '../providers/music-provider';
import type { LyricDocument, LyricLine, LyricWord } from '../domain/music';
import { formatDuration, joinArtistNames } from '../utils/format';
import { IconButton } from './ui/IconButton';
import { useTranslation } from 'react-i18next';
import { usePreferencesStore, type SecondaryLyricVisibility } from '../application/preferences';
import { shouldShowLyricSecondary } from '../application/lyrics-presentation';
import { resolveLyricsAppearance } from '../application/lyrics-appearance';
import { useSafeArtworkSource } from '../application/artwork-source';
import { useBlurredArtwork } from '../application/blurred-artwork';
import {
  lyricsArtworkFallback,
  lyricsBlurredBackdropFallback,
  rememberLyricsArtwork,
  rememberLyricsBlurredBackdrop,
} from '../application/lyrics-artwork-fallback';
import {
  LyricsFullscreenTransport,
  type LyricsFullscreenTransportHandle,
} from './LyricsFullscreenTransport';

type LyricsStyle = CSSProperties & {
  '--lyrics-color': string;
  '--lyrics-ink': string;
  '--lyrics-ink-contrast': string;
  '--lyrics-stage-base': string;
};

function coverInk(hexColor: string): { ink: string; contrast: string } {
  const normalized = hexColor.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return { ink: '#ffffff', contrast: '#10140c' };
  }
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance > 0.62
    ? { ink: '#171a12', contrast: '#ffffff' }
    : { ink: '#ffffff', contrast: '#10140c' };
}

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reducedMotion;
}

interface LyricPosition {
  cursor: LyricCursor;
  lastSungLineIndex: number;
  interludeRemainingMs: number | null;
}

function useLyricCursor(
  lyricDocument: LyricDocument | null,
  presentationOffsetMs: number,
  timelineRevision: number,
  isPlaying: boolean,
): LyricPosition {
  const [position, setPosition] = useState<LyricPosition>({
    cursor: emptyLyricCursor,
    lastSungLineIndex: -1,
    interludeRemainingMs: null,
  });

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      generation += 1;
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };

    const update = () => {
      clearTimer();
      if (cancelled) return;
      if (!lyricDocument) {
        setPosition((previous) =>
          previous.cursor === emptyLyricCursor &&
          previous.lastSungLineIndex === -1 &&
          previous.interludeRemainingMs === null
            ? previous
            : {
                cursor: emptyLyricCursor,
                lastSungLineIndex: -1,
                interludeRemainingMs: null,
              },
        );
        return;
      }

      const rawPositionMs = getEstimatedPositionMs() + presentationOffsetMs;
      const nextCursor = selectLyricCursor(lyricDocument, rawPositionMs);
      const nextLastSung = lastSungLineIndex(lyricDocument, rawPositionMs);
      const nextInterlude = lyricInterludeRemainingMs(lyricDocument, rawPositionMs);
      setPosition((previous) =>
        previous.cursor.lineIndex === nextCursor.lineIndex &&
        previous.cursor.wordIndex === nextCursor.wordIndex &&
        previous.cursor.line === nextCursor.line &&
        previous.cursor.word === nextCursor.word &&
        previous.lastSungLineIndex === nextLastSung &&
        previous.interludeRemainingMs === nextInterlude
          ? previous
          : {
              cursor: nextCursor,
              lastSungLineIndex: nextLastSung,
              interludeRemainingMs: nextInterlude,
            },
      );

      if (!isPlaying || globalThis.document.hidden) return;
      const rawBoundary = nextLyricBoundaryMs(lyricDocument, rawPositionMs);
      if (rawBoundary === null) return;
      const delayMs = Math.min(500, Math.max(16, rawBoundary - rawPositionMs + 8));
      const scheduledGeneration = ++generation;
      timer = setTimeout(() => {
        if (cancelled || scheduledGeneration !== generation) return;
        timer = null;
        update();
      }, delayMs);
    };

    const handleVisibilityChange = () => {
      clearTimer();
      if (!globalThis.document.hidden) update();
    };

    update();
    globalThis.document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      clearTimer();
      globalThis.document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isPlaying, lyricDocument, presentationOffsetMs, timelineRevision]);

  return position;
}

interface ScrollSpring {
  frame: number | null;
  cancel: () => void;
}

interface LyricScrollState {
  offset: number;
  spring: ScrollSpring | null;
}

const scrollStates = new WeakMap<Element, LyricScrollState>();

function scrollStateFor(scrollArea: Element): LyricScrollState {
  let state = scrollStates.get(scrollArea);
  if (!state) {
    state = { offset: 0, spring: null };
    scrollStates.set(scrollArea, state);
  }
  return state;
}

function cancelScrollSpring(scrollArea: Element | null): void {
  if (!scrollArea) return;
  scrollStateFor(scrollArea).spring?.cancel();
  const state = scrollStates.get(scrollArea);
  if (state) state.spring = null;
}

const SPRING_STIFFNESS = 120;
const SPRING_DAMPING = 15;
const SPRING_MASS = 1;
const SPRING_STEP_SECONDS = 1 / 60;

function setLyricOffset(scrollArea: HTMLDivElement, content: HTMLDivElement, offset: number): void {
  const state = scrollStateFor(scrollArea);
  state.offset = offset;
  content.style.transform = `translate3d(0, ${-offset.toFixed(2)}px, 0)`;
}

function lyricScrollBounds(scrollArea: HTMLDivElement, content: HTMLDivElement): number {
  return Math.max(0, content.getBoundingClientRect().height - scrollArea.clientHeight);
}

function springScrollTo(
  scrollArea: HTMLDivElement,
  content: HTMLDivElement,
  targetOffset: number,
): void {
  cancelScrollSpring(scrollArea);
  const state = scrollStateFor(scrollArea);
  if (Math.abs(targetOffset - state.offset) < 1) return;
  let position = state.offset;
  let velocity = 0;
  let frame: number | null = null;

  const cancel = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    state.spring = null;
  };

  const step = () => {
    frame = null;
    const acceleration =
      (-SPRING_STIFFNESS * (position - targetOffset) - SPRING_DAMPING * velocity) / SPRING_MASS;
    velocity += acceleration * SPRING_STEP_SECONDS;
    position += velocity * SPRING_STEP_SECONDS;
    setLyricOffset(scrollArea, content, position);
    if (Math.abs(position - targetOffset) > 0.6 || Math.abs(velocity) > 0.6) {
      frame = window.requestAnimationFrame(step);
    } else {
      setLyricOffset(scrollArea, content, targetOffset);
      cancel();
    }
  };

  state.spring = { frame, cancel };
  step();
}

const LYRIC_ALIGN = 0.35;

function centerLyricLine(
  scrollArea: HTMLDivElement | null,
  content: HTMLDivElement | null,
  lineIndex: number,
  reducedMotion: boolean,
): void {
  if (!scrollArea || !content || lineIndex < 0) return;
  const line = content.querySelector<HTMLElement>(`[data-line-index="${lineIndex}"]`);
  if (!line) return;
  const areaRect = scrollArea.getBoundingClientRect();
  const previousContentVisibility = line.style.getPropertyValue('content-visibility');
  line.style.setProperty('content-visibility', 'visible');
  const lineRect = line.getBoundingClientRect();
  if (previousContentVisibility) {
    line.style.setProperty('content-visibility', previousContentVisibility);
  } else {
    line.style.removeProperty('content-visibility');
  }
  const state = scrollStateFor(scrollArea);
  const top =
    state.offset +
    lineRect.top -
    areaRect.top -
    scrollArea.clientHeight * LYRIC_ALIGN +
    lineRect.height / 2;
  const target = Math.min(Math.max(0, top), lyricScrollBounds(scrollArea, content));
  if (reducedMotion) {
    setLyricOffset(scrollArea, content, target);
    return;
  }
  springScrollTo(scrollArea, content, target);
}

function SyncedWord({
  word,
  state,
  offsetMs,
  isPlaying,
  reducedMotion,
  timelineRevision,
}: {
  word: LyricWord;
  state: 'future' | 'current' | 'complete';
  offsetMs: number;
  isPlaying: boolean;
  reducedMotion: boolean;
  timelineRevision: number;
}) {
  const element = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (state !== 'current') return;
    if (reducedMotion) return;
    let frame: number | null = null;

    const updateProgress = () => {
      const progress = wordProgress(word, getEstimatedPositionMs() - offsetMs);
      element.current?.style.setProperty('--word-progress', `${progress * 100}%`);
    };

    const cancelFrame = () => {
      if (frame === null) return;
      window.cancelAnimationFrame(frame);
      frame = null;
    };

    const updateFrame = () => {
      frame = null;
      if (document.hidden) return;
      updateProgress();
      frame = window.requestAnimationFrame(updateFrame);
    };

    const start = () => {
      if (document.hidden) return;
      updateProgress();
      if (isPlaying && frame === null) frame = window.requestAnimationFrame(updateFrame);
    };

    const handleVisibilityChange = () => {
      cancelFrame();
      if (!document.hidden) start();
    };

    start();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelFrame();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isPlaying, offsetMs, reducedMotion, state, timelineRevision, word]);

  return (
    <span
      ref={element}
      className="lyrics-word"
      data-state={state}
      style={
        {
          '--word-progress':
            state === 'complete' || (state === 'current' && reducedMotion) ? '100%' : '0%',
        } as CSSProperties
      }
    >
      <span className="lyrics-word__base">{word.text}</span>
      <span className="lyrics-word__fill" aria-hidden="true">
        {word.text}
      </span>
    </span>
  );
}

interface LyricLineViewProps {
  line: LyricLine;
  lineIndex: number;
  cursor: LyricCursor;
  lastSungLineIndex: number;
  document: LyricDocument;
  onSeek: (positionMs: number) => void;
  presentationOffsetMs: number;
  translation: SecondaryLyricVisibility;
  romanization: SecondaryLyricVisibility;
  isPlaying: boolean;
  reducedMotion: boolean;
  timelineRevision: number;
}

const LyricLineView = memo(
  function LyricLineView({
    line,
    lineIndex,
    cursor,
    lastSungLineIndex,
    document,
    onSeek,
    presentationOffsetMs,
    translation,
    romanization,
    isPlaying,
    reducedMotion,
    timelineRevision,
  }: LyricLineViewProps) {
    const active = cursor.lineIndex === lineIndex;
    const complete =
      cursor.lineIndex > lineIndex ||
      (cursor.lineIndex !== lineIndex && lastSungLineIndex >= lineIndex);
    const vocalist = document.vocalists.find((candidate) => candidate.id === line.vocalistId);

    return (
      <button
        type="button"
        className="lyrics-line"
        data-line-index={lineIndex}
        data-active={active || undefined}
        data-complete={complete || undefined}
        data-vocalist={line.vocalistId ?? undefined}
        aria-disabled={line.startMs === null || undefined}
        aria-label={line.text}
        onClick={() =>
          line.startMs !== null &&
          onSeek(Math.max(0, line.startMs + document.metadata.offsetMs - presentationOffsetMs))
        }
        aria-current={active ? 'true' : undefined}
      >
        {vocalist && <span className="lyrics-line__vocalist">{vocalist.displayName}</span>}
        <span className="lyrics-line__primary">
          {document.syncMode === 'word' && line.words.length > 0
            ? line.words.map((word, wordIndex) => {
                const state =
                  complete || (active && cursor.wordIndex > wordIndex)
                    ? 'complete'
                    : active && cursor.wordIndex === wordIndex
                      ? 'current'
                      : 'future';
                return (
                  <SyncedWord
                    key={`${word.startMs}-${wordIndex}`}
                    word={word}
                    state={state}
                    offsetMs={document.metadata.offsetMs - presentationOffsetMs}
                    isPlaying={isPlaying}
                    reducedMotion={reducedMotion}
                    timelineRevision={timelineRevision}
                  />
                );
              })
            : line.text}
        </span>
        {shouldShowLyricSecondary(romanization, line.romanization, line.text, 'romanization') && (
          <span className="lyrics-line__romanization">{line.romanization}</span>
        )}
        {shouldShowLyricSecondary(translation, line.translation, line.text, 'translation') && (
          <span className="lyrics-line__translation">{line.translation}</span>
        )}
      </button>
    );
  },
  (previous, next) => {
    if (
      previous.line !== next.line ||
      previous.document !== next.document ||
      previous.lineIndex !== next.lineIndex ||
      previous.onSeek !== next.onSeek ||
      previous.presentationOffsetMs !== next.presentationOffsetMs ||
      previous.translation !== next.translation ||
      previous.romanization !== next.romanization ||
      previous.lastSungLineIndex !== next.lastSungLineIndex
    ) {
      return false;
    }

    const stateFor = (cursor: LyricCursor, lastSungLineIndex: number) => {
      if (cursor.lineIndex === next.lineIndex) return 'active';
      if (cursor.lineIndex > next.lineIndex || lastSungLineIndex >= next.lineIndex) {
        return 'complete';
      }
      return 'future';
    };
    const previousState = stateFor(previous.cursor, previous.lastSungLineIndex);
    const nextState = stateFor(next.cursor, next.lastSungLineIndex);
    if (previousState !== nextState) return false;
    if (nextState !== 'active') return true;
    return (
      previous.cursor.wordIndex === next.cursor.wordIndex &&
      previous.isPlaying === next.isPlaying &&
      previous.reducedMotion === next.reducedMotion &&
      previous.timelineRevision === next.timelineRevision
    );
  },
);

function LyricsMessage({
  icon = 'lyrics',
  title,
  detail,
}: {
  icon?: 'lyrics' | 'instrumental';
  title: string;
  detail: string;
}) {
  return (
    <div className="lyrics-stage__message">
      {icon === 'instrumental' ? <Music2 size={25} /> : <AlignLeft size={25} />}
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

interface LyricsPanelProps {
  focus: boolean;
  fullscreen: boolean;
  fullscreenPending: boolean;
  fullscreenError: string | null;
  onToggleFullscreen: () => void;
  onClose: () => void;
}

export function LyricsPanel({
  focus,
  fullscreen,
  fullscreenPending,
  fullscreenError,
  onToggleFullscreen,
  onClose,
}: LyricsPanelProps) {
  const { t } = useTranslation('lyrics');
  const { t: player } = useTranslation('player');
  const { t: common } = useTranslation('common');
  const provider = useContext(ProviderContext);
  const accountProvider = provider && isAccountMusicProvider(provider) ? provider : null;
  const accountSnapshot = useAccountStore((state) => state.snapshot);
  const setFavorite = useAccountStore((state) => state.setFavorite);
  const currentTrackId = usePlayerStore((state) => state.queue[state.currentIndex]?.id ?? null);
  const currentTitle = usePlayerStore((state) => state.queue[state.currentIndex]?.title ?? '');
  const currentArtistLabel = usePlayerStore((state) =>
    joinArtistNames(state.queue[state.currentIndex]?.artists ?? []),
  );
  const currentArtworkSrc = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.artwork.src ?? '',
  );
  const currentArtworkAlt = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.artwork.alt ?? '',
  );
  const currentArtworkColor = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.artwork.dominantColor ?? '#3f463a',
  );
  const currentDurationMs = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.durationMs ?? 0,
  );
  const currentIsFavorite = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.isFavorite ?? false,
  );
  const currentPlaybackCapability = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.playbackCapability ?? null,
  );
  const currentProvider = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.provider ?? null,
  );
  const lyricsOpen = usePlayerStore((state) => state.lyricsOpen);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const timelineRevision = usePlayerStore((state) => state.timelineRevision);
  const positionMs = usePlayerStore((state) => state.positionMs);
  const playbackDurationMs = usePlayerStore((state) => state.playbackDurationMs);
  const sourceSelection = usePlayerStore((state) => state.sourceSelection);
  const seek = usePlayerStore((state) => state.seek);
  const togglePlayback = usePlayerStore((state) => state.togglePlayback);
  const next = usePlayerStore((state) => state.next);
  const previous = usePlayerStore((state) => state.previous);
  const { favorite, pending: favoritePending } = useFavoriteState(
    currentTrackId ?? undefined,
    currentIsFavorite,
  );
  const document = useLyricsStore((state) => state.document);
  const status = useLyricsStore((state) => state.status);
  const translation = usePreferencesStore((state) => state.lyrics.translation);
  const romanization = usePreferencesStore((state) => state.lyrics.romanization);
  const presentationOffsetMs = usePreferencesStore((state) => state.lyrics.timingOffsetMs);
  const coverLayout = usePreferencesStore((state) => state.lyrics.coverLayout);
  const updateLyrics = usePreferencesStore((state) => state.updateLyrics);
  const backgroundMode = usePreferencesStore((state) => state.appearance.backgroundMode);
  const backgroundColor = usePreferencesStore((state) => state.appearance.backgroundColor);
  const backgroundFit = usePreferencesStore((state) => state.appearance.backgroundFit);
  const backgroundImageSource = usePreferencesStore((state) => state.backgroundImageData);
  const safeArtworkSource = useSafeArtworkSource(currentArtworkSrc || null);
  useEffect(() => rememberLyricsArtwork(safeArtworkSource), [safeArtworkSource]);
  const appearance = resolveLyricsAppearance(
    {
      mode: backgroundMode,
      imageSource: backgroundImageSource,
      imageFit: backgroundFit,
      color: backgroundColor,
    },
    safeArtworkSource,
  );
  const backdropImageSource =
    appearance.mode === 'color'
      ? null
      : appearance.mode === 'image'
        ? appearance.imageSource
        : (safeArtworkSource ?? lyricsArtworkFallback());
  const blurredBackdrop = useBlurredArtwork(coverLayout === 'full' ? null : backdropImageSource);
  useEffect(() => rememberLyricsBlurredBackdrop(blurredBackdrop), [blurredBackdrop]);
  const backdropSource =
    coverLayout === 'full'
      ? backdropImageSource
      : (blurredBackdrop ?? lyricsBlurredBackdropFallback() ?? backdropImageSource);
  const activeDocument = document?.songId === currentTrackId ? document : null;
  const {
    cursor,
    lastSungLineIndex: sungLineIndex,
    interludeRemainingMs,
  } = useLyricCursor(
    lyricsOpen ? activeDocument : null,
    presentationOffsetMs,
    timelineRevision,
    isPlaying,
  );
  const reducedMotion = useReducedMotion();
  const stage = useRef<HTMLElement>(null);
  const transportRef = useRef<LyricsFullscreenTransportHandle>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const scrollContent = useRef<HTMLDivElement>(null);
  const [unfollowedSongId, setUnfollowedSongId] = useState<string | null>(null);
  const following = unfollowedSongId !== activeDocument?.songId;

  const timelineDuration = playbackDurationMs ?? currentDurationMs;
  const previewStartMs =
    sourceSelection?.preview && currentPlaybackCapability?.status === 'preview'
      ? currentPlaybackCapability.startMs
      : 0;
  const duration = Math.max(0, timelineDuration - previewStartMs);
  const displayPosition = Math.max(0, Math.min(positionMs - previewStartMs, duration));
  const progress = duration === 0 ? 0 : (displayPosition / duration) * 100;
  const favoriteLabel = currentTrackId
    ? favoritePending
      ? player('favoritePending', { title: currentTitle })
      : favorite
        ? player('removeFavorite', { title: currentTitle })
        : player('addFavorite', { title: currentTitle })
    : player('favorite');
  const hasWritableProviderReference =
    currentProvider?.providerId === accountProvider?.id &&
    Number.isSafeInteger(currentProvider?.numericId) &&
    (currentProvider?.numericId ?? 0) > 0;
  const favoriteAvailable =
    currentTrackId !== null &&
    accountProvider !== null &&
    (accountSnapshot.state !== 'authenticated' ||
      (accountSnapshot.capabilities.favoriteWrite && hasWritableProviderReference));

  useEffect(() => {
    if (!lyricsOpen || !following || cursor.lineIndex < 0) return;
    if (stage.current) stage.current.scrollTop = 0;
    centerLyricLine(scrollArea.current, scrollContent.current, cursor.lineIndex, reducedMotion);
  }, [
    activeDocument?.songId,
    cursor.lineIndex,
    focus,
    following,
    fullscreen,
    lyricsOpen,
    reducedMotion,
    timelineRevision,
  ]);

  const [controlsHidden, setControlsHidden] = useState(false);

  useEffect(() => () => cancelScrollSpring(scrollArea.current), []);

  useEffect(() => {
    const stageElement = stage.current;
    if (!stageElement) return;
    let timer: number | null = null;
    const reveal = () => {
      setControlsHidden(false);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setControlsHidden(true), 2_400);
    };
    reveal();
    stageElement.addEventListener('pointermove', reveal);
    return () => {
      stageElement.removeEventListener('pointermove', reveal);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [lyricsOpen]);

  if (!lyricsOpen) return null;

  const coverInkColors = coverInk(currentArtworkColor);
  const style = {
    '--lyrics-color': currentArtworkColor,
    '--lyrics-ink': coverInkColors.ink,
    '--lyrics-ink-contrast': coverInkColors.contrast,
    '--lyrics-stage-base': appearance.baseColor ?? 'var(--bg-opaque)',
    backgroundColor: appearance.baseColor ?? undefined,
  } as LyricsStyle;

  const resumeFollowing = () => {
    setUnfollowedSongId(null);
    centerLyricLine(scrollArea.current, scrollContent.current, cursor.lineIndex, reducedMotion);
  };

  return (
    <section
      ref={stage}
      className="lyrics-stage"
      style={style}
      aria-label={t('region')}
      data-focus={focus || undefined}
      data-fullscreen={fullscreen || undefined}
      data-cover-layout={coverLayout}
      data-background-mode={appearance.mode}
      data-image-fit={appearance.imageFit}
      data-song-id={currentTrackId ?? undefined}
      onPointerMove={() => transportRef.current?.reveal()}
    >
      {backdropSource && (
        <div
          className="lyrics-stage__backdrop"
          style={{ backgroundImage: `url("${backdropSource}")` }}
          aria-hidden="true"
        />
      )}
      <div className="lyrics-stage__wash" aria-hidden="true" />
      {fullscreen && (
        <LyricsFullscreenTransport ref={transportRef} artworkSource={safeArtworkSource} />
      )}

      {fullscreenError !== null && (
        <span className="lyrics-stage__fullscreen-status" role="status">
          {t('fullscreenFailed')}
        </span>
      )}

      {!currentTrackId ? (
        <LyricsMessage title={t('nothingPlaying')} detail={t('nothingPlayingDetail')} />
      ) : (
        <>
          <div className="lyrics-stage__content">
            <aside className="lyrics-stage__control-panel">
              {coverLayout === 'vinyl' ? (
                <div className="lyrics-stage__disc" data-playing={isPlaying || undefined}>
                  {safeArtworkSource && (
                    <img
                      className="lyrics-stage__disc-cover"
                      src={safeArtworkSource}
                      alt={currentArtworkAlt}
                      draggable={false}
                    />
                  )}
                </div>
              ) : safeArtworkSource ? (
                <img
                  className="lyrics-stage__control-panel__artwork"
                  src={safeArtworkSource}
                  alt={currentArtworkAlt}
                  draggable={false}
                />
              ) : (
                <span
                  className="lyrics-stage__artwork-placeholder lyrics-stage__control-panel__artwork"
                  aria-hidden="true"
                />
              )}
              <div className="lyrics-stage__control-panel__info">
                <strong>{currentTitle}</strong>
                <span>{currentArtistLabel}</span>
              </div>
            </aside>

            {status === 'loading' ? (
              <LyricsMessage title={t('loading')} detail={t('loadingDetail')} />
            ) : status === 'error' ? (
              <LyricsMessage title={t('unavailable')} detail={t('providerFailed')} />
            ) : !activeDocument || status === 'missing' ? (
              <LyricsMessage title={t('missing')} detail={t('missingDetail')} />
            ) : (
              <div className="lyrics-stage__viewport">
                {coverLayout === 'full' && (
                  <div className="lyrics-stage__track-heading">
                    <strong>{currentTitle}</strong>
                    <span>{currentArtistLabel}</span>
                  </div>
                )}
                <div
                  ref={scrollArea}
                  className="lyrics-stage__scroll"
                  onWheel={(event) => {
                    if (!scrollArea.current || !scrollContent.current) return;
                    const state = scrollStateFor(scrollArea.current);
                    const target = Math.min(
                      Math.max(0, state.offset + event.deltaY),
                      lyricScrollBounds(scrollArea.current, scrollContent.current),
                    );
                    cancelScrollSpring(scrollArea.current);
                    setLyricOffset(scrollArea.current, scrollContent.current, target);
                    setUnfollowedSongId(activeDocument.songId);
                  }}
                  onPointerDown={() => {
                    cancelScrollSpring(scrollArea.current);
                    setUnfollowedSongId(activeDocument.songId);
                  }}
                >
                  <div ref={scrollContent} className="lyrics-stage__scroll-content">
                    <div className="lyrics-stage__spacer" />
                    {activeDocument.lines.map((line, lineIndex) => (
                      <LyricLineView
                        key={line.id}
                        line={line}
                        lineIndex={lineIndex}
                        cursor={cursor}
                        lastSungLineIndex={sungLineIndex}
                        document={activeDocument}
                        onSeek={(positionMs) => {
                          seek(positionMs);
                          setUnfollowedSongId(null);
                        }}
                        presentationOffsetMs={presentationOffsetMs}
                        translation={translation}
                        romanization={romanization}
                        isPlaying={isPlaying}
                        reducedMotion={reducedMotion}
                        timelineRevision={timelineRevision}
                      />
                    ))}
                    <div className="lyrics-stage__spacer" />
                  </div>
                </div>

                {!following && (
                  <button type="button" className="lyrics-stage__follow" onClick={resumeFollowing}>
                    <LocateFixed size={15} />
                    {t('follow')}
                  </button>
                )}
                {following &&
                  activeDocument.syncMode !== 'unsynchronized' &&
                  interludeRemainingMs !== null && (
                    <span className="lyrics-stage__instrumental">
                      <Music2 size={13} /> {t('instrumental')}
                    </span>
                  )}
              </div>
            )}
          </div>

          <div className="lyrics-stage__topbar" data-hidden={controlsHidden || undefined}>
            <IconButton
              label={
                coverLayout === 'split'
                  ? t('coverFull')
                  : coverLayout === 'full'
                    ? t('coverVinyl')
                    : t('coverSplit')
              }
              size="large"
              onClick={() =>
                updateLyrics({
                  coverLayout:
                    coverLayout === 'split' ? 'full' : coverLayout === 'full' ? 'vinyl' : 'split',
                })
              }
            >
              <Image size={18} />
            </IconButton>
            <IconButton
              label={fullscreen ? t('exitFullscreen') : t('enterFullscreen')}
              size="large"
              onClick={onToggleFullscreen}
              disabled={fullscreenPending}
            >
              {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </IconButton>
          </div>

          <footer
            className="lyrics-stage__controls"
            data-hidden={fullscreen || controlsHidden || undefined}
          >
            <div className="lyrics-stage__controls-side">
              <IconButton label={t('collapse')} size="large" onClick={onClose}>
                <ChevronDown size={20} />
              </IconButton>
              <IconButton
                label={favoriteLabel}
                size="large"
                active={favorite}
                disabled={!favoriteAvailable || favoritePending}
                onClick={() => {
                  const state = usePlayerStore.getState();
                  const track = state.queue[state.currentIndex];
                  if (accountProvider && track) {
                    void setFavorite(accountProvider, track, !favorite);
                  }
                }}
              >
                <Heart size={18} fill={favorite ? 'currentColor' : 'none'} />
              </IconButton>
            </div>
            <div className="lyrics-stage__controls-center">
              <div className="lyrics-stage__control-buttons">
                <IconButton label={player('previous')} size="large" onClick={previous}>
                  <SkipBack size={18} fill="currentColor" />
                </IconButton>
                <button
                  type="button"
                  className="lyrics-stage__play"
                  onClick={togglePlayback}
                  aria-label={isPlaying ? common('pause') : common('play')}
                >
                  {isPlaying ? (
                    <Pause size={20} fill="currentColor" />
                  ) : (
                    <Play size={20} fill="currentColor" />
                  )}
                </button>
                <IconButton label={player('next')} size="large" onClick={next}>
                  <SkipForward size={18} fill="currentColor" />
                </IconButton>
              </div>
              <div className="lyrics-stage__progress">
                <span>{formatDuration(displayPosition)}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(duration, 1)}
                  step={1_000}
                  value={displayPosition}
                  onChange={(event) => seek(Number(event.target.value) + previewStartMs)}
                  aria-label={player('position')}
                  style={{ '--range-progress': `${progress}%` } as CSSProperties}
                />
                <span>{formatDuration(duration)}</span>
              </div>
            </div>
            <div className="lyrics-stage__controls-side lyrics-stage__controls-side--right" />
          </footer>
        </>
      )}
    </section>
  );
}
