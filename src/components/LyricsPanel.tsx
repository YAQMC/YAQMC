import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from 'react';
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
  lyricCursorKey,
  selectLyricCursor,
  wordProgress,
  type LyricCursor,
} from '../application/lyrics-timing';
import {
  getEstimatedPositionMs,
  useCurrentSong,
  usePlayerStore,
} from '../application/player-store';
import type { LyricDocument, LyricLine, LyricWord } from '../domain/music';
import { joinArtistNames } from '../utils/format';
import { IconButton } from './ui/IconButton';
import { useTranslation } from 'react-i18next';
import { usePreferencesStore, type SecondaryLyricVisibility } from '../application/preferences';
import { shouldShowLyricSecondary } from '../application/lyrics-presentation';

type LyricsStyle = CSSProperties & {
  '--lyrics-color': string;
};

function useReducedMotion(): MutableRefObject<boolean> {
  const reducedMotion = useRef(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      reducedMotion.current = media.matches;
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reducedMotion;
}

function useLyricCursor(document: LyricDocument | null, presentationOffsetMs: number): LyricCursor {
  const [cursor, setCursor] = useState<LyricCursor>(emptyLyricCursor);

  useEffect(() => {
    if (!document) return;
    let frame = 0;
    let previousKey = '';

    const update = () => {
      const positionMs = getEstimatedPositionMs() + presentationOffsetMs;
      const nextKey = lyricCursorKey(document, positionMs);
      if (nextKey !== previousKey) {
        previousKey = nextKey;
        setCursor(selectLyricCursor(document, positionMs));
      }
      frame = window.requestAnimationFrame(update);
    };

    update();
    return () => window.cancelAnimationFrame(frame);
  }, [document, presentationOffsetMs]);

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
  const lineRect = line.getBoundingClientRect();
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
}: {
  word: LyricWord;
  state: 'future' | 'current' | 'complete';
  offsetMs: number;
  isPlaying: boolean;
}) {
  const element = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (state !== 'current') return;
    const updateProgress = () => {
      const progress = wordProgress(word, getEstimatedPositionMs() - offsetMs);
      element.current?.style.setProperty('--word-progress', `${progress * 100}%`);
    };
    if (!isPlaying) {
      updateProgress();
      return;
    }
    let frame = 0;
    const update = () => {
      updateProgress();
      frame = window.requestAnimationFrame(update);
    };
    update();
    return () => window.cancelAnimationFrame(frame);
  }, [isPlaying, offsetMs, state, word]);

  return (
    <span
      ref={element}
      className="lyrics-word"
      data-state={state}
      style={{ '--word-progress': state === 'complete' ? '100%' : '0%' } as CSSProperties}
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
      previous.isPlaying !== next.isPlaying
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
    return (
      previousState === nextState &&
      (nextState !== 'active' || previous.cursor.wordIndex === next.cursor.wordIndex)
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
  const current = useCurrentSong();
  const lyricsOpen = usePlayerStore((state) => state.lyricsOpen);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const seek = usePlayerStore((state) => state.seek);
  const { document, status } = useLyricsStore();
  const translation = usePreferencesStore((state) => state.lyrics.translation);
  const romanization = usePreferencesStore((state) => state.lyrics.romanization);
  const presentationOffsetMs = usePreferencesStore((state) => state.lyrics.timingOffsetMs);
  const cursor = useLyricCursor(lyricsOpen ? document : null, presentationOffsetMs);
  const reducedMotion = useReducedMotion();
  const stage = useRef<HTMLElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const [unfollowedSongId, setUnfollowedSongId] = useState<string | null>(null);
  const following = unfollowedSongId !== document?.songId;

  useEffect(() => {
    if (!lyricsOpen || !following || cursor.lineIndex < 0) return;
    if (stage.current) stage.current.scrollTop = 0;
    centerLyricLine(
      scrollArea.current,
      cursor.lineIndex,
      lyricScrollBehavior(reducedMotion.current),
    );
  }, [cursor.lineIndex, focus, following, fullscreen, lyricsOpen, reducedMotion]);

  if (!lyricsOpen) return null;

  const style = {
    '--lyrics-color': current?.artwork.dominantColor ?? '#3f463a',
  } as LyricsStyle;

  const resumeFollowing = () => {
    setUnfollowedSongId(null);
    centerLyricLine(
      scrollArea.current,
      cursor.lineIndex,
      lyricScrollBehavior(reducedMotion.current),
    );
  };

  return (
    <section
      ref={stage}
      className="lyrics-stage"
      style={style}
      aria-label={t('region')}
      data-focus={focus || undefined}
      data-fullscreen={fullscreen || undefined}
    >
      {current && (
        <div
          className="lyrics-stage__backdrop"
          style={{ backgroundImage: `url("${current.artwork.src}")` }}
          aria-hidden="true"
        />
      )}
      <div className="lyrics-stage__wash" aria-hidden="true" />

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
          <span>{document?.metadata.sourceLabel ?? t('offlineSurface')}</span>
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

      {!current ? (
        <LyricsMessage title={t('nothingPlaying')} detail={t('nothingPlayingDetail')} />
      ) : (
        <>
          <aside className="lyrics-stage__track">
            <img src={current.artwork.src} alt={current.artwork.alt} draggable={false} />
            <div>
              <strong>{current.title}</strong>
              <span>{joinArtistNames(current.artists)}</span>
            </div>
            {document && (
              <div className="lyrics-stage__sync-badge">
                {document.syncMode === 'word'
                  ? t('wordSynced')
                  : document.syncMode === 'line'
                    ? t('lineSynced')
                    : t('plain')}
              </div>
            )}
          </aside>

          {status === 'loading' ? (
            <LyricsMessage title={t('loading')} detail={t('loadingDetail')} />
          ) : status === 'error' ? (
            <LyricsMessage title={t('unavailable')} detail={t('providerFailed')} />
          ) : !document || status === 'missing' ? (
            <LyricsMessage title={t('missing')} detail={t('missingDetail')} />
          ) : (
            <div className="lyrics-stage__viewport">
              <div
                ref={scrollArea}
                className="lyrics-stage__scroll"
                onWheel={() => setUnfollowedSongId(document.songId)}
                onPointerDown={() => setUnfollowedSongId(document.songId)}
              >
                <div className="lyrics-stage__spacer" />
                {document.lines.map((line, lineIndex) => (
                  <LyricLineView
                    key={line.id}
                    line={line}
                    lineIndex={lineIndex}
                    cursor={cursor}
                    document={document}
                    onSeek={seek}
                    presentationOffsetMs={presentationOffsetMs}
                    translation={translation}
                    romanization={romanization}
                    isPlaying={isPlaying}
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
              {following && document.syncMode !== 'unsynchronized' && cursor.lineIndex < 0 && (
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
