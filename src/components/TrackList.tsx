import { Check, Heart, MoreHorizontal, Pause, Play } from 'lucide-react';
import { usePlayerStore } from '../application/player-store';
import type { Song } from '../domain/music';
import { formatDuration, joinArtistNames } from '../utils/format';
import { useTranslation } from 'react-i18next';

interface TrackListProps {
  tracks: Song[];
  showAlbum?: boolean;
  compact?: boolean;
}

export function TrackList({ tracks, showAlbum = false, compact = false }: TrackListProps) {
  const { t } = useTranslation('player');
  const { t: common } = useTranslation('common');
  const currentId = usePlayerStore((state) => state.queue[state.currentIndex]?.id);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const playTracks = usePlayerStore((state) => state.playTracks);
  const togglePlayback = usePlayerStore((state) => state.togglePlayback);

  const activateTrack = (track: Song) => {
    if (track.id === currentId) {
      togglePlayback();
      return;
    }
    playTracks(tracks, track.id);
  };

  return (
    <div className={`track-list ${compact ? 'track-list--compact' : ''}`} role="table">
      <div className="track-list__header" role="row">
        <span className="track-list__number" role="columnheader">
          #
        </span>
        <span role="columnheader">{t('title')}</span>
        {showAlbum && <span role="columnheader">{t('album')}</span>}
        <span className="track-list__quality" role="columnheader" aria-label={t('quality')} />
        <span className="track-list__duration" role="columnheader">
          {t('time')}
        </span>
        <span className="track-list__actions" role="columnheader" />
      </div>
      <div role="rowgroup">
        {tracks.map((track, index) => {
          const active = track.id === currentId;
          return (
            <button
              type="button"
              className="track-row"
              role="row"
              data-active={active || undefined}
              key={track.id}
              onClick={() => activateTrack(track)}
              aria-label={t('trackAction', {
                action: active && isPlaying ? common('pause') : common('play'),
                title: track.title,
                artist: joinArtistNames(track.artists),
              })}
            >
              <span className="track-list__number track-row__index" role="cell">
                <span className="track-row__ordinal">{index + 1}</span>
                <span className="track-row__play-icon">
                  {active && isPlaying ? (
                    <Pause size={14} fill="currentColor" />
                  ) : (
                    <Play size={14} fill="currentColor" />
                  )}
                </span>
                {active && isPlaying && (
                  <span className="now-playing-bars" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </span>
              <span className="track-row__primary" role="cell">
                <span className="track-row__title">{track.title}</span>
                <span className="track-row__artist">{joinArtistNames(track.artists)}</span>
              </span>
              {showAlbum && (
                <span className="track-row__album" role="cell">
                  {track.album.title}
                </span>
              )}
              <span className="track-list__quality track-row__quality" role="cell">
                {track.quality === 'lossless' && <Check size={12} aria-label={t('lossless')} />}
              </span>
              <span className="track-list__duration" role="cell">
                {formatDuration(track.durationMs)}
              </span>
              <span className="track-list__actions track-row__actions" role="cell">
                {track.isFavorite && (
                  <Heart className="track-row__favorite" size={14} fill="currentColor" />
                )}
                <MoreHorizontal size={16} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
