import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  AlignLeft,
  LocateFixed,
  Maximize2,
  Minimize2,
  Music2,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import { useLyricsStore } from '../application/lyrics-store';
import {
  emptyLyricCursor,
  lyricScrollBehavior,
  nextLyricBoundaryMs,
  selectLyricCursor,
  wordProgress,
  type LyricCursor,
} from '../application/lyrics-timing';
import { getEstimatedPositionMs, usePlayerStore } from '../application/player-store';
import type { LyricDocument, LyricLine, LyricWord } from '../domain/music';
import { joinArtistNames } from '../utils/format';
import { IconButton } from './ui/IconButton';
import { useTranslation } from 'react-i18next';
import { usePreferencesStore, type SecondaryLyricVisibility } from '../application/preferences';
import { shouldShowLyricSecondary } from '../application/lyrics-presentation';
import {
  LyricsFullscreenTransport,
  type LyricsFullscreenTransportHandle,
} from './LyricsFullscreenTransport';

type LyricsStyle = CSSProperties & {
  '--lyrics-color': string;
};

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

function useLyricCursor(
  lyricDocument: LyricDocument | null,
  presentationOffsetMs: number,
  timelineRevision: number,
  isPlaying: boolean,
): LyricCursor {
  const [cursor, setCursor] = useState<LyricCursor>(emptyLyricCursor);

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
        setCursor(emptyLyricCursor);
        return;
      }

      const rawPositionMs = getEstimatedPositionMs() + presentationOffsetMs;
      const nextCursor = selectLyricCursor(lyricDocument, rawPositionMs);
      setCursor((previous) =>
        previous.lineIndex === nextCursor.lineIndex &&
        previous.wordIndex === nextCursor.wordIndex &&
        previous.line === nextCursor.line &&
        previous.word === nextCursor.word
          ? previous
          : nextCursor,
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

  return cursor;
}

function centerLyricLine(
  scrollArea: HTMLDivElement | null,
  lineIndex: number,
  behavior: ScrollBehavior,
): void {
  if (!scrollArea || lineIndex < 0) return;
  const line = scrollArea.querySelector<HTMLElement>(`[data-line-index="${lineIndex}"]`);
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
  const top =
    scrollArea.scrollTop +
    lineRect.top -
    areaRect.top -
    scrollArea.clientHeight / 2 +
    lineRect.height / 2;
  scrollArea.scrollTo({ top: Math.max(0, top), behavior });
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
    let lastWriteTimestamp = Number.NEGATIVE_INFINITY;
    const frameIntervalMs =
      document.documentElement.dataset.platform === 'linux' ? 1_000 / 30 : 1_000 / 60;

    const updateProgress = () => {
      const progress = wordProgress(word, getEstimatedPositionMs() - offsetMs);
      element.current?.style.setProperty('--word-progress', `${progress * 100}%`);
    };

    const cancelFrame = () => {
      if (frame === null) return;
      window.cancelAnimationFrame(frame);
      frame = null;
    };

    const updateFrame = (timestamp: number) => {
      frame = null;
      if (document.hidden) return;
      if (timestamp - lastWriteTimestamp >= frameIntervalMs) {
        lastWriteTimestamp = timestamp;
        updateProgress();
      }
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
    const complete = cursor.lineIndex > lineIndex;
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
      previous.romanization !== next.romanization
    ) {
      return false;
    }

    const stateFor = (cursor: LyricCursor) => {
      if (cursor.lineIndex < next.lineIndex) return 'future';
      if (cursor.lineIndex > next.lineIndex) return 'complete';
      return 'active';
    };
    const previousState = stateFor(previous.cursor);
    const nextState = stateFor(next.cursor);
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
  onToggleFocus: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
}

export function LyricsPanel({
  focus,
  fullscreen,
  fullscreenPending,
  fullscreenError,
  onToggleFocus,
  onToggleFullscreen,
  onClose,
}: LyricsPanelProps) {
  const { t } = useTranslation('lyrics');
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
  const lyricsOpen = usePlayerStore((state) => state.lyricsOpen);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const timelineRevision = usePlayerStore((state) => state.timelineRevision);
  const seek = usePlayerStore((state) => state.seek);
  const document = useLyricsStore((state) => state.document);
  const status = useLyricsStore((state) => state.status);
  const translation = usePreferencesStore((state) => state.lyrics.translation);
  const romanization = usePreferencesStore((state) => state.lyrics.romanization);
  const presentationOffsetMs = usePreferencesStore((state) => state.lyrics.timingOffsetMs);
  const activeDocument = document?.songId === currentTrackId ? document : null;
  const cursor = useLyricCursor(
    lyricsOpen ? activeDocument : null,
    presentationOffsetMs,
    timelineRevision,
    isPlaying,
  );
  const reducedMotion = useReducedMotion();
  const stage = useRef<HTMLElement>(null);
  const transportRef = useRef<LyricsFullscreenTransportHandle>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const [unfollowedSongId, setUnfollowedSongId] = useState<string | null>(null);
  const following = unfollowedSongId !== activeDocument?.songId;

  useEffect(() => {
    if (!lyricsOpen || !following || cursor.lineIndex < 0) return;
    if (stage.current) stage.current.scrollTop = 0;
    centerLyricLine(scrollArea.current, cursor.lineIndex, lyricScrollBehavior(reducedMotion));
  }, [cursor.lineIndex, focus, following, fullscreen, lyricsOpen, reducedMotion]);

  if (!lyricsOpen) return null;

  const style = {
    '--lyrics-color': currentArtworkColor,
  } as LyricsStyle;

  const resumeFollowing = () => {
    setUnfollowedSongId(null);
    centerLyricLine(scrollArea.current, cursor.lineIndex, lyricScrollBehavior(reducedMotion));
  };

  return (
    <section
      ref={stage}
      className="lyrics-stage"
      style={style}
      aria-label={t('region')}
      data-focus={focus || undefined}
      data-fullscreen={fullscreen || undefined}
      onPointerMove={() => transportRef.current?.reveal()}
    >
      {currentTrackId && (
        <div
          className="lyrics-stage__backdrop"
          style={{ backgroundImage: `url("${currentArtworkSrc}")` }}
          aria-hidden="true"
        />
      )}
      <div className="lyrics-stage__wash" aria-hidden="true" />
      {fullscreen && <LyricsFullscreenTransport ref={transportRef} />}

      <header className="lyrics-stage__header">
        <div className="lyrics-stage__presentation-controls">
          <IconButton
            label={focus ? t('showNavigation') : t('hideNavigation')}
            onClick={onToggleFocus}
          >
            {focus ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </IconButton>
          <IconButton
            label={fullscreen ? t('exitFullscreen') : t('enterFullscreen')}
            onClick={onToggleFullscreen}
            disabled={fullscreenPending}
          >
            {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </IconButton>
        </div>
        <div className="lyrics-stage__heading">
          <strong>{t('title')}</strong>
          <span>{activeDocument?.metadata.sourceLabel ?? t('offlineSurface')}</span>
        </div>
        <IconButton label={t('close')} onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>

      {fullscreenError !== null && (
        <span className="lyrics-stage__fullscreen-status" role="status">
          {t('fullscreenFailed')}
        </span>
      )}

      {!currentTrackId ? (
        <LyricsMessage title={t('nothingPlaying')} detail={t('nothingPlayingDetail')} />
      ) : (
        <>
          <aside className="lyrics-stage__track">
            <img src={currentArtworkSrc} alt={currentArtworkAlt} draggable={false} />
            <div>
              <strong>{currentTitle}</strong>
              <span>{currentArtistLabel}</span>
            </div>
            {activeDocument && (
              <div className="lyrics-stage__sync-badge">
                {activeDocument.syncMode === 'word'
                  ? t('wordSynced')
                  : activeDocument.syncMode === 'line'
                    ? t('lineSynced')
                    : t('plain')}
              </div>
            )}
          </aside>

          {status === 'loading' ? (
            <LyricsMessage title={t('loading')} detail={t('loadingDetail')} />
          ) : status === 'error' ? (
            <LyricsMessage title={t('unavailable')} detail={t('providerFailed')} />
          ) : !activeDocument || status === 'missing' ? (
            <LyricsMessage title={t('missing')} detail={t('missingDetail')} />
          ) : (
            <div className="lyrics-stage__viewport">
              <div
                ref={scrollArea}
                className="lyrics-stage__scroll"
                onWheel={() => setUnfollowedSongId(activeDocument.songId)}
                onPointerDown={() => setUnfollowedSongId(activeDocument.songId)}
              >
                <div className="lyrics-stage__spacer" />
                {activeDocument.lines.map((line, lineIndex) => (
                  <LyricLineView
                    key={line.id}
                    line={line}
                    lineIndex={lineIndex}
                    cursor={cursor}
                    document={activeDocument}
                    onSeek={seek}
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

              {!following && (
                <button type="button" className="lyrics-stage__follow" onClick={resumeFollowing}>
                  <LocateFixed size={15} />
                  {t('follow')}
                </button>
              )}
              {following &&
                activeDocument.syncMode !== 'unsynchronized' &&
                cursor.lineIndex < 0 && (
                  <span className="lyrics-stage__instrumental">
                    <Music2 size={13} /> {t('instrumental')}
                  </span>
                )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
