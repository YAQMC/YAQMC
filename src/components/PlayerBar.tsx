import {
  Heart,
  AudioLines,
  ListMusic,
  Mic2,
  Pause,
  Play,
  Puzzle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { TFunction } from 'i18next';
import { useAccountStore, useFavoriteState } from '../application/account-runtime';
import {
  getEstimatedPositionMs,
  useCurrentSong,
  usePlayerStore,
  type PlaybackFailure,
} from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import { isAccountMusicProvider } from '../providers/music-provider';
import { formatDuration, joinArtistNames } from '../utils/format';
import { Artwork } from './ui/Artwork';
import { IconButton } from './ui/IconButton';
import { Select, type SelectOption } from './ui/Select';
import { PlaybackModeControl } from './PlaybackModeControl';
import { useTranslation } from 'react-i18next';
import { dispatchPluginUiAction } from '../application/plugin-runtime';
import { usePluginUiSnapshot } from '../application/plugin-ui';
import type { AudioQuality, AudioQualityPreference, QualityCapabilityState } from '../domain/music';

function VolumeIcon({ muted, volume }: { muted: boolean; volume: number }) {
  if (muted || volume === 0) return <VolumeX size={17} />;
  if (volume < 0.5) return <Volume1 size={17} />;
  return <Volume2 size={17} />;
}

function PlayerProgressSlider({
  current,
  t,
}: {
  current: ReturnType<typeof useCurrentSong>;
  t: TFunction<'player'>;
}) {
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const isScrubbing = usePlayerStore((state) => state.isScrubbing);
  const playbackDurationMs = usePlayerStore((state) => state.playbackDurationMs);
  const pausedPositionMs = usePlayerStore((state) => (state.isPlaying ? null : state.positionMs));
  const beginScrub = usePlayerStore((state) => state.beginScrub);
  const previewScrub = usePlayerStore((state) => state.previewScrub);
  const commitScrub = usePlayerStore((state) => state.commitScrub);
  const dragging = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [visualMs, setVisualMs] = useState(() => getEstimatedPositionMs());
  const duration = playbackDurationMs ?? current?.durationMs ?? 0;
  const displayPosition = draft ?? visualMs;
  const progress = duration === 0 ? 0 : (displayPosition / duration) * 100;

  const writeFill = (ms: number, max: number) => {
    const fill = fillRef.current;
    if (!fill || max <= 0) return;
    fill.style.transform = `scaleX(${Math.min(1, Math.max(0, ms / max))})`;
  };

  useEffect(() => {
    if (pausedPositionMs === null) return;
    if (!dragging.current) setVisualMs(pausedPositionMs);
  }, [pausedPositionMs]);

  useEffect(() => {
    if (!isPlaying || isScrubbing) return;
    let frame = 0;
    let lastLabel = '';
    let lastCommit = 0;
    const tick = (now: number) => {
      if (!dragging.current) {
        const ms = getEstimatedPositionMs();
        const max = duration || Number(inputRef.current?.max) || 1;
        if (document.documentElement.dataset.compositorProbe !== 'no-progress-raf') {
          writeFill(ms, max);
        }
        const label = formatDuration(ms);
        if (timeRef.current && label !== lastLabel) {
          timeRef.current.textContent = label;
          lastLabel = label;
        }
        if (now - lastCommit >= 250) {
          lastCommit = now;
          setVisualMs(ms);
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [duration, isPlaying, isScrubbing]);

  const capture = (event: ReactPointerEvent<HTMLInputElement>) => {
    dragging.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic Playwright/jsdom pointer events may not be capturable.
    }
    beginScrub();
    setDraft(Number(event.currentTarget.value));
  };
  const release = (
    event: ReactPointerEvent<HTMLInputElement> | ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    dragging.current = false;
    const next = Number(event.currentTarget.value);
    setDraft(null);
    setVisualMs(next);
    commitScrub(next);
  };

  return (
    <div className="player-progress">
      <span ref={timeRef}>{formatDuration(displayPosition)}</span>
      <div className="player-progress__track">
        <span
          ref={fillRef}
          className="player-progress__fill"
          style={{ transform: `scaleX(${progress / 100})` }}
        />
        <input
          ref={inputRef}
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          step={1}
          value={displayPosition}
          onPointerDown={capture}
          onPointerUp={release}
          onPointerCancel={release}
          onKeyDown={(event) => {
            dragging.current = true;
            beginScrub();
            setDraft(Number(event.currentTarget.value));
          }}
          onKeyUp={release}
          onChange={(event) => {
            if (!dragging.current) return;
            const next = Number(event.target.value);
            setDraft(next);
            writeFill(next, duration || 1);
            previewScrub(next);
          }}
          onInput={(event) => {
            if (!dragging.current) return;
            const next = Number(event.currentTarget.value);
            setDraft(next);
            writeFill(next, duration || 1);
            previewScrub(next);
          }}
          disabled={!current}
          aria-label={t('position')}
        />
      </div>
      <span>{formatDuration(duration)}</span>
    </div>
  );
}

function PlayerVolumeSlider({ t }: { t: TFunction<'player'> }) {
  const volume = usePlayerStore((state) => state.volume);
  const isMuted = usePlayerStore((state) => state.isMuted);
  const beginVolumeScrub = usePlayerStore((state) => state.beginVolumeScrub);
  const setVolume = usePlayerStore((state) => state.setVolume);
  const toggleMuted = usePlayerStore((state) => state.toggleMuted);
  const dragging = useRef(false);
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? (isMuted ? 0 : volume);
  const volumeProgress = shown * 100;

  const capture = (event: ReactPointerEvent<HTMLInputElement>) => {
    dragging.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic Playwright/jsdom pointer events may not be capturable.
    }
    beginVolumeScrub();
    setDraft(Number(event.currentTarget.value));
  };
  const release = (
    event: ReactPointerEvent<HTMLInputElement> | ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    dragging.current = false;
    const next = Number(event.currentTarget.value);
    setDraft(null);
    setVolume(next);
  };

  return (
    <div className="volume-control yaqmc-no-drag">
      <IconButton label={isMuted ? t('unmute') : t('mute')} size="small" onClick={toggleMuted}>
        <VolumeIcon muted={isMuted} volume={shown} />
      </IconButton>
      <input
        type="range"
        className="yaqmc-no-drag"
        min={0}
        max={1}
        step={0.01}
        value={shown}
        onPointerDown={capture}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={(event) => {
          dragging.current = true;
          beginVolumeScrub();
          setDraft(Number(event.currentTarget.value));
        }}
        onKeyUp={release}
        onChange={(event) => {
          if (!dragging.current) return;
          const next = Number(event.target.value);
          setDraft(next);
          setVolume(next);
        }}
        onInput={(event) => {
          if (!dragging.current) return;
          const next = Number(event.currentTarget.value);
          setDraft(next);
          setVolume(next);
        }}
        aria-label={t('volume')}
        style={{ '--range-progress': `${volumeProgress}%` } as CSSProperties}
      />
    </div>
  );
}

interface PlayerBarProps {
  onCloseLyrics?: () => void;
  onToggleQueue?: () => void;
}

export function PlayerBar({ onCloseLyrics, onToggleQueue }: PlayerBarProps) {
  const { t } = useTranslation('player');
  const { t: common } = useTranslation('common');
  const pluginBar = usePluginUiSnapshot().playerBar;
  const current = useCurrentSong();
  const provider = useContext(ProviderContext);
  const accountProvider = provider && isAccountMusicProvider(provider) ? provider : null;
  const accountSnapshot = useAccountStore((state) => state.snapshot);
  const setFavorite = useAccountStore((state) => state.setFavorite);
  const { favorite, pending: favoritePending } = useFavoriteState(
    current?.id,
    current?.isFavorite ?? false,
  );
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const playbackState = usePlayerStore((state) => state.playbackState);
  const playbackError = usePlayerStore((state) => state.playbackError);
  const sourceSelection = usePlayerStore((state) => state.sourceSelection);
  const queueOpen = usePlayerStore((state) => state.queueOpen);
  const lyricsOpen = usePlayerStore((state) => state.lyricsOpen);
  const togglePlayback = usePlayerStore((state) => state.togglePlayback);
  const next = usePlayerStore((state) => state.next);
  const previous = usePlayerStore((state) => state.previous);
  const setQuality = usePlayerStore((state) => state.setQuality);
  const toggleQueue = usePlayerStore((state) => state.toggleQueue);
  const toggleLyrics = usePlayerStore((state) => state.toggleLyrics);
  const openLyrics = usePlayerStore((state) => state.openLyrics);
  const playbackStatus = playbackLabel(playbackState, playbackError, t);
  const favoriteLabel = current
    ? favoritePending
      ? t('favoritePending', { title: current.title })
      : favorite
        ? t('removeFavorite', { title: current.title })
        : t('addFavorite', { title: current.title })
    : t('favorite');
  const hasWritableProviderReference =
    current?.provider?.providerId === accountProvider?.id &&
    Boolean(current?.provider?.trackId.trim());
  const favoriteAvailable =
    current !== undefined &&
    accountProvider !== null &&
    (accountSnapshot.state !== 'authenticated' ||
      (accountSnapshot.capabilities.favoriteWrite && hasWritableProviderReference));
  const selectedQuality = sourceSelection?.requestedQuality ?? 'automatic';
  const capabilityByQuality = new Map(
    sourceSelection?.qualityCapabilities?.map((capability) => [capability.quality, capability]),
  );
  const qualityOption = (
    quality: AudioQuality,
    label: string,
  ): SelectOption<AudioQualityPreference> => {
    const capability = capabilityByQuality.get(quality);
    return {
      value: quality,
      label,
      description: capability ? qualityCapabilityLabel(capability, t) : undefined,
      disabled: capability ? !capability.playable : false,
    };
  };
  const qualityOptions: readonly SelectOption<AudioQualityPreference>[] = [
    {
      value: 'automatic',
      label: t('qualityAutomatic'),
      description: sourceSelection
        ? t('qualityAutomaticResolved', {
            quality: qualityLabel(sourceSelection.resolvedQuality, t),
          })
        : undefined,
    },
    qualityOption('standard', t('qualityStandard')),
    qualityOption('high', t('qualityHigh')),
    qualityOption('lossless', t('qualityLossless')),
    qualityOption('master', t('qualityMaster')),
  ];

  return (
    <footer className="player-bar" aria-label={t('region')} data-yaqmc="player-bar">
      <div className="player-bar__track">
        {current ? (
          <>
            <button
              type="button"
              className="player-bar__artwork-button"
              aria-label={t('openLyrics')}
              onClick={openLyrics}
            >
              <Artwork
                artwork={current.artwork}
                className="player-bar__artwork"
                loading="eager"
                purpose="small"
              />
            </button>
            <div className="player-bar__track-copy">
              <strong data-yaqmc="track-title">{current.title}</strong>
              <span>{joinArtistNames(current.artists)}</span>
              {playbackState !== 'playing' && playbackState !== 'paused' && (
                <small data-state={playbackState} title={playbackStatus || undefined}>
                  {playbackStatus}
                </small>
              )}
              {sourceSelection?.fallbackReason && (
                <small
                  className="player-bar__fallback"
                  data-fallback-reason={sourceSelection.fallbackReason}
                >
                  {playbackFallbackLabel(sourceSelection.fallbackReason, t)}
                </small>
              )}
            </div>
            <IconButton
              label={favoriteLabel}
              size="small"
              active={favorite}
              disabled={!favoriteAvailable || favoritePending}
              onClick={() => {
                if (accountProvider) void setFavorite(accountProvider, current, !favorite);
              }}
            >
              <Heart size={15} fill={favorite ? 'currentColor' : 'none'} />
            </IconButton>
          </>
        ) : (
          <div className="player-bar__empty">{t('choose')}</div>
        )}
      </div>

      <div className="player-bar__center">
        <div className="player-controls">
          <PlaybackModeControl />
          <IconButton label={t('previous')} size="small" onClick={previous} disabled={!current}>
            <SkipBack size={17} fill="currentColor" />
          </IconButton>
          <button
            type="button"
            className="player-controls__play"
            onClick={togglePlayback}
            disabled={!current}
            aria-label={isPlaying ? common('pause') : common('play')}
          >
            {isPlaying ? (
              <Pause size={19} fill="currentColor" />
            ) : (
              <Play size={19} fill="currentColor" />
            )}
          </button>
          <IconButton label={t('next')} size="small" onClick={next} disabled={!current}>
            <SkipForward size={17} fill="currentColor" />
          </IconButton>
        </div>
        <PlayerProgressSlider current={current} t={t} />
      </div>

      <div className="player-bar__tools">
        <Select
          value={selectedQuality}
          options={qualityOptions}
          onChange={setQuality}
          ariaLabel={t('qualityMenu')}
          icon={AudioLines}
          className="player-quality-select"
          disabled={!current || current.provider?.providerId !== 'qqmusic'}
        />
        <IconButton
          label={t('showLyrics')}
          size="small"
          active={lyricsOpen}
          onClick={lyricsOpen && onCloseLyrics ? onCloseLyrics : toggleLyrics}
        >
          <Mic2 size={16} />
        </IconButton>
        <IconButton
          label={t('showQueue')}
          size="small"
          active={queueOpen}
          onClick={onToggleQueue ?? toggleQueue}
        >
          <ListMusic size={16} />
        </IconButton>
        {pluginBar.map((action) => (
          <IconButton
            key={`${action.pluginId}:${action.id}`}
            label={`${action.pluginName}: ${action.label}`}
            size="small"
            onClick={() => dispatchPluginUiAction(action.pluginId, action.id, 'playerBar')}
          >
            <Puzzle size={16} />
          </IconButton>
        ))}
        <PlayerVolumeSlider t={t} />
      </div>
    </footer>
  );
}

function playbackLabel(
  state: string,
  error: PlaybackFailure | null,
  t: TFunction<'player'>,
): string {
  if (state === 'loading') return t('resolving');
  if (state === 'buffering') return t('preparing');
  if (state === 'ended') return t('ended');
  if (state === 'stopped') return t('stopped');
  if (state.endsWith('error')) return playbackErrorLabel(error?.code, t);
  return state === 'idle' ? '' : t('unavailable');
}

type PlaybackErrorKey =
  | 'errorTrackUnavailable'
  | 'errorNetwork'
  | 'errorOutput'
  | 'errorDecoder'
  | 'errorEntitlement'
  | 'errorEntitlementUnknown'
  | 'errorDecryption'
  | 'errorSession'
  | 'errorSeek'
  | 'errorCache';

const playbackErrorKeys: Readonly<Record<string, PlaybackErrorKey>> = {
  'media-url-unavailable': 'errorTrackUnavailable',
  'track-unavailable': 'errorTrackUnavailable',
  'media-url-expired': 'errorNetwork',
  'network-failure': 'errorNetwork',
  'output-device-unavailable': 'errorOutput',
  'audio-engine-unavailable': 'errorOutput',
  'media-open-failed': 'errorDecoder',
  'decoder-unsupported': 'errorDecoder',
  'entitlement-insufficient': 'errorEntitlement',
  'entitlement-unknown': 'errorEntitlementUnknown',
  'media-decryption-failed': 'errorDecryption',
  'authentication-expired': 'errorSession',
  'http-range-unsupported': 'errorSeek',
  'seek-unsupported': 'errorSeek',
  'media-too-large': 'errorCache',
  'media-cache-failure': 'errorCache',
};

function playbackErrorLabel(code: string | undefined, t: TFunction<'player'>): string {
  const key = code ? playbackErrorKeys[code] : undefined;
  return key ? t(key) : t('unavailable');
}

function playbackFallbackLabel(
  reason:
    | 'source-unavailable'
    | 'account-rights'
    | 'entitlement-unknown'
    | 'client-unsupported'
    | 'preview-only',
  t: TFunction<'player'>,
): string {
  if (reason === 'account-rights') return t('fallbackAccountRights');
  if (reason === 'entitlement-unknown') return t('fallbackEntitlementUnknown');
  if (reason === 'client-unsupported') return t('fallbackClientUnsupported');
  if (reason === 'preview-only') return t('fallbackPreviewOnly');
  return t('fallbackSourceUnavailable');
}

function qualityCapabilityLabel(
  capability: QualityCapabilityState,
  t: TFunction<'player'>,
): string {
  return t('qualityCapabilitySummary', {
    entitlement: t(`qualityEntitlement.${capability.entitlement}`),
    resource: t(`qualityResource.${capability.resource}`),
    client: t(`qualityClient.${capability.client}`),
  });
}

function qualityLabel(quality: AudioQuality, t: TFunction<'player'>): string {
  if (quality === 'standard') return t('qualityStandard');
  if (quality === 'high') return t('qualityHigh');
  if (quality === 'lossless') return t('qualityLossless');
  return t('qualityMaster');
}
