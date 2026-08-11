import { Check, Minus, MoreHorizontal, Pencil, Play, Plus, Shuffle, Trash2 } from 'lucide-react';
import { useContext, useState, type CSSProperties, type FormEvent } from 'react';
import { usePlaylistMutationState, useAccountStore } from '../application/account-runtime';
import { useCurrentSong, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import type { AccountPlaylistSummary, Playlist } from '../domain/music';
import { isAccountMusicProvider } from '../providers/music-provider';
import { formatTotalDuration } from '../utils/format';
import { TrackList } from '../components/TrackList';
import { Artwork } from '../components/ui/Artwork';
import { IconButton } from '../components/ui/IconButton';
import { useTranslation } from 'react-i18next';

interface PlaylistPageProps {
  playlist: Playlist;
  accountSummary?: AccountPlaylistSummary;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onDeleted?: () => void;
}

export function PlaylistPage({
  playlist,
  accountSummary,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  onDeleted,
}: PlaylistPageProps) {
  const { t, i18n } = useTranslation('pages', { keyPrefix: 'playlist' });
  const { t: common } = useTranslation('common');
  const provider = useContext(ProviderContext);
  const accountProvider = provider && isAccountMusicProvider(provider) ? provider : null;
  const playTracks = usePlayerStore((state) => state.playTracks);
  const currentSong = useCurrentSong();
  const renamePlaylist = useAccountStore((state) => state.renamePlaylist);
  const addPlaylistTrack = useAccountStore((state) => state.addPlaylistTrack);
  const removePlaylistTrack = useAccountStore((state) => state.removePlaylistTrack);
  const deletePlaylist = useAccountStore((state) => state.deletePlaylist);
  const { pending, notice } = usePlaylistMutationState(accountSummary?.id);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(accountSummary?.title ?? playlist.title);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const totalDuration = playlist.tracks.reduce((sum, track) => sum + track.durationMs, 0);
  const normalizedRename = renameDraft.trim();
  const renameValid =
    normalizedRename.length > 0 &&
    Array.from(normalizedRename).length <= 80 &&
    !/[\p{Cc}\p{Cf}]/u.test(normalizedRename);

  const beginRename = () => {
    setRenameDraft(accountSummary?.title ?? playlist.title);
    setRenaming(true);
    setConfirmingDelete(false);
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!accountProvider || !accountSummary || pending || !renameValid) return;
    const result = await renamePlaylist(accountProvider, accountSummary, normalizedRename);
    if (result?.status === 'applied' || result?.status === 'reconciled') setRenaming(false);
  };

  const mutateCurrentTrack = async (operation: 'add' | 'remove') => {
    if (!accountProvider || !accountSummary || !currentSong || pending) return;
    if (operation === 'add') {
      await addPlaylistTrack(accountProvider, accountSummary, currentSong);
    } else {
      await removePlaylistTrack(accountProvider, accountSummary, currentSong);
    }
  };

  const confirmDelete = async () => {
    if (!accountProvider || !accountSummary || pending) return;
    const result = await deletePlaylist(accountProvider, accountSummary);
    setConfirmingDelete(false);
    if (result?.status === 'applied' || result?.status === 'reconciled') onDeleted?.();
  };

  return (
    <div
      className="page detail-page"
      data-account-ownership={accountSummary?.ownership}
      data-can-rename={accountSummary?.capabilities.canRename || undefined}
      data-can-delete={accountSummary?.capabilities.canDelete || undefined}
    >
      <section
        className="detail-hero"
        style={{ '--detail-color': playlist.artwork.dominantColor } as CSSProperties}
      >
        <Artwork artwork={playlist.artwork} className="detail-hero__art" loading="eager" />
        <div className="detail-hero__copy">
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{playlist.title}</h1>
          <p className="detail-hero__description">{playlist.description}</p>
          <p className="detail-hero__owner">
            <span className="detail-hero__owner-mark">P</span>
            <strong>{playlist.owner.displayName}</strong>
            <Check size={13} />
          </p>
          <p className="detail-hero__meta">
            {playlist.updatedLabel} <span>·</span>{' '}
            {common('songCount', { count: playlist.tracks.length })},{' '}
            {formatTotalDuration(totalDuration, i18n.resolvedLanguage ?? i18n.language)}
          </p>
          {accountSummary && (
            <p className="account-playlist-capability" role="status">
              {accountSummary.ownership === 'owned' ? t('owned') : t('collected')} ·{' '}
              {accountSummary.capabilities.canAddTracks ||
              accountSummary.capabilities.canRemoveTracks ||
              accountSummary.capabilities.canRename ||
              accountSummary.capabilities.canDelete
                ? t('editable')
                : t('readOnly')}
            </p>
          )}
          <div className="detail-hero__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => playTracks(playlist.tracks)}
            >
              <Play size={16} fill="currentColor" />
              {t('play')}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => playTracks(playlist.tracks.slice().reverse())}
            >
              <Shuffle size={16} />
              {t('shuffle')}
            </button>
            <IconButton label={t('more')} className="detail-hero__icon-action">
              <MoreHorizontal size={19} />
            </IconButton>
            {accountSummary?.capabilities.canRename && (
              <IconButton
                label={t('rename')}
                className="detail-hero__icon-action"
                disabled={pending || !accountProvider}
                onClick={beginRename}
              >
                <Pencil size={18} />
              </IconButton>
            )}
            {accountSummary?.capabilities.canAddTracks && (
              <IconButton
                label={t('addCurrentTrack')}
                className="detail-hero__icon-action"
                disabled={pending || !accountProvider || !currentSong}
                onClick={() => void mutateCurrentTrack('add')}
              >
                <Plus size={19} />
              </IconButton>
            )}
            {accountSummary?.capabilities.canRemoveTracks && (
              <IconButton
                label={t('removeCurrentTrack')}
                className="detail-hero__icon-action"
                disabled={pending || !accountProvider || !currentSong}
                onClick={() => void mutateCurrentTrack('remove')}
              >
                <Minus size={19} />
              </IconButton>
            )}
            {accountSummary?.capabilities.canDelete && (
              <IconButton
                label={t('delete')}
                className="detail-hero__icon-action detail-hero__icon-action--danger"
                disabled={pending || !accountProvider}
                onClick={() => {
                  setConfirmingDelete(true);
                  setRenaming(false);
                }}
              >
                <Trash2 size={18} />
              </IconButton>
            )}
          </div>
          {renaming && accountSummary?.capabilities.canRename && (
            <form
              className="account-playlist-mutation-form"
              onSubmit={(event) => void submitRename(event)}
            >
              <label htmlFor={`playlist-name-${accountSummary.id}`}>{t('playlistName')}</label>
              <div>
                <input
                  id={`playlist-name-${accountSummary.id}`}
                  value={renameDraft}
                  disabled={pending}
                  maxLength={80}
                  onChange={(event) => setRenameDraft(event.target.value)}
                />
                <button type="submit" disabled={pending || !renameValid}>
                  {t('saveRename')}
                </button>
                <button type="button" disabled={pending} onClick={() => setRenaming(false)}>
                  {common('cancel')}
                </button>
              </div>
            </form>
          )}
          {confirmingDelete && accountSummary?.capabilities.canDelete && (
            <div
              className="account-playlist-delete-confirmation"
              role="group"
              aria-label={t('delete')}
            >
              <span>{t('deleteConfirmation')}</span>
              <button type="button" disabled={pending} onClick={() => void confirmDelete()}>
                {t('confirmDelete')}
              </button>
              <button type="button" disabled={pending} onClick={() => setConfirmingDelete(false)}>
                {common('cancel')}
              </button>
            </div>
          )}
          {notice && (
            <p className="account-playlist-mutation-notice" role="status">
              {t(`mutation.${notice.operation}.${notice.outcome}`)}
            </p>
          )}
        </div>
      </section>

      <section className="detail-track-section" aria-label={t('tracks', { title: playlist.title })}>
        <TrackList tracks={playlist.tracks} showAlbum />
        {(hasMore || loadingMore) && (
          <div className="account-library-pagination">
            <button type="button" disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? t('loadingMore') : t('loadMore')}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
