import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useAccountStore, type LibraryResource } from '../application/account-runtime';
import { ProviderContext } from '../application/provider-context';
import type { AccountPlaylistSummary, Song } from '../domain/music';
import { isAccountMusicProvider } from '../providers/music-provider';

interface PickerPosition {
  x: number;
  y: number;
}

function playlistData(
  resource: LibraryResource<AccountPlaylistSummary[]>,
): AccountPlaylistSummary[] | null {
  if (resource.status === 'ready' || resource.status === 'stale') return resource.data;
  if (resource.status === 'loading' || resource.status === 'error') return resource.data;
  return null;
}

function writablePlaylists(playlists: AccountPlaylistSummary[] | null): AccountPlaylistSummary[] {
  return (playlists ?? []).filter(
    (playlist) => playlist.ownership === 'owned' && playlist.capabilities.canAddTracks,
  );
}

export function useAddToPlaylistPicker(track: Song) {
  const { t } = useTranslation('player');
  const provider = useContext(ProviderContext);
  const accountProvider = provider && isAccountMusicProvider(provider) ? provider : null;
  const snapshot = useAccountStore((state) => state.snapshot);
  const openDialog = useAccountStore((state) => state.openDialog);
  const loadPlaylists = useAccountStore((state) => state.loadPlaylists);
  const hasWritableProviderReference =
    track.provider?.providerId === accountProvider?.id && Boolean(track.provider?.trackId.trim());
  const available =
    accountProvider !== null &&
    (snapshot.state !== 'authenticated' ||
      (snapshot.capabilities.playlistWrite && hasWritableProviderReference));
  const [position, setPosition] = useState<PickerPosition | null>(null);

  const openAt = (next: PickerPosition) => {
    if (!accountProvider || !available) return;
    if (snapshot.state !== 'authenticated') {
      openDialog();
      return;
    }
    setPosition(next);
    const resource = useAccountStore.getState().playlists;
    const loaded = playlistData(resource);
    if (resource.status === 'idle' || (resource.status === 'error' && loaded === null)) {
      void loadPlaylists(accountProvider, true);
    }
  };

  return {
    available,
    label: t('addToPlaylist'),
    openAt,
    menu: position ? (
      <AddToPlaylistPicker track={track} position={position} onClose={() => setPosition(null)} />
    ) : null,
  };
}

interface AddToPlaylistPickerProps {
  track: Song;
  position: PickerPosition;
  onClose: () => void;
}

function AddToPlaylistPicker({ track, position, onClose }: AddToPlaylistPickerProps) {
  const { t } = useTranslation('player');
  const { t: playlistT } = useTranslation('pages', { keyPrefix: 'playlist' });
  const { t: common } = useTranslation('common');
  const provider = useContext(ProviderContext);
  const accountProvider = provider && isAccountMusicProvider(provider) ? provider : null;
  const playlists = useAccountStore((state) => state.playlists);
  const pendingById = useAccountStore((state) => state.playlistPendingById);
  const addPlaylistTrack = useAccountStore((state) => state.addPlaylistTrack);
  const loadPlaylists = useAccountStore((state) => state.loadPlaylists);
  const noticeById = useAccountStore((state) => state.playlistMutationNoticeById);
  const surface = useRef<HTMLDivElement>(null);
  const writable = writablePlaylists(playlistData(playlists));
  const loading = playlists.status === 'idle' || playlists.status === 'loading';
  const loadFailed = playlists.status === 'error' && writable.length === 0;
  const [failedPlaylistId, setFailedPlaylistId] = useState<string | null>(null);
  const failureNotice = failedPlaylistId ? (noticeById[failedPlaylistId] ?? null) : null;
  const estimatedHeight = Math.min(320, Math.max(48, writable.length * 40 + 48));
  const left = Math.max(8, Math.min(position.x, window.innerWidth - 248));
  const top = Math.max(8, Math.min(position.y, window.innerHeight - estimatedHeight - 8));

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!surface.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    const frame = window.requestAnimationFrame(() => {
      surface.current
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus({ preventScroll: true });
    });
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const choosePlaylist = async (playlist: AccountPlaylistSummary) => {
    if (!accountProvider || pendingById[playlist.id]) return;
    setFailedPlaylistId(null);
    const result = await addPlaylistTrack(accountProvider, playlist, track);
    if (result?.status === 'applied' || result?.status === 'reconciled') {
      onClose();
      return;
    }
    setFailedPlaylistId(playlist.id);
  };

  return createPortal(
    <div
      ref={surface}
      className="add-to-playlist-picker"
      role="menu"
      aria-label={t('addToPlaylistPicker', { title: track.title })}
      style={{ top, left }}
      data-portal="true"
    >
      {loading && writable.length === 0 ? (
        <p className="add-to-playlist-picker__status" role="status">
          {t('addToPlaylistLoading')}
        </p>
      ) : loadFailed ? (
        <div className="add-to-playlist-picker__status">
          <p role="status">{t('addToPlaylistLoadFailed')}</p>
          {accountProvider && (
            <button type="button" onClick={() => void loadPlaylists(accountProvider, true)}>
              {common('retry')}
            </button>
          )}
        </div>
      ) : writable.length === 0 ? (
        <p className="add-to-playlist-picker__status" role="status">
          {t('addToPlaylistEmpty')}
        </p>
      ) : (
        writable.map((playlist) => (
          <button
            key={playlist.id}
            type="button"
            role="menuitem"
            disabled={Boolean(pendingById[playlist.id])}
            onClick={() => void choosePlaylist(playlist)}
          >
            {playlist.title}
          </button>
        ))
      )}
      {failureNotice?.operation === 'add' && (
        <p className="add-to-playlist-picker__status" role="status">
          {playlistT(`mutation.add.${failureNotice.outcome}`)}
        </p>
      )}
    </div>,
    document.body,
  );
}
