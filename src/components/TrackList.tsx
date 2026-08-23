import { Check, Heart, Pause, Play } from 'lucide-react';
import { useContext, useRef } from 'react';
import { useFavoriteState, useAccountStore } from '../application/account-runtime';
import { usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import type { Song } from '../domain/music';
import { isAccountMusicProvider } from '../providers/music-provider';
import { formatDuration, joinArtistNames } from '../utils/format';
import { useAddToPlaylistPicker } from './AddToPlaylistPicker';
import { IconButton } from './ui/IconButton';
import { ActionMenu, ActionMenuItem } from './ui/ActionMenu';
import type { ContextMenuItem } from './ui/ContextMenu';
import { useContextMenu } from './ui/use-context-menu';
import { useTranslation } from 'react-i18next';
import { dispatchPluginUiAction } from '../application/plugin-runtime';
import { usePluginUiSnapshot } from '../application/plugin-ui';
import { EntityLink } from './EntityLink';

interface TrackListProps {
  tracks: Song[];
  showAlbum?: boolean;
  compact?: boolean;
}

export function TrackList({ tracks, showAlbum = false, compact = false }: TrackListProps) {
  const { t } = useTranslation('player');
  const currentId = usePlayerStore((state) => state.queue[state.currentIndex]?.id);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const pluginActions = usePluginUiSnapshot().track;
  const artistCounts = new Map<string, number>();
  for (const track of tracks) {
    for (const artist of track.artists) {
      const id = artist.id.trim();
      if (id) artistCounts.set(id, (artistCounts.get(id) ?? 0) + 1);
    }
  }
  const repeatedArtistIds = new Set(
    [...artistCounts].filter(([, count]) => count > 1).map(([id]) => id),
  );

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
        {tracks.map((track, index) => (
          <TrackRow
            key={track.id}
            track={track}
            tracks={tracks}
            index={index}
            active={track.id === currentId}
            isPlaying={isPlaying}
            showAlbum={showAlbum}
            pluginActions={pluginActions}
            repeatedArtistIds={repeatedArtistIds}
          />
        ))}
      </div>
    </div>
  );
}

interface TrackRowProps {
  track: Song;
  tracks: Song[];
  index: number;
  active: boolean;
  isPlaying: boolean;
  showAlbum: boolean;
  pluginActions: readonly { pluginId: string; pluginName: string; id: string; label: string }[];
  repeatedArtistIds: ReadonlySet<string>;
}

function TrackRow({
  track,
  tracks,
  index,
  active,
  isPlaying,
  showAlbum,
  pluginActions,
  repeatedArtistIds,
}: TrackRowProps) {
  const { t } = useTranslation('player');
  const { t: common } = useTranslation('common');
  const provider = useContext(ProviderContext);
  const accountProvider = provider && isAccountMusicProvider(provider) ? provider : null;
  const snapshot = useAccountStore((state) => state.snapshot);
  const setFavorite = useAccountStore((state) => state.setFavorite);
  const playTracks = usePlayerStore((state) => state.playTracks);
  const togglePlayback = usePlayerStore((state) => state.togglePlayback);
  const addToQueue = usePlayerStore((state) => state.addToQueue);
  const addToPlaylist = useAddToPlaylistPicker(track);
  const actionsRef = useRef<HTMLSpanElement>(null);
  const { favorite, pending } = useFavoriteState(track.id, track.isFavorite);
  const playbackAction = active && isPlaying ? common('pause') : common('play');
  const favoriteLabel = pending
    ? t('favoritePending', { title: track.title })
    : favorite
      ? t('removeFavorite', { title: track.title })
      : t('addFavorite', { title: track.title });
  const hasWritableProviderReference =
    track.provider?.providerId === accountProvider?.id && Boolean(track.provider?.trackId.trim());
  const favoriteAvailable =
    accountProvider !== null &&
    (snapshot.state !== 'authenticated' ||
      (snapshot.capabilities.favoriteWrite && hasWritableProviderReference));

  const activateTrack = () => {
    if (active) {
      togglePlayback();
      return;
    }
    playTracks(tracks, track.id);
  };
  const openAddToPlaylist = () => {
    const bounds = actionsRef.current?.getBoundingClientRect();
    addToPlaylist.openAt({
      x: bounds ? Math.min(bounds.right, window.innerWidth - 16) : 24,
      y: bounds ? bounds.bottom + 6 : 24,
    });
  };
  const contextItems: readonly ContextMenuItem[] = [
    { id: 'play', label: playbackAction, action: activateTrack },
    { id: 'queue', label: t('addToQueue'), action: () => addToQueue(track) },
    {
      id: 'add-to-playlist',
      label: addToPlaylist.label,
      disabled: !addToPlaylist.available,
      action: openAddToPlaylist,
    },
    {
      id: 'favorite',
      label: favoriteLabel,
      disabled: !favoriteAvailable || pending,
      action: () => {
        if (accountProvider) return setFavorite(accountProvider, track, !favorite);
      },
    },
    ...pluginActions.map((action) => ({
      id: `plugin:${action.pluginId}:${action.id}`,
      label: `${action.label}`,
      action: () => dispatchPluginUiAction(action.pluginId, action.id, 'track'),
    })),
  ];
  const contextMenu = useContextMenu(t('moreActions', { title: track.title }), contextItems);

  return (
    <div
      className="track-row"
      role="row"
      tabIndex={0}
      data-active={active || undefined}
      {...contextMenu.triggerProps}
    >
      <span className="track-list__number track-row__index" role="cell">
        <button
          type="button"
          className="track-row__play-button"
          onClick={activateTrack}
          aria-label={t('trackAction', {
            action: playbackAction,
            title: track.title,
            artist: joinArtistNames(track.artists),
          })}
        >
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
        </button>
      </span>
      <span className="track-row__primary" role="cell">
        <EntityLink entity="song" id={track.id} className="track-row__title">
          {track.title}
        </EntityLink>
        <span className="track-row__artist">
          {track.artists.map((artist, artistIndex) => (
            <span key={`${artist.id}-${artistIndex}`}>
              {artistIndex > 0 && ', '}
              <EntityLink
                entity="artist"
                id={artist.id}
                className="track-row__artist-link"
                ariaLabel={
                  repeatedArtistIds.has(artist.id.trim())
                    ? `${artist.name} (${track.title})`
                    : undefined
                }
              >
                {artist.name}
              </EntityLink>
            </span>
          ))}
        </span>
      </span>
      {showAlbum && (
        <span className="track-row__album" role="cell">
          <EntityLink entity="album" id={track.album.id} className="track-row__album-link">
            {track.album.title}
          </EntityLink>
        </span>
      )}
      <span className="track-list__quality track-row__quality" role="cell">
        {track.quality === 'lossless' && <Check size={12} aria-label={t('lossless')} />}
      </span>
      <span className="track-list__duration" role="cell">
        {formatDuration(track.durationMs)}
      </span>
      <span className="track-list__actions track-row__actions" role="cell" ref={actionsRef}>
        <IconButton
          label={favoriteLabel}
          size="small"
          className="track-row__favorite-action"
          active={favorite}
          disabled={!favoriteAvailable || pending}
          onClick={() => {
            if (accountProvider) void setFavorite(accountProvider, track, !favorite);
          }}
        >
          <Heart
            className="track-row__favorite"
            size={14}
            fill={favorite ? 'currentColor' : 'none'}
          />
        </IconButton>
        <ActionMenu label={t('moreActions', { title: track.title })} size="small">
          <ActionMenuItem onClick={() => addToQueue(track)}>{t('addToQueue')}</ActionMenuItem>
          <ActionMenuItem disabled={!addToPlaylist.available} onClick={openAddToPlaylist}>
            {addToPlaylist.label}
          </ActionMenuItem>
        </ActionMenu>
      </span>
      {contextMenu.menu}
      {addToPlaylist.menu}
    </div>
  );
}
