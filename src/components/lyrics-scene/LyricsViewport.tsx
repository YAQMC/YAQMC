import { useCallback, useEffect, useMemo, useState } from 'react';
import { LyricPlayer } from '@applemusic-like-lyrics/react';
import type { LyricLine as AmllLyricLine, LyricLineMouseEvent } from '@applemusic-like-lyrics/core';
import { AlignLeft, Music2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { shouldShowLyricSecondary } from '../../application/lyrics-presentation';
import type {
  AmllSettings,
  LyricWordEffect,
  SecondaryLyricVisibility,
} from '../../application/preferences';
import { usePlayerStore } from '../../application/player-store';
import type { LyricDocument, LyricLine } from '../../domain/music';

import '@applemusic-like-lyrics/core/style.css';

interface AmllLyricModel {
  lines: AmllLyricLine[];
  sourceLineIndexes: number[];
}

function finiteLineEnd(line: LyricLine): number | null {
  if (line.endMs !== null && Number.isFinite(line.endMs) && line.endMs >= (line.startMs ?? 0)) {
    return line.endMs;
  }
  const wordEnd = line.words.reduce(
    (latest, word) => (Number.isFinite(word.endMs) ? Math.max(latest, word.endMs) : latest),
    Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(wordEnd) ? wordEnd : null;
}

function toAmllLyricModel(
  document: LyricDocument,
  translation: SecondaryLyricVisibility,
  romanization: SecondaryLyricVisibility,
): AmllLyricModel {
  const lines: AmllLyricLine[] = [];
  const sourceLineIndexes: number[] = [];

  for (const [sourceIndex, sourceLine] of document.lines.entries()) {
    if (sourceLine.startMs === null || !Number.isFinite(sourceLine.startMs)) continue;
    const endMs = finiteLineEnd(sourceLine);
    if (endMs === null) continue;
    const words =
      document.syncMode === 'word' && sourceLine.words.length > 0
        ? sourceLine.words
            .filter(
              (word) =>
                Number.isFinite(word.startMs) &&
                Number.isFinite(word.endMs) &&
                word.endMs >= word.startMs,
            )
            .map((word) => ({
              startTime: Math.round(word.startMs),
              endTime: Math.round(word.endMs),
              word: word.text,
            }))
        : [];
    const timedWords =
      words.length > 0
        ? words
        : [
            {
              startTime: Math.round(sourceLine.startMs),
              endTime: Math.round(endMs),
              word: sourceLine.text,
            },
          ];

    lines.push({
      words: timedWords,
      translatedLyric: shouldShowLyricSecondary(
        translation,
        sourceLine.translation,
        sourceLine.text,
        'translation',
      )
        ? (sourceLine.translation ?? '')
        : '',
      romanLyric: shouldShowLyricSecondary(
        romanization,
        sourceLine.romanization,
        sourceLine.text,
        'romanization',
      )
        ? (sourceLine.romanization ?? '')
        : '',
      startTime: Math.round(sourceLine.startMs),
      endTime: Math.round(endMs),
      isBG: false,
      isDuet: sourceLine.vocalistId === 'response',
    });
    sourceLineIndexes.push(sourceIndex);
  }

  return { lines, sourceLineIndexes };
}

function lyricTimeMs(
  getPositionMs: () => number,
  presentationOffsetMs: number,
  document: LyricDocument,
): number {
  return Math.max(
    0,
    Math.round(getPositionMs() + presentationOffsetMs - document.metadata.offsetMs),
  );
}

/** AMLL expects frequent time updates; keep this clock independent from lyric-boundary renders. */
function useAmllCurrentTime(
  document: LyricDocument | null,
  getPositionMs: () => number,
  presentationOffsetMs: number,
  timelineRevision: number,
  isPlaying: boolean,
): number {
  const current = useCallback(
    () => (document ? lyricTimeMs(getPositionMs, presentationOffsetMs, document) : 0),
    [document, getPositionMs, presentationOffsetMs],
  );
  const [currentTime, setCurrentTime] = useState(current);

  useEffect(() => {
    let frame: number | null = null;
    const update = () => setCurrentTime(current());
    const tick = () => {
      update();
      frame = window.requestAnimationFrame(tick);
    };

    update();
    if (isPlaying) frame = window.requestAnimationFrame(tick);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [current, isPlaying, timelineRevision]);

  return currentTime;
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

function StaticLyrics({
  document,
  align,
  allowSeek,
  seek,
  presentationOffsetMs,
}: {
  document: LyricDocument;
  align: 'left' | 'center' | 'right';
  allowSeek: boolean;
  seek: (positionMs: number) => void;
  presentationOffsetMs: number;
}) {
  return (
    <div className="lyrics-stage__amll-static" data-align={align} style={{ textAlign: align }}>
      {document.lines.map((line) => (
        <button
          key={line.id}
          type="button"
          className="lyrics-stage__static-line"
          aria-label={line.text}
          aria-disabled={line.startMs === null || undefined}
          onClick={() =>
            allowSeek &&
            line.startMs !== null &&
            seek(Math.max(0, line.startMs + document.metadata.offsetMs - presentationOffsetMs))
          }
        >
          <span className="lyrics-stage__static-primary">{line.text}</span>
        </button>
      ))}
    </div>
  );
}

export function LyricsViewport({
  document,
  status,
  isPlaying: isPlayingProp,
  timelineRevision: timelineRevisionProp,
  presentationOffsetMs,
  getPositionMs,
  seek,
  translation,
  romanization,
  wordEffect,
  amll,
  followAnchor,
  align,
  songId: _songId,
  editorGesture = false,
  allowSeek = true,
  onFollowStateChange,
  layoutKey: _layoutKey,
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
  wordEffect: LyricWordEffect;
  amll: AmllSettings;
  followAnchor: number;
  align: 'left' | 'center' | 'right';
  songId: string | null;
  editorGesture?: boolean;
  allowSeek?: boolean;
  onFollowStateChange?: (state: 'active' | 'suspended') => void;
  layoutKey?: string;
}) {
  const { t } = useTranslation('lyrics');
  const reducedMotion = useReducedMotion();
  const runtimePlaying = usePlayerStore((state) => state.isPlaying);
  const runtimeRevision = usePlayerStore((state) => state.timelineRevision);
  const isPlaying = editorGesture ? isPlayingProp : runtimePlaying;
  const timelineRevision = editorGesture ? timelineRevisionProp : runtimeRevision;
  const currentTime = useAmllCurrentTime(
    document,
    getPositionMs,
    presentationOffsetMs,
    timelineRevision,
    isPlaying,
  );
  const model = useMemo(
    () => (document ? toAmllLyricModel(document, translation, romanization) : null),
    [document, romanization, translation],
  );

  useEffect(() => onFollowStateChange?.('active'), [onFollowStateChange]);

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

  if (document.syncMode === 'unsynchronized' || !model || model.lines.length === 0) {
    return (
      <StaticLyrics
        document={document}
        align={align}
        allowSeek={allowSeek}
        seek={seek}
        presentationOffsetMs={presentationOffsetMs}
      />
    );
  }

  const onLyricLineClick = (event: LyricLineMouseEvent) => {
    if (!allowSeek) return;
    const sourceIndex = model.sourceLineIndexes[event.lineIndex];
    const sourceLine = sourceIndex === undefined ? undefined : document.lines[sourceIndex];
    if (!sourceLine || sourceLine.startMs === null) return;
    seek(Math.max(0, sourceLine.startMs + document.metadata.offsetMs - presentationOffsetMs));
  };

  return (
    <div
      className="lyrics-stage__amll"
      data-align={align}
      data-follow="active"
      data-word-jump={wordEffect === 'jump' ? 'true' : 'false'}
    >
      <LyricPlayer
        className="lyrics-stage__amll-player"
        disabled={editorGesture}
        lyricLines={model.lines}
        currentTime={currentTime}
        isSeeking={false}
        playing={isPlaying}
        alignAnchor="center"
        alignPosition={Math.min(0.9, Math.max(0.1, followAnchor))}
        enableSpring={amll.enableSpring && !reducedMotion}
        enableScale={amll.enableScale && !reducedMotion}
        enableBlur={amll.enableBlur && !reducedMotion}
        hidePassedLines={amll.hidePassedLines}
        wordFadeWidth={amll.wordFadeWidth}
        onLyricLineClick={onLyricLineClick}
      />
    </div>
  );
}
