import {
  GripHorizontal,
  Lock,
  Pause,
  Play,
  Settings2,
  SkipBack,
  SkipForward,
  Unlock,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  closeLyricsSurface,
  estimatedSurfacePosition,
  setLyricsSurfaceInteraction,
  showLyricsSettings,
  useLyricsSurfaceRuntime,
  useProjectedLyrics,
  type TimedProjection,
} from '../application/lyrics-surface-runtime';
import {
  usePreferencesRuntime,
  usePreferencesStore,
  type LyricSurfaceSettings,
  type SurfaceKind,
} from '../application/preferences';
import { wordProgress } from '../application/lyrics-timing';
import { shouldShowLyricSecondary } from '../application/lyrics-presentation';
import { visibleSurfaceInteractionState, pointerInsideSurface } from '../application/lyrics-surface-interaction';
import type { LyricDocument, LyricLine, LyricWord } from '../domain/music';
import { joinArtistNames } from '../utils/format';
import { IconButton } from '../components/ui/IconButton';
import { resolveArtworkSource } from '../application/artwork-resolver';
import { useSafeArtworkSource } from '../application/artwork-source';
import { getYaqmcClient } from '../application/yaqmc-runtime';

export interface SurfaceProps {
  kind: SurfaceKind;
  settings: LyricSurfaceSettings;
  projection: TimedProjection | null;
  document: LyricDocument | null;
  current: LyricLine | null;
  next: LyricLine | null;
  wordIndex: number;
}

export function LyricsUnlockControl({ kind }: { kind: SurfaceKind }) {
  const { t } = useTranslation('settings', { keyPrefix: 'surfaces' });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const unlock = async () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      await getYaqmcClient().invoke('lyrics_surface_unlock', { kind });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="lyrics-unlock-root">
      <button
        type="button"
        className="lyrics-unlock-button"
        aria-label={t('unlockSurface', { name: t(kind) })}
        title={t('unlockSurface', { name: t(kind) })}
        data-failed={failed || undefined}
        disabled={pending}
        onClick={() => void unlock()}
      >
        <Unlock size={18} />
      </button>
    </main>
  );
}

type SurfaceStyle = CSSProperties & {
  '--surface-lyric-primary': string;
  '--surface-lyric-secondary': string;
  '--surface-window-opacity': string;
  '--surface-font-size': string;
  '--surface-font-family': string;
  '--surface-text-align': string;
};

function fontFamily(settings: LyricSurfaceSettings): string {
  if (settings.fontMode === 'application') return 'var(--font-display)';
  if (settings.fontMode === 'custom' && settings.customFontFamily.trim()) {
    const family = settings.customFontFamily.replace(/["'\\;]/g, '').trim();
    return `"${family}", "Segoe UI Variable", "Noto Sans SC", sans-serif`;
  }
  return '"Segoe UI Variable", "Segoe UI", "Noto Sans SC", system-ui, sans-serif';
}

function useSurfaceHover(interactive: boolean, rootRef: { current: HTMLElement | null }) {
  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef<number | null>(null);
  const hoverReady = useRef(false);

  const cancelLeave = () => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };
  const confirmPointer = (clientX: number, clientY: number) => {
    if (!interactive || !hoverReady.current) return false;
    if (!pointerInsideSurface(rootRef.current, clientX, clientY)) return false;
    cancelLeave();
    setHovered(true);
    return true;
  };
  const onPointerEnter = (event: { clientX: number; clientY: number }) => {
    confirmPointer(event.clientX, event.clientY);
    cancelLeave();
    if (interactive && hoverReady.current) setHovered(true);
  };
  const onPointerMove = (event: { clientX: number; clientY: number }) => {
    confirmPointer(event.clientX, event.clientY);
  };
  const onPointerLeave = (event: { clientX: number; clientY: number }) => {
    const x = event.clientX;
    const y = event.clientY;
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => {
      if (pointerInsideSurface(rootRef.current, x, y)) {
        setHovered(true);
        return;
      }
      setHovered(false);
    }, 90);
  };

  useEffect(() => {
    const readyTimer = window.setTimeout(() => {
      hoverReady.current = true;
    }, 120);
    return () => {
      window.clearTimeout(readyTimer);
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!interactive || !hovered) return;
    const onMove = (event: PointerEvent) => {
      if (pointerInsideSurface(rootRef.current, event.clientX, event.clientY)) {
        cancelLeave();
        setHovered(true);
      }
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [hovered, interactive, rootRef]);

  return {
    hovered: interactive && hovered,
    onPointerEnter,
    onPointerMove,
    onPointerLeave,
  };
}

function SurfaceWord({
  word,
  state,
  projection,
  documentOffsetMs,
  presentationOffsetMs,
}: {
  word: LyricWord;
  state: 'future' | 'current' | 'complete';
  projection: TimedProjection;
  documentOffsetMs: number;
  presentationOffsetMs: number;
}) {
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (state !== 'current') return;
    const updateProgress = () => {
      const position =
        estimatedSurfacePosition(projection) + presentationOffsetMs - documentOffsetMs;
      element.current?.style.setProperty(
        '--word-progress',
        `${wordProgress(word, position) * 100}%`,
      );
    };
    if (!projection.value.isPlaying) {
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
  }, [documentOffsetMs, presentationOffsetMs, projection, state, word]);
  return (
    <span
      ref={element}
      className="surface-word"
      data-state={state}
      style={{ '--word-progress': state === 'complete' ? '100%' : '0%' } as CSSProperties}
    >
      <span>{word.text}</span>
      <span aria-hidden="true">{word.text}</span>
    </span>
  );
}

function SurfaceLine({
  line,
  wordIndex,
  projection,
  active,
  document,
}: {
  line: LyricLine;
  wordIndex: number;
  projection: TimedProjection | null;
  active: boolean;
  document: LyricDocument | null;
}) {
  const lyrics = usePreferencesStore((state) => state.lyrics);
  const primary =
    active && projection && document?.syncMode === 'word' && line.words.length > 0
      ? line.words.map((word, index) => (
          <SurfaceWord
            key={`${word.startMs}-${index}`}
            word={word}
            state={index < wordIndex ? 'complete' : index === wordIndex ? 'current' : 'future'}
            projection={projection}
            documentOffsetMs={document.metadata.offsetMs}
            presentationOffsetMs={lyrics.timingOffsetMs}
          />
        ))
      : line.text;
  return (
    <span className="lyrics-surface__line" data-active={active || undefined}>
      <span className="lyrics-surface__primary">{primary}</span>
      {shouldShowLyricSecondary(
        lyrics.romanization,
        line.romanization,
        line.text,
        'romanization',
      ) && <small>{line.romanization}</small>}
      {shouldShowLyricSecondary(lyrics.translation, line.translation, line.text, 'translation') && (
        <small>{line.translation}</small>
      )}
    </span>
  );
}

function SurfaceControls({
  kind,
  projection,
}: {
  kind: SurfaceKind;
  projection: TimedProjection | null;
}) {
  const { t } = useTranslation('player');
  const { t: navigation } = useTranslation('navigation');
  const { t: common } = useTranslation('common');
  const { t: surfaces } = useTranslation('settings', { keyPrefix: 'surfaces' });
  return (
    <div className="lyrics-surface__controls yaqmc-no-drag">
      <span className="lyrics-surface__drag yaqmc-drag" data-tauri-drag-region>
        <GripHorizontal size={15} />
      </span>
      <IconButton
        label={t('previous')}
        size="small"
        onClick={() => void getYaqmcClient().player.previous()}
      >
        <SkipBack size={14} fill="currentColor" />
      </IconButton>
      <IconButton
        label={projection?.value.isPlaying ? common('pause') : common('play')}
        size="small"
        onClick={() => void getYaqmcClient().player.toggle()}
      >
        {projection?.value.isPlaying ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}
      </IconButton>
      <IconButton
        label={t('next')}
        size="small"
        onClick={() => void getYaqmcClient().player.next()}
      >
        <SkipForward size={14} fill="currentColor" />
      </IconButton>
      <IconButton
        label={surfaces('lock')}
        size="small"
        onClick={() => void setLyricsSurfaceInteraction(kind, 'passive-locked')}
      >
        <Lock size={14} />
      </IconButton>
      <IconButton
        label={navigation('settings')}
        size="small"
        onClick={() => void showLyricsSettings()}
      >
        <Settings2 size={14} />
      </IconButton>
      <IconButton
        label={common('close')}
        size="small"
        onClick={() => void closeLyricsSurface(kind)}
      >
        <X size={14} />
      </IconButton>
    </div>
  );
}

function EmptyLyric() {
  const { t } = useTranslation('lyrics');
  return <span className="lyrics-surface__empty">{t('timingUnavailable')}</span>;
}

export function DesktopSurface(props: SurfaceProps) {
  const { settings, projection, document, current, next, wordIndex } = props;
  const interactive = settings.interaction === 'interactive';
  const rootRef = useRef<HTMLElement | null>(null);
  const hover = useSurfaceHover(interactive, rootRef);
  const interactionState = visibleSurfaceInteractionState(settings.interaction, hover.hovered);
  const line = current ?? projection?.value.currentLine ?? null;
  return (
    <section
      ref={rootRef}
      className={
        interactive
          ? 'lyrics-surface lyrics-surface--desktop lyrics-surface--interactive'
          : 'lyrics-surface lyrics-surface--desktop'
      }
      data-interaction-state={interactionState}
      data-presentation-background={settings.backgroundOpacity > 0 || undefined}
      onPointerEnter={hover.onPointerEnter}
      onPointerMove={hover.onPointerMove}
      onPointerLeave={hover.onPointerLeave}
    >
      {interactive && <SurfaceControls kind="desktop" projection={projection} />}
      <div className="lyrics-surface__drag-region" />
      <div className="desktop-lyrics__content">
        {line ? (
          <>
            <SurfaceLine
              line={line}
              wordIndex={wordIndex}
              projection={projection}
              document={document}
              active
            />
            {settings.lineMode === 'double' && next && (
              <SurfaceLine
                line={next}
                wordIndex={-1}
                projection={projection}
                document={document}
                active={false}
              />
            )}
          </>
        ) : (
          <EmptyLyric />
        )}
      </div>
    </section>
  );
}

export function IslandSurface(props: SurfaceProps) {
  const { settings, projection, document, current, next, wordIndex } = props;
  const interactive = settings.interaction === 'interactive';
  const rootRef = useRef<HTMLElement | null>(null);
  const hover = useSurfaceHover(interactive, rootRef);
  const interactionState = visibleSurfaceInteractionState(settings.interaction, hover.hovered);
  const track = projection?.value.currentTrack;
  const artworkSource = useSafeArtworkSource(
    track ? resolveArtworkSource(track.artwork, 'small') : null,
  );
  const duration = projection?.value.playbackDurationMs ?? track?.durationMs ?? 0;
  const line = current ?? projection?.value.currentLine ?? null;
  const progressRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = progressRef.current;
    if (!node) return;
    const apply = () => {
      const progress =
        duration > 0
          ? Math.min(100, ((projection ? estimatedSurfacePosition(projection) : 0) / duration) * 100)
          : 0;
      node.style.setProperty('--island-progress', `${progress}%`);
    };
    apply();
    if (!projection?.value.isPlaying) return;
    let frame = 0;
    const tick = () => {
      apply();
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [duration, projection]);

  return (
    <section
      ref={rootRef}
      className={
        interactive
          ? 'lyrics-surface lyrics-surface--island lyrics-surface--interactive'
          : 'lyrics-surface lyrics-surface--island'
      }
      data-interaction-state={interactionState}
      onPointerEnter={hover.onPointerEnter}
      onPointerMove={hover.onPointerMove}
      onPointerLeave={hover.onPointerLeave}
    >
      <div className="island-card">
        {artworkSource && (
          <img src={artworkSource} alt="" draggable={false} referrerPolicy="no-referrer" />
        )}
        <span
          className="island-card__state"
          data-playing={projection?.value.isPlaying || undefined}
        />
        <div className="island-card__copy">
          {line ? (
            <SurfaceLine
              line={line}
              wordIndex={wordIndex}
              projection={projection}
              document={document}
              active
            />
          ) : (
            <EmptyLyric />
          )}
          <div className="island-card__expanded">
            {track && (
              <p>
                <strong>{track.title}</strong>
                <span>{joinArtistNames(track.artists)}</span>
              </p>
            )}
            {settings.lineMode === 'double' && next && (
              <SurfaceLine
                line={next}
                wordIndex={-1}
                projection={projection}
                document={document}
                active={false}
              />
            )}
          </div>
        </div>
        {interactive && <SurfaceControls kind="island" projection={projection} />}
        <span ref={progressRef} className="island-card__progress" />
      </div>
    </section>
  );
}

export function LyricsSurfaceApp({ kind }: { kind: SurfaceKind }) {
  usePreferencesRuntime(false);
  const settings = usePreferencesStore((state) => state.surfaces[kind]);
  const runtime = useLyricsSurfaceRuntime();
  const projected = useProjectedLyrics(runtime.projection, runtime.document);
  const style = {
    '--surface-lyric-primary': settings.primaryColor,
    '--surface-lyric-secondary': settings.secondaryColor,
    '--surface-window-opacity': String(settings.backgroundOpacity / 100),
    '--surface-font-size': `${settings.fontSize}px`,
    '--surface-font-family': fontFamily(settings),
    '--surface-text-align': settings.alignment,
  } as SurfaceStyle;
  const props: SurfaceProps = {
    kind,
    settings,
    projection: runtime.projection,
    document: runtime.document,
    current: projected.current,
    next: projected.next,
    wordIndex: projected.wordIndex,
  };
  return (
    <main className="lyrics-surface-root" data-kind={kind} style={style}>
      {kind === 'desktop' ? (
        <DesktopSurface key={settings.interaction} {...props} />
      ) : (
        <IslandSurface key={settings.interaction} {...props} />
      )}
    </main>
  );
}
