import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../application/player-store';
import { joinArtistNames } from '../utils/format';
import { IconButton } from './ui/IconButton';

const HIDE_DELAY_MS = 2_400;

export interface LyricsFullscreenTransportHandle {
  reveal(): void;
}

interface LyricsFullscreenTransportProps {
  ref?: Ref<LyricsFullscreenTransportHandle>;
  artworkSource: string | null;
}

export function LyricsFullscreenTransport({ ref, artworkSource }: LyricsFullscreenTransportProps) {
  const currentId = usePlayerStore((state) => state.queue[state.currentIndex]?.id ?? null);
  const currentTitle = usePlayerStore((state) => state.queue[state.currentIndex]?.title ?? '');
  const currentArtistLabel = usePlayerStore((state) =>
    joinArtistNames(state.queue[state.currentIndex]?.artists ?? []),
  );
  const currentDurationMs = usePlayerStore(
    (state) => state.queue[state.currentIndex]?.durationMs ?? null,
  );
  const positionMs = usePlayerStore((state) => state.positionMs);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const playbackDurationMs = usePlayerStore((state) => state.playbackDurationMs);
  const previous = usePlayerStore((state) => state.previous);
  const togglePlayback = usePlayerStore((state) => state.togglePlayback);
  const next = usePlayerStore((state) => state.next);

  if (currentId === null) return null;

  const durationMs = playbackDurationMs ?? currentDurationMs;

  return (
    <LyricsFullscreenTransportSurface
      ref={ref}
      currentId={currentId}
      currentTitle={currentTitle}
      currentArtistLabel={currentArtistLabel}
      currentDurationMs={durationMs}
      artworkSource={artworkSource}
      positionMs={positionMs}
      isPlaying={isPlaying}
      playbackDurationMs={durationMs}
      previous={previous}
      togglePlayback={togglePlayback}
      next={next}
    />
  );
}

interface LyricsFullscreenTransportSurfaceProps {
  ref?: Ref<LyricsFullscreenTransportHandle>;
  currentId: string;
  currentTitle: string;
  currentArtistLabel: string;
  currentDurationMs: number | null;
  artworkSource: string | null;
  positionMs: number;
  isPlaying: boolean;
  playbackDurationMs: number | null;
  previous: () => void;
  togglePlayback: () => void;
  next: () => void;
}

function LyricsFullscreenTransportSurface({
  ref,
  currentId,
  currentTitle,
  currentArtistLabel,
  currentDurationMs,
  artworkSource,
  positionMs,
  isPlaying,
  playbackDurationMs,
  previous,
  togglePlayback,
  next,
}: LyricsFullscreenTransportSurfaceProps) {
  const { t: player } = useTranslation('player');
  const { t: common } = useTranslation('common');
  const [visible, setVisible] = useState(true);
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const reveal = useCallback(() => {
    setVisible(true);
    clearTimer();
    if (!isPlaying || focused) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setVisible(false);
    }, HIDE_DELAY_MS);
  }, [clearTimer, focused, isPlaying]);

  useImperativeHandle(ref, () => ({ reveal }), [reveal]);

  useEffect(
    () =>
      usePlayerStore.subscribe((state, previousState) => {
        const songId = state.queue[state.currentIndex]?.id ?? null;
        const previousSongId = previousState.queue[previousState.currentIndex]?.id ?? null;
        if ((state.isPlaying && !previousState.isPlaying) || songId !== previousSongId) reveal();
      }),
    [reveal],
  );

  useEffect(() => {
    clearTimer();
    if (!isPlaying || focused) return clearTimer;
    timer.current = setTimeout(() => {
      timer.current = null;
      setVisible(false);
    }, HIDE_DELAY_MS);
    return clearTimer;
  }, [clearTimer, currentId, focused, isPlaying]);

  const pinVisible = () => {
    clearTimer();
    setVisible(true);
    setFocused(true);
  };

  const releaseFocus = () => {
    setVisible(true);
    setFocused(false);
  };

  const handleBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      releaseFocus();
    }
  };

  const durationMs = playbackDurationMs ?? currentDurationMs ?? 0;
  const progress =
    durationMs > 0 && Number.isFinite(positionMs)
      ? Math.min(100, Math.max(0, (positionMs / durationMs) * 100))
      : 0;

  return (
    <div
      className="lyrics-fullscreen-transport"
      data-visible={visible || !isPlaying || focused || undefined}
      role="group"
      aria-label={player('region')}
      onFocusCapture={pinVisible}
      onBlurCapture={handleBlurCapture}
    >
      <span className="artwork lyrics-fullscreen-transport__artwork" aria-hidden="true">
        {artworkSource && <img src={artworkSource} alt="" loading="eager" draggable={false} />}
      </span>
      <div className="lyrics-fullscreen-transport__track">
        <strong>{currentTitle}</strong>
        <span>{currentArtistLabel}</span>
      </div>
      <div className="lyrics-fullscreen-transport__controls">
        <IconButton label={player('previous')} size="small" onClick={previous}>
          <SkipBack size={16} fill="currentColor" />
        </IconButton>
        <button
          type="button"
          className="lyrics-fullscreen-transport__play"
          onClick={togglePlayback}
          aria-label={isPlaying ? common('pause') : common('play')}
        >
          {isPlaying ? (
            <Pause size={17} fill="currentColor" />
          ) : (
            <Play size={17} fill="currentColor" />
          )}
        </button>
        <IconButton label={player('next')} size="small" onClick={next}>
          <SkipForward size={16} fill="currentColor" />
        </IconButton>
      </div>
      <span className="lyrics-fullscreen-transport__progress" aria-hidden="true">
        <span
          className="lyrics-fullscreen-transport__progress-fill"
          style={{ transform: `scaleX(${progress / 100})` } as CSSProperties}
        />
      </span>
    </div>
  );
}
