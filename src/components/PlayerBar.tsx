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
import { useContext, type CSSProperties } from 'react';
import type { TFunction } from 'i18next';
import { useAccountStore, useFavoriteState } from '../application/account-runtime';
import { useCurrentSong, usePlayerStore, type PlaybackFailure } from '../application/player-store';
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
  const {
    positionMs,
    isPlaying,
    volume,
    isMuted,
    playbackState,
    playbackDurationMs,
    playbackError,
    sourceSelection,
    queueOpen,
    lyricsOpen,
    isScrubbing,
    scrubPosition,
    togglePlayback,
    next,
    previous,
    seek,
    beginScrub,
    previewScrub,
    commitScrub,
    setVolume,
    setQuality,
    toggleMuted,
    toggleQueue,
    toggleLyrics,
    openLyrics,
  } = usePlayerStore();

  const timelineDuration = playbackDurationMs ?? current?.durationMs ?? 0;
  const previewStartMs =
    sourceSelection?.preview && current?.playbackCapability?.status === 'preview'
      ? current.playbackCapability.startMs
      : 0;
  const duration = Math.max(0, timelineDuration - previewStartMs);
  const timelinePosition = isScrubbing ? scrubPosition : positionMs;
  const displayPosition = Math.max(0, Math.min(timelinePosition - previewStartMs, duration));
  const progress = duration === 0 ? 0 : (displayPosition / duration) * 100;
  const volumeProgress = (isMuted ? 0 : volume) * 100;
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
        <div className="player-progress">
          <span>{formatDuration(displayPosition)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={1_000}
            value={displayPosition}
            onPointerDown={() => beginScrub()}
            onPointerUp={(event) => commitScrub(Number(event.currentTarget.value) + previewStartMs)}
            onPointerCancel={(event) =>
              commitScrub(Number(event.currentTarget.value) + previewStartMs)
            }
            onChange={(event) => {
              const next = Number(event.target.value) + previewStartMs;
              if (isScrubbing) previewScrub(next);
              else seek(next);
            }}
            disabled={!current}
            aria-label={t('position')}
            style={{ '--range-progress': `${progress}%` } as CSSProperties}
          />
          <span>{formatDuration(duration)}</span>
        </div>
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
        <div className="volume-control">
          <IconButton label={isMuted ? t('unmute') : t('mute')} size="small" onClick={toggleMuted}>
            <VolumeIcon muted={isMuted} volume={volume} />
          </IconButton>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={isMuted ? 0 : volume}
            onChange={(event) => setVolume(Number(event.target.value))}
            aria-label={t('volume')}
            style={{ '--range-progress': `${volumeProgress}%` } as CSSProperties}
          />
        </div>
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
