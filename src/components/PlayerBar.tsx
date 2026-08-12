import {
  Heart,
  ListMusic,
  Maximize2,
  Mic2,
  Pause,
  Play,
  Repeat2,
  Shuffle,
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
import { useTranslation } from 'react-i18next';

function VolumeIcon({ muted, volume }: { muted: boolean; volume: number }) {
  if (muted || volume === 0) return <VolumeX size={17} />;
  if (volume < 0.5) return <Volume1 size={17} />;
  return <Volume2 size={17} />;
}

interface PlayerBarProps {
  onEnterLyricsFullscreen?: () => void;
  onCloseLyrics?: () => void;
  onToggleQueue?: () => void;
  lyricsFullscreenPending?: boolean;
}

export function PlayerBar({
  onEnterLyricsFullscreen,
  onCloseLyrics,
  onToggleQueue,
  lyricsFullscreenPending = false,
}: PlayerBarProps) {
  const { t } = useTranslation('player');
  const { t: lyrics } = useTranslation('lyrics');
  const { t: common } = useTranslation('common');
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
    repeat,
    shuffle,
    playbackState,
    playbackDurationMs,
    playbackError,
    sourceSelection,
    queueOpen,
    lyricsOpen,
    togglePlayback,
    next,
    previous,
    seek,
    setVolume,
    toggleMuted,
    toggleShuffle,
    cycleRepeat,
    toggleQueue,
    toggleLyrics,
  } = usePlayerStore();

  const timelineDuration = playbackDurationMs ?? current?.durationMs ?? 0;
  const previewStartMs =
    sourceSelection?.preview && current?.playbackCapability?.status === 'preview'
      ? current.playbackCapability.startMs
      : 0;
  const duration = Math.max(0, timelineDuration - previewStartMs);
  const displayPosition = Math.max(0, Math.min(positionMs - previewStartMs, duration));
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
    Number.isSafeInteger(current?.provider?.numericId) &&
    (current?.provider?.numericId ?? 0) > 0;
  const favoriteAvailable =
    current !== undefined &&
    accountProvider !== null &&
    (accountSnapshot.state !== 'authenticated' ||
      (accountSnapshot.capabilities.favoriteWrite && hasWritableProviderReference));

  return (
    <footer className="player-bar" aria-label={t('region')}>
      <div className="player-bar__track">
        {current ? (
          <>
            <Artwork artwork={current.artwork} className="player-bar__artwork" loading="eager" />
            <div className="player-bar__track-copy">
              <strong>{current.title}</strong>
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
          <IconButton label={t('shuffle')} size="small" active={shuffle} onClick={toggleShuffle}>
            <Shuffle size={15} />
          </IconButton>
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
          <IconButton
            label={t('repeat', {
              mode:
                repeat === 'off'
                  ? t('repeatOff')
                  : repeat === 'one'
                    ? t('repeatOne')
                    : t('repeatAll'),
            })}
            size="small"
            active={repeat !== 'off'}
            onClick={cycleRepeat}
            className="repeat-button"
          >
            <Repeat2 size={15} />
            {repeat === 'one' && <span className="repeat-button__one">1</span>}
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
            onChange={(event) => seek(Number(event.target.value) + previewStartMs)}
            disabled={!current}
            aria-label={t('position')}
            style={{ '--range-progress': `${progress}%` } as CSSProperties}
          />
          <span>{formatDuration(duration)}</span>
        </div>
      </div>

      <div className="player-bar__tools">
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
        <IconButton
          label={lyrics('enterFullscreen')}
          size="small"
          onClick={onEnterLyricsFullscreen}
          disabled={!onEnterLyricsFullscreen || lyricsFullscreenPending}
        >
          <Maximize2 size={15} />
        </IconButton>
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
  reason: 'source-unavailable' | 'account-rights' | 'preview-only',
  t: TFunction<'player'>,
): string {
  if (reason === 'account-rights') return t('fallbackAccountRights');
  if (reason === 'preview-only') return t('fallbackPreviewOnly');
  return t('fallbackSourceUnavailable');
}
