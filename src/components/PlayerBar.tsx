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
import type { CSSProperties } from 'react';
import type { TFunction } from 'i18next';
import { useCurrentSong, usePlayerStore, type PlaybackFailure } from '../application/player-store';
import { formatDuration, joinArtistNames } from '../utils/format';
import { Artwork } from './ui/Artwork';
import { IconButton } from './ui/IconButton';
import { useTranslation } from 'react-i18next';

function VolumeIcon({ muted, volume }: { muted: boolean; volume: number }) {
  if (muted || volume === 0) return <VolumeX size={17} />;
  if (volume < 0.5) return <Volume1 size={17} />;
  return <Volume2 size={17} />;
}

export function PlayerBar() {
  const { t } = useTranslation('player');
  const { t: common } = useTranslation('common');
  const current = useCurrentSong();
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

  const duration = playbackDurationMs ?? current?.durationMs ?? 0;
  const progress = duration === 0 ? 0 : (positionMs / duration) * 100;
  const volumeProgress = (isMuted ? 0 : volume) * 100;
  const playbackStatus = playbackLabel(playbackState, playbackError, t);

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
            </div>
            <IconButton label={t('favorite')} size="small" active={current.isFavorite}>
              <Heart size={15} fill={current.isFavorite ? 'currentColor' : 'none'} />
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
          <span>{formatDuration(positionMs)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={1_000}
            value={Math.min(positionMs, duration)}
            onChange={(event) => seek(Number(event.target.value))}
            disabled={!current}
            aria-label={t('position')}
            style={{ '--range-progress': `${progress}%` } as CSSProperties}
          />
          <span>{formatDuration(duration)}</span>
        </div>
      </div>

      <div className="player-bar__tools">
        <IconButton label={t('showLyrics')} size="small" active={lyricsOpen} onClick={toggleLyrics}>
          <Mic2 size={16} />
        </IconButton>
        <IconButton label={t('showQueue')} size="small" active={queueOpen} onClick={toggleQueue}>
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
        <IconButton label={t('fullscreen')} size="small" disabled>
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
