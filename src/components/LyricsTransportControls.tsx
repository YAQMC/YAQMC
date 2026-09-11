import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  clampTransportPositionMs,
  transportDefinitionCssVariables,
  transportIconIdFor,
  transportProgressPercent,
  TRANSPORT_CONTROL_ACTIONS,
  type LyricsTransportActionId,
  type LyricsTransportControlActionId,
  type ResolvedLyricsTransportDefinition,
  type LyricsTransportIconId,
} from '../application/lyrics-transport';
import { formatDuration } from '../utils/format';
import { IconButton } from './ui/IconButton';
import {
  ChevronsLeft,
  ChevronsRight,
  CirclePause,
  CirclePlay,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from 'lucide-react';

/**
 * Shared transport bar renderer.
 *
 * Window/fullscreen containers and plugin declarations all render through this
 * component: presets only choose which actions are visible, in which order, and
 * which colors, metric sizes and icon glyphs are used. Playback is never
 * touched directly - every control calls the typed player-store actions passed
 * in by the container.
 *
 * Declared action order is honoured inside each region (identity and controls).
 * The timeline keeps the conventional elapsed / range / total reading order so
 * the grid stays stable, and the regions never depend on a fixed pixel height:
 * the bar wraps instead of overflowing.
 */
export interface LyricsTransportControlsProps {
  definition: ResolvedLyricsTransportDefinition;
  artworkSource: string | null;
  title: string;
  artistLabel: string;
  isPlaying: boolean;
  active?: boolean;
  positionMs: number;
  durationMs: number;
  getPositionMs: () => number;
  onPrevious: () => void;
  onTogglePlayback: () => void;
  onNext: () => void;
  onBeginScrub: () => void;
  onPreviewScrub: (positionMs: number) => void;
  onCommitScrub: (positionMs: number) => void;
  onCancelScrub?: () => void;
  /** Extra classes let each container reuse its own positioning/layout rules. */
  className?: string;
}

const IDENTITY_ACTIONS: readonly LyricsTransportActionId[] = ['artwork', 'track'];

function TransportIcon({ icon, isPlaying }: { icon: LyricsTransportIconId; isPlaying: boolean }) {
  switch (icon) {
    case 'chevrons-back':
      return <ChevronsLeft size={18} />;
    case 'chevrons-forward':
      return <ChevronsRight size={18} />;
    case 'circle-play':
      return isPlaying ? <CirclePause size={18} /> : <CirclePlay size={18} />;
    case 'skip-back':
      return <SkipBack size={18} fill="currentColor" />;
    case 'skip-forward':
      return <SkipForward size={18} fill="currentColor" />;
    case 'play-pause':
    default:
      return isPlaying ? (
        <Pause size={18} fill="currentColor" />
      ) : (
        <Play size={18} fill="currentColor" />
      );
  }
}

export function LyricsTransportControls({
  definition,
  artworkSource,
  title,
  artistLabel,
  isPlaying,
  active = true,
  positionMs,
  durationMs,
  getPositionMs,
  onPrevious,
  onTogglePlayback,
  onNext,
  onBeginScrub,
  onPreviewScrub,
  onCommitScrub,
  onCancelScrub,
  className,
}: LyricsTransportControlsProps) {
  const { t: player } = useTranslation('player');
  const { t: common } = useTranslation('common');
  const input = useRef<HTMLInputElement>(null);
  const elapsed = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);
  const [draft, setDraft] = useState<number | null>(null);
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const canSeek = definition.canSeek && duration > 0;
  // Reset only the local draft when permissions change; the effect below cancels
  // the host preview without committing a seek.
  if (!canSeek && draft !== null) setDraft(null);
  const displayPosition = clampTransportPositionMs(draft ?? positionMs, duration);
  const progress = transportProgressPercent(displayPosition, duration);
  const actions = definition.actions;
  const identityActions = IDENTITY_ACTIONS.filter((action) => actions.includes(action));
  const controlActions = actions.filter((action): action is LyricsTransportControlActionId =>
    TRANSPORT_CONTROL_ACTIONS.includes(action),
  );
  const showsProgress = actions.includes('progress');
  const showsTime = actions.includes('time');
  const style = transportDefinitionCssVariables(definition) as CSSProperties;

  // Resync whenever the authoritative timeline moves (seek, sample snapshot) or
  // the duration changes; the frame loop below keeps interpolating in between.
  useLayoutEffect(() => {
    if (dragging.current || draft !== null) return;
    const ms = clampTransportPositionMs(isPlaying ? getPositionMs() : positionMs, duration);
    if (elapsed.current) elapsed.current.textContent = formatDuration(ms);
    const node = input.current;
    if (!node) return;
    node.value = String(ms);
    node.style.setProperty('--range-progress', `${transportProgressPercent(ms, duration)}%`);
  }, [draft, duration, getPositionMs, isPlaying, positionMs, showsProgress, showsTime]);

  useEffect(() => {
    if (!active || !isPlaying || draft !== null || (!showsProgress && !showsTime)) return;
    let frame = 0;
    let lastLabel = '';
    const tick = () => {
      if (!dragging.current) {
        const ms = clampTransportPositionMs(getPositionMs(), duration);
        const node = input.current;
        if (node) {
          node.value = String(ms);
          node.style.setProperty('--range-progress', `${transportProgressPercent(ms, duration)}%`);
        }
        const label = formatDuration(ms);
        if (elapsed.current && label !== lastLabel) {
          lastLabel = label;
          elapsed.current.textContent = label;
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    const updateVisibility = () => {
      window.cancelAnimationFrame(frame);
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', updateVisibility);
    updateVisibility();
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, [active, draft, duration, getPositionMs, isPlaying, showsProgress, showsTime]);

  useEffect(() => {
    if (!canSeek) {
      if (dragging.current) onCancelScrub?.();
      dragging.current = false;
    }
  }, [canSeek, onCancelScrub]);

  useEffect(
    () => () => {
      if (dragging.current) onCancelScrub?.();
      dragging.current = false;
    },
    [onCancelScrub],
  );

  const cancel = () => {
    if (dragging.current) onCancelScrub?.();
    dragging.current = false;
    setDraft(null);
  };

  const capture = (event: PointerEvent<HTMLInputElement>) => {
    if (!canSeek) return;
    dragging.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events and embedded surfaces are not always capturable.
    }
    onBeginScrub();
    setDraft(Number(event.currentTarget.value));
  };

  const release = (event: PointerEvent<HTMLInputElement> | KeyboardEvent<HTMLInputElement>) => {
    if (!canSeek || !dragging.current) return;
    dragging.current = false;
    const next = clampTransportPositionMs(Number(event.currentTarget.value), duration);
    setDraft(null);
    onCommitScrub(next);
  };

  return (
    <div
      className={['lyrics-transport', className].filter(Boolean).join(' ')}
      data-surface={definition.surface}
      data-layout={definition.layout}
      data-identity={identityActions.length > 0 || undefined}
      data-transport-preset={definition.id}
      style={style}
    >
      {identityActions.map((action) =>
        action === 'artwork' ? (
          <span key="artwork" className="lyrics-transport__artwork" aria-hidden="true">
            {artworkSource && <img src={artworkSource} alt="" loading="eager" draggable={false} />}
          </span>
        ) : (
          <div key="track" className="lyrics-transport__track">
            <strong>{title}</strong>
            <span>{artistLabel}</span>
          </div>
        ),
      )}
      {controlActions.length > 0 && (
        <div className="lyrics-stage__control-buttons lyrics-transport__controls">
          {controlActions.map((action) => {
            const icon = transportIconIdFor(definition, action);
            if (action === 'playPause') {
              return (
                <button
                  key={action}
                  type="button"
                  className="lyrics-stage__play lyrics-transport__control lyrics-transport__play"
                  onClick={onTogglePlayback}
                  aria-label={isPlaying ? common('pause') : common('play')}
                >
                  <TransportIcon icon={icon} isPlaying={isPlaying} />
                </button>
              );
            }
            return (
              <IconButton
                key={action}
                label={player(action === 'previous' ? 'previous' : 'next')}
                size="large"
                className="lyrics-transport__control"
                onClick={action === 'previous' ? onPrevious : onNext}
              >
                <TransportIcon icon={icon} isPlaying={isPlaying} />
              </IconButton>
            );
          })}
        </div>
      )}
      {(showsProgress || showsTime) && (
        <div className="lyrics-stage__progress lyrics-transport__progress">
          {showsTime && <span ref={elapsed}>{formatDuration(displayPosition)}</span>}
          {showsProgress && (
            <input
              ref={input}
              type="range"
              min={0}
              max={Math.max(duration, 1)}
              step={1}
              disabled={!canSeek}
              defaultValue={displayPosition}
              onPointerDown={capture}
              onPointerUp={release}
              onPointerCancel={cancel}
              onLostPointerCapture={cancel}
              onBlur={cancel}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  cancel();
                  return;
                }
                if (
                  !canSeek ||
                  ![
                    'ArrowLeft',
                    'ArrowRight',
                    'ArrowUp',
                    'ArrowDown',
                    'Home',
                    'End',
                    'PageUp',
                    'PageDown',
                  ].includes(event.key)
                )
                  return;
                if (!dragging.current) onBeginScrub();
                dragging.current = true;
                setDraft(Number(event.currentTarget.value));
              }}
              onKeyUp={release}
              onChange={(event) => {
                if (!canSeek || !dragging.current) return;
                const next = Number(event.target.value);
                setDraft(next);
                onPreviewScrub(next);
              }}
              onInput={(event) => {
                if (!canSeek || !dragging.current) return;
                const next = Number(event.currentTarget.value);
                setDraft(next);
                onPreviewScrub(next);
              }}
              aria-label={player('position')}
              style={{ '--range-progress': `${progress}%` } as CSSProperties}
            />
          )}
          {showsTime && <span>{formatDuration(duration)}</span>}
        </div>
      )}
    </div>
  );
}
