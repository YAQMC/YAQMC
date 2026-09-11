import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FocusEvent,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ResolvedLyricsTransportDefinition,
  LyricsTransportSurface,
} from '../application/lyrics-transport';
import { useLyricsTransportDefinition } from '../application/use-lyrics-transport';
import { getEstimatedPositionMs, usePlayerStore } from '../application/player-store';
import { joinArtistNames } from '../utils/format';
import { LyricsTransportControls } from './LyricsTransportControls';

const HIDE_DELAY_MS = 2_400;

export interface LyricsFullscreenTransportHandle {
  reveal(): void;
}

interface LyricsFullscreenTransportProps {
  ref?: Ref<LyricsFullscreenTransportHandle>;
  artworkSource: string | null;
  /**
   * `fullscreen` renders the immersive overlay; `window` renders the compact
   * bar used by the windowed lyrics page. Both share one implementation.
   */
  surface?: LyricsTransportSurface;
}

export function LyricsFullscreenTransport({
  ref,
  artworkSource,
  surface = 'fullscreen',
}: LyricsFullscreenTransportProps) {
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
  const beginScrub = usePlayerStore((state) => state.beginScrub);
  const previewScrub = usePlayerStore((state) => state.previewScrub);
  const commitScrub = usePlayerStore((state) => state.commitScrub);
  const cancelScrub = usePlayerStore((state) => state.cancelScrub);
  const definition = useLyricsTransportDefinition(surface);

  if (currentId === null) return null;

  return (
    <LyricsFullscreenTransportSurface
      ref={ref}
      surface={surface}
      definition={definition}
      currentTitle={currentTitle}
      currentArtistLabel={currentArtistLabel}
      durationMs={playbackDurationMs ?? currentDurationMs ?? 0}
      artworkSource={artworkSource}
      positionMs={positionMs}
      isPlaying={isPlaying}
      previous={previous}
      togglePlayback={togglePlayback}
      next={next}
      beginScrub={beginScrub}
      previewScrub={previewScrub}
      commitScrub={commitScrub}
      cancelScrub={cancelScrub}
    />
  );
}

interface LyricsFullscreenTransportSurfaceProps {
  ref?: Ref<LyricsFullscreenTransportHandle>;
  surface: LyricsTransportSurface;
  definition: ResolvedLyricsTransportDefinition;
  currentTitle: string;
  currentArtistLabel: string;
  durationMs: number;
  artworkSource: string | null;
  positionMs: number;
  isPlaying: boolean;
  previous: () => void;
  togglePlayback: () => void;
  next: () => void;
  beginScrub: () => void;
  previewScrub: (positionMs: number) => void;
  commitScrub: (positionMs: number) => void;
  cancelScrub: () => void;
}

function LyricsFullscreenTransportSurface({
  ref,
  surface,
  definition,
  currentTitle,
  currentArtistLabel,
  durationMs,
  artworkSource,
  positionMs,
  isPlaying,
  previous,
  togglePlayback,
  next,
  beginScrub,
  previewScrub,
  commitScrub,
  cancelScrub,
}: LyricsFullscreenTransportSurfaceProps) {
  const { t: player } = useTranslation('player');
  const immersive = surface === 'fullscreen';
  // Both surfaces start visible; only the immersive overlay schedules a hide.
  const [visible, setVisible] = useState(true);
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readPositionMs = useCallback(
    () =>
      usePlayerStore.getState().isScrubbing
        ? usePlayerStore.getState().positionMs
        : getEstimatedPositionMs(),
    [],
  );

  const clearTimer = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const reveal = useCallback(() => {
    setVisible(true);
    clearTimer();
    // The windowed bar stays put; only the immersive overlay fades away.
    if (!immersive || !isPlaying || focused) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setVisible(false);
    }, HIDE_DELAY_MS);
  }, [clearTimer, focused, immersive, isPlaying]);

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
    if (!immersive || !isPlaying || focused) return clearTimer;
    timer.current = setTimeout(() => {
      timer.current = null;
      setVisible(false);
    }, HIDE_DELAY_MS);
    return clearTimer;
  }, [clearTimer, focused, immersive, isPlaying]);

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

  return (
    <div
      className="lyrics-fullscreen-transport"
      data-transport-surface={surface}
      data-visible={!immersive || visible || !isPlaying || focused || undefined}
      role="group"
      aria-label={player('region')}
      onFocusCapture={pinVisible}
      onBlurCapture={handleBlurCapture}
    >
      <LyricsTransportControls
        key={definition.id}
        definition={definition}
        artworkSource={artworkSource}
        title={currentTitle}
        artistLabel={currentArtistLabel}
        isPlaying={isPlaying}
        active={!immersive || visible || !isPlaying || focused}
        positionMs={positionMs}
        durationMs={durationMs}
        getPositionMs={readPositionMs}
        onPrevious={previous}
        onTogglePlayback={togglePlayback}
        onNext={next}
        onBeginScrub={beginScrub}
        onPreviewScrub={previewScrub}
        onCommitScrub={commitScrub}
        onCancelScrub={cancelScrub}
        className="lyrics-fullscreen-transport__bar"
      />
    </div>
  );
}
