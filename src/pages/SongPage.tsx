import { Heart, Play } from 'lucide-react';
import { useContext, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore, useFavoriteState } from '../application/account-runtime';
import { ProviderContext } from '../application/provider-context';
import { usePlayerStore } from '../application/player-store';
import type { Song } from '../domain/music';
import { isAccountMusicProvider } from '../providers/music-provider';
import { formatDuration } from '../utils/format';
import { EntityLink } from '../components/EntityLink';
import { Artwork } from '../components/ui/Artwork';
import { ActionMenu, ActionMenuItem } from '../components/ui/ActionMenu';
import { IconButton } from '../components/ui/IconButton';

export function SongPage({ song }: { song: Song }) {
  const { t } = useTranslation('pages', { keyPrefix: 'song' });
  const provider = useContext(ProviderContext);
  const accountProvider = provider && isAccountMusicProvider(provider) ? provider : null;
  const snapshot = useAccountStore((state) => state.snapshot);
  const setFavorite = useAccountStore((state) => state.setFavorite);
  const playTracks = usePlayerStore((state) => state.playTracks);
  const addToQueue = usePlayerStore((state) => state.addToQueue);
  const { favorite, pending } = useFavoriteState(song.id, song.isFavorite);
  const hasWritableProviderReference =
    song.provider?.providerId === accountProvider?.id && Boolean(song.provider?.trackId.trim());
  const favoriteAvailable =
    accountProvider !== null &&
    (snapshot.state !== 'authenticated' ||
      (snapshot.capabilities.favoriteWrite && hasWritableProviderReference));
  const favoriteLabel = pending
    ? t('favoritePending', { title: song.title })
    : favorite
      ? t('removeFavorite', { title: song.title })
      : t('favorite', { title: song.title });

  return (
    <div className="page detail-page song-page">
      <section
        className="detail-hero"
        style={{ '--detail-color': song.artwork.dominantColor } as CSSProperties}
      >
        <Artwork
          artwork={song.artwork}
          className="detail-hero__art"
          loading="eager"
          purpose="large"
        />
        <div className="detail-hero__copy">
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{song.title}</h1>
          <div className="song-page__artists">
            {song.artists.map((artist, index) => (
              <span key={artist.id}>
                {index > 0 && <span aria-hidden="true"> · </span>}
                <EntityLink entity="artist" id={artist.id} className="detail-hero__artist">
                  {artist.name}
                </EntityLink>
              </span>
            ))}
          </div>
          <p className="song-page__album">
            <EntityLink entity="album" id={song.album.id} className="detail-hero__artist">
              {song.album.title}
            </EntityLink>
          </p>
          <p className="detail-hero__meta">
            {t('trackNumber', { number: song.trackNumber })} <span>·</span> {t('duration')}:{' '}
            {formatDuration(song.durationMs)} <span>·</span>{' '}
            {t('quality', { quality: song.quality })}
          </p>
          <div className="detail-hero__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => playTracks([song], undefined, false)}
            >
              <Play size={16} fill="currentColor" />
              {t('play')}
            </button>
            <IconButton
              label={favoriteLabel}
              active={favorite}
              disabled={!favoriteAvailable || pending}
              onClick={() => {
                if (accountProvider) void setFavorite(accountProvider, song, !favorite);
              }}
            >
              <Heart size={18} fill={favorite ? 'currentColor' : 'none'} />
            </IconButton>
            <ActionMenu label={t('more')} className="detail-hero__icon-action">
              <ActionMenuItem onClick={() => addToQueue(song)}>{t('addToQueue')}</ActionMenuItem>
            </ActionMenu>
          </div>
        </div>
      </section>
      <footer className="detail-footer">
        <span>{t('playbackNote')}</span>
      </footer>
    </div>
  );
}
