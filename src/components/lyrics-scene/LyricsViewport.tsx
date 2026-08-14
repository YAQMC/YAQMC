import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { AlignLeft, LocateFixed, Music2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  emptyLyricCursor,
  lastSungLineIndex,
  lyricInterludeRemainingMs,
  nextLyricBoundaryMs,
  selectLyricCursor,
  wordProgress,
  type LyricCursor,
} from '../../application/lyrics-timing';
import { shouldShowLyricSecondary } from '../../application/lyrics-presentation';
import {
  cancelScrollSpring,
  centerLyricLine,
  lyricScrollBounds,
  scrollStateFor,
  setLyricOffset,
} from '../../application/lyrics-scroll';
import { logger } from '../../application/logger';
import type { SecondaryLyricVisibility } from '../../application/preferences';
import type { LyricDocument, LyricLine, LyricWord } from '../../domain/music';
import type { LyricsFollowState } from './types';

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
  getPositionMs: () => number,
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

      const rawPositionMs = getPositionMs() + presentationOffsetMs;
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
  }, [getPositionMs, isPlaying, lyricDocument, presentationOffsetMs, timelineRevision]);

  return position;
}

function SyncedWord({
  word,
  state,
  offsetMs,
  isPlaying,
  reducedMotion,
  timelineRevision,
  getPositionMs,
}: {
  word: LyricWord;
  state: 'future' | 'current' | 'complete';
  offsetMs: number;
  isPlaying: boolean;
  reducedMotion: boolean;
  timelineRevision: number;
  getPositionMs: () => number;
}) {
  const element = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (state !== 'current') return;
    if (reducedMotion) return;
    let frame: number | null = null;

    const updateProgress = () => {
      const progress = wordProgress(word, getPositionMs() - offsetMs);
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
  }, [getPositionMs, isPlaying, offsetMs, reducedMotion, state, timelineRevision, word]);

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
  getPositionMs: () => number;
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
    getPositionMs,
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
                    getPositionMs={getPositionMs}
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
      previous.lastSungLineIndex !== next.lastSungLineIndex ||
      previous.getPositionMs !== next.getPositionMs
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

export function LyricsViewport({
  document,
  status,
  isPlaying,
  timelineRevision,
  presentationOffsetMs,
  getPositionMs,
  seek,
  translation,
  romanization,
  followAnchor,
  align,
  songId,
  editorGesture = false,
  allowSeek = true,
  onFollowStateChange,
  layoutKey,
}: {
  document: LyricDocument | null;
  status: 'idle' | 'loading' | 'ready' | 'error' | 'missing';
  isPlaying: boolean;
  timelineRevision: number;
  presentationOffsetMs: number;
  getPositionMs: () => number;
  seek: (positionMs: number) => void;
  translation: SecondaryLyricVisibility;
  romanization: SecondaryLyricVisibility;
  followAnchor: number;
  align: 'left' | 'center' | 'right';
  songId: string | null;
  editorGesture?: boolean;
  allowSeek?: boolean;
  onFollowStateChange?: (state: LyricsFollowState) => void;
  layoutKey?: string;
}) {
  const { t } = useTranslation('lyrics');
  const reducedMotion = useReducedMotion();
  const scrollArea = useRef<HTMLDivElement>(null);
  const scrollContent = useRef<HTMLDivElement>(null);
  const [followState, setFollowState] = useState<LyricsFollowState>('active');
  const [followSongId, setFollowSongId] = useState(songId);
  if (followSongId !== songId) {
    setFollowSongId(songId);
    setFollowState('active');
  }
  const {
    cursor,
    lastSungLineIndex: sungLineIndex,
    interludeRemainingMs,
  } = useLyricCursor(document, getPositionMs, presentationOffsetMs, timelineRevision, isPlaying);

  useEffect(() => {
    onFollowStateChange?.(followState);
  }, [followState, onFollowStateChange]);

  const scrollToCurrentLine = (options: { force?: boolean } = {}) => {
    centerLyricLine(scrollArea.current, scrollContent.current, cursor.lineIndex, reducedMotion, {
      followAnchor,
      force: options.force,
    });
  };

  useEffect(() => {
    if (followState !== 'active' || editorGesture || cursor.lineIndex < 0) return;
    scrollToCurrentLine();
    // Line-transition driven. Word ticks must not recenter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    songId,
    cursor.lineIndex,
    followState,
    editorGesture,
    followAnchor,
    reducedMotion,
    layoutKey,
  ]);

  useEffect(() => () => cancelScrollSpring(scrollArea.current), []);

  const resumeFollowing = () => {
    setFollowState('active');
    logger.info('lyrics.follow.resume', 'resumed current-line follow', {
      songId,
      lineIndex: cursor.lineIndex,
    });
    scrollToCurrentLine({ force: true });
  };

  if (status === 'idle') {
    return <LyricsMessage title={t('nothingPlaying')} detail={t('nothingPlayingDetail')} />;
  }
  if (status === 'loading') {
    return <LyricsMessage title={t('loading')} detail={t('loadingDetail')} />;
  }
  if (status === 'error') {
    return <LyricsMessage title={t('unavailable')} detail={t('providerFailed')} />;
  }
  if (!document || status === 'missing') {
    return <LyricsMessage title={t('missing')} detail={t('missingDetail')} />;
  }

  return (
    <div className="lyrics-stage__viewport" data-align={align}>
      <div
        ref={scrollArea}
        className="lyrics-stage__scroll"
        onWheel={(event) => {
          if (!scrollArea.current || !scrollContent.current) return;
          if (event.deltaY === 0 && event.deltaX === 0) return;
          const state = scrollStateFor(scrollArea.current);
          const target = Math.min(
            Math.max(0, state.offset + event.deltaY),
            lyricScrollBounds(scrollArea.current, scrollContent.current),
          );
          cancelScrollSpring(scrollArea.current);
          setLyricOffset(scrollArea.current, scrollContent.current, target);
          if (followState !== 'suspended') {
            setFollowState('suspended');
            logger.info('lyrics.follow.suspend', 'suspended current-line follow', {
              songId,
              reason: 'wheel',
            });
          }
        }}
      >
        <div
          ref={scrollContent}
          className="lyrics-stage__scroll-content"
          style={{ textAlign: align }}
        >
          <div className="lyrics-stage__spacer" />
          {document.lines.map((line, lineIndex) => (
            <LyricLineView
              key={line.id}
              line={line}
              lineIndex={lineIndex}
              cursor={cursor}
              lastSungLineIndex={sungLineIndex}
              document={document}
              onSeek={(positionMs) => {
                if (!allowSeek) return;
                seek(positionMs);
                setFollowState('active');
              }}
              presentationOffsetMs={presentationOffsetMs}
              translation={translation}
              romanization={romanization}
              isPlaying={isPlaying}
              reducedMotion={reducedMotion}
              timelineRevision={timelineRevision}
              getPositionMs={getPositionMs}
            />
          ))}
          <div className="lyrics-stage__spacer" />
        </div>
      </div>

      {followState === 'suspended' && (
        <button
          type="button"
          className="lyrics-stage__follow"
          data-editor-interactive="true"
          onClick={resumeFollowing}
        >
          <LocateFixed size={15} />
          {t('follow')}
        </button>
      )}
      {followState === 'active' &&
        document.syncMode !== 'unsynchronized' &&
        interludeRemainingMs !== null && (
          <span className="lyrics-stage__instrumental">
            <Music2 size={13} /> {t('instrumental')}
          </span>
        )}
    </div>
  );
}
