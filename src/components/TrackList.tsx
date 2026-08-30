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
import { useSongShareActions } from '../application/use-song-share-actions';
import type { ContinuationKind } from '@yaqmc/client';

interface TrackListProps {
  tracks: Song[];
  showAlbum?: boolean;
  compact?: boolean;
  titleTarget?: 'song' | 'album-first';
  continuation?: { providerId: string; kind: ContinuationKind };
}

export function TrackList({
  tracks,
  showAlbum = false,
  compact = false,
  titleTarget = 'song',
  continuation,
}: TrackListProps) {
  const { t } = useTranslation('player');
  const currentId = usePlayerStore((state) => state.queue[state.currentIndex]?.id);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const pluginActions = usePluginUiSnapshot().track;

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
            key={track.id.trim() || `missing-track:${index}`}
            track={track}
            tracks={tracks}
            index={index}
            active={Boolean(track.id.trim()) && track.id === currentId}
            isPlaying={isPlaying}
            showAlbum={showAlbum}
            titleTarget={titleTarget}
            pluginActions={pluginActions}
            continuation={continuation}
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
  titleTarget: 'song' | 'album-first';
  pluginActions: readonly { pluginId: string; pluginName: string; id: string; label: string }[];
  continuation?: { providerId: string; kind: ContinuationKind };
}

function TrackRow({
  track,
  tracks,
  index,
  active,
  isPlaying,
  showAlbum,
  titleTarget,
  pluginActions,
  continuation,
}: TrackRowProps) {
  const { t } = useTranslation('player');
  const { t: common } = useTranslation('common');
  const provider = useContext(ProviderContext);
  const accountProvider = provider && isAccountMusicProvider(provider) ? provider : null;
  const snapshot = useAccountStore((state) => state.snapshot);
  const setFavorite = useAccountStore((state) => state.setFavorite);
  const playTracks = usePlayerStore((state) => state.playTracks);
  const startContinuation = usePlayerStore((state) => state.startContinuation);
  const togglePlayback = usePlayerStore((state) => state.togglePlayback);
  const addToQueue = usePlayerStore((state) => state.addToQueue);
  const addToPlaylist = useAddToPlaylistPicker(track);
  const share = useSongShareActions(track);
  const actionsRef = useRef<HTMLSpanElement>(null);
  const { favorite, pending } = useFavoriteState(track.id, track.isFavorite);
  const hasUsableTrackId = track.id.trim().length > 0;
  const hasUsableAlbumId = track.album.id.trim().length > 0;
  const titleEntity = titleTarget === 'album-first' && hasUsableAlbumId ? 'album' : 'song';
  const titleEntityId = titleEntity === 'album' ? track.album.id : track.id;
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
    if (continuation) {
      const remainingTracks = tracks.slice(index);
      startContinuation(
        continuation.providerId,
        continuation.kind,
        remainingTracks,
        track.id,
        continuation.kind === 'radar' ? [track.id] : [],
      );
    } else {
      playTracks(tracks, track.id);
    }
  };
  const openAddToPlaylist = () => {
    const bounds = actionsRef.current?.getBoundingClientRect();
    addToPlaylist.openAt({
      x: bounds ? Math.min(bounds.right, window.innerWidth - 16) : 24,
      y: bounds ? bounds.bottom + 6 : 24,
    });
  };
  const contextItems: readonly ContextMenuItem[] = hasUsableTrackId
    ? [
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
        {
          id: 'share-public-link',
          label: t('copyPublicSongLink'),
          disabled: !share.available,
          action: () => share.copy('public-link'),
        },
        {
          id: 'share-yaqmc-link',
          label: t('copyYaqmcSongLink'),
          disabled: !share.available,
          action: () => share.copy('yaqmc-link'),
        },
        {
          id: 'share-text',
          label: t('copySongText'),
          disabled: !share.available,
          action: () => share.copy('text'),
        },
        ...pluginActions.map((action) => ({
          id: `plugin:${action.pluginId}:${action.id}`,
          label: `${action.label}`,
          action: () => dispatchPluginUiAction(action.pluginId, action.id, 'track'),
        })),
      ]
    : [];
  const contextMenu = useContextMenu(t('moreActions', { title: track.title }), contextItems);

  return (
    <div
      className="track-row"
      role="row"
      tabIndex={hasUsableTrackId ? 0 : undefined}
      data-active={active || undefined}
      {...(hasUsableTrackId ? contextMenu.triggerProps : {})}
    >
      <span className="track-list__number track-row__index" role="cell">
        {hasUsableTrackId ? (
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
        ) : (
          <span className="track-row__ordinal">{index + 1}</span>
        )}
      </span>
      <span className="track-row__primary" role="cell">
        <EntityLink entity={titleEntity} id={titleEntityId} className="track-row__title">
          {track.title}
        </EntityLink>
        <span className="track-row__artist">
          {track.artists.map((artist, artistIndex) => (
            <span key={`${artist.id}-${artistIndex}`}>
              {artistIndex > 0 && ', '}
              <EntityLink entity="artist" id={artist.id} className="track-row__artist-link">
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
        {hasUsableTrackId && (
          <>
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
              <ActionMenuItem disabled={!share.available} onClick={() => share.copy('public-link')}>
                {t('copyPublicSongLink')}
              </ActionMenuItem>
              <ActionMenuItem disabled={!share.available} onClick={() => share.copy('yaqmc-link')}>
                {t('copyYaqmcSongLink')}
              </ActionMenuItem>
              <ActionMenuItem disabled={!share.available} onClick={() => share.copy('text')}>
                {t('copySongText')}
              </ActionMenuItem>
            </ActionMenu>
          </>
        )}
      </span>
      {hasUsableTrackId && contextMenu.menu}
      {hasUsableTrackId && addToPlaylist.menu}
    </div>
  );
}
