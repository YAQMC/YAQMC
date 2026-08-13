import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AccountListResource, LibraryResource } from '../application/account-runtime';
import type { AppRoute } from '../application/navigation';
import { usePlayerStore } from '../application/player-store';
import type {
  AccountPlaylistSummary,
  AccountSnapshot,
  RemotePlayHistoryItem,
  Song,
} from '../domain/music';
import { TrackList } from '../components/TrackList';
import { Artwork } from '../components/ui/Artwork';

export type AccountLibraryView = 'summary' | AccountListResource;

interface LibraryPageProps {
  view: AccountLibraryView;
  snapshot: AccountSnapshot;
  favorites: LibraryResource<Song[]>;
  playlists: LibraryResource<AccountPlaylistSummary[]>;
  recent: LibraryResource<RemotePlayHistoryItem[]>;
  onNavigate: (route: AppRoute) => void;
  onSignIn: () => void;
  onRetry: (resource: AccountListResource) => void;
  onLoadMore: (resource: AccountListResource) => void;
}

function resourceData<T>(resource: LibraryResource<T>): T | null {
  if (resource.status === 'ready' || resource.status === 'stale') return resource.data;
  if (resource.status === 'loading' || resource.status === 'error') return resource.data;
  return null;
}

function canLoadMore<T>(resource: LibraryResource<T>): boolean {
  return resource.status === 'ready' && resource.nextCursor !== null;
}

function safeAccountAvatarUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['qpic.y.qq.com', 'q.qlogo.cn', 'thirdwx.qlogo.cn', 'thirdqq.qlogo.cn'].includes(
        url.hostname,
      ) &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
      ? value
      : null;
  } catch {
    return null;
  }
}

export function LibraryPage({
  view,
  snapshot,
  favorites,
  playlists,
  recent,
  onNavigate,
  onSignIn,
  onRetry,
  onLoadMore,
}: LibraryPageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'library' });
  const { t: common } = useTranslation('common');
  const playTracks = usePlayerStore((state) => state.playTracks);
  const title = t(
    view === 'summary'
      ? 'title'
      : view === 'favorites'
        ? 'favoriteSongs'
        : view === 'playlists'
          ? 'myPlaylists'
          : 'recentlyPlayed',
  );

  if (snapshot.state !== 'authenticated') {
    const reauthentication =
      snapshot.state === 'session-expired' || snapshot.state === 'reauthentication-required';
    const pending =
      snapshot.state === 'restoring-session' ||
      snapshot.state === 'starting-login' ||
      snapshot.state === 'waiting-for-scan' ||
      snapshot.state === 'waiting-for-confirmation';
    return (
      <div className="page standard-page library-page">
        <header className="page-heading">
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{pending ? t('checkingAccount') : t('signInHeading', { title })}</h1>
        </header>
        <div className="account-library-state">
          <p>
            {pending
              ? t('checkingAccountBody')
              : reauthentication
                ? t('reauthBody')
                : t('signInBody')}
          </p>
          {!pending && (
            <button type="button" className="button button--primary" onClick={onSignIn}>
              {reauthentication ? t('reauthenticate') : t('signIn')}
            </button>
          )}
        </div>
      </div>
    );
  }

  const avatarUrl = safeAccountAvatarUrl(snapshot.profile.avatarUrl);

  function renderResource<T>(
    resourceName: AccountListResource,
    resource: LibraryResource<T>,
    renderContent: (data: T) => ReactNode,
  ): ReactNode {
    const data = resourceData(resource);
    const initialLoading = resource.status === 'idle' || (resource.status === 'loading' && !data);
    const initialError = resource.status === 'error' && !data;

    if (initialLoading) {
      return (
        <div className="account-library-state" aria-live="polite">
          <p>{t('loading', { title })}</p>
        </div>
      );
    }
    if (resource.status === 'account-required') {
      return (
        <div className="account-library-state">
          <p>{t('signInBody')}</p>
          <button type="button" className="button button--primary" onClick={onSignIn}>
            {t('signIn')}
          </button>
        </div>
      );
    }
    if (resource.status === 'reauthentication-required') {
      return (
        <div className="account-library-state">
          <p>{t('reauthBody')}</p>
          <button type="button" className="button button--primary" onClick={onSignIn}>
            {t('reauthenticate')}
          </button>
        </div>
      );
    }
    if (initialError && resource.status === 'error') {
      return (
        <div className="account-library-state account-library-state--error">
          <p>{t(`errors.${resource.error}`)}</p>
          <button type="button" onClick={() => onRetry(resourceName)}>
            {common('retry')}
          </button>
        </div>
      );
    }
    if (resource.status === 'empty') {
      return (
        <div className="account-library-state">
          <p>{t('empty', { title })}</p>
          <button type="button" onClick={() => onRetry(resourceName)}>
            {common('retry')}
          </button>
        </div>
      );
    }
    if (!data) return null;

    return (
      <>
        {resource.status === 'stale' && (
          <div className="account-library-notice" role="status">
            <span>{t('stale')}</span>
            <button type="button" onClick={() => onRetry(resourceName)}>
              {common('retry')}
            </button>
          </div>
        )}
        {resource.status === 'error' && (
          <div className="account-library-notice account-library-notice--error" role="status">
            <span>{t(`errors.${resource.error}`)}</span>
            <button type="button" onClick={() => onRetry(resourceName)}>
              {common('retry')}
            </button>
          </div>
        )}
        {resource.status === 'loading' && (
          <div className="account-library-notice" role="status">
            {t('loadingMore')}
          </div>
        )}

        {renderContent(data)}

        {(canLoadMore(resource) || resource.status === 'loading') && (
          <div className="account-library-pagination">
            <button
              type="button"
              disabled={resource.status === 'loading'}
              onClick={() => onLoadMore(resourceName)}
            >
              {resource.status === 'loading' ? t('loadingMore') : t('loadMore')}
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="page standard-page library-page" data-library-view={view}>
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{title}</h1>
        {view === 'summary' && (
          <div className="account-library-profile">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span aria-hidden="true">{snapshot.profile.nickname.slice(0, 1)}</span>
            )}
            <div>
              <strong>{snapshot.profile.nickname}</strong>
              <small>
                {snapshot.profile.maskedIdentity} · {t(`tier.${snapshot.entitlement.tier}`)}
              </small>
            </div>
          </div>
        )}
      </header>

      {view === 'favorites'
        ? renderResource('favorites', favorites, (songs) => (
            <section className="content-section content-section--last">
              <div className="section-heading">
                <h2>{t('favoriteSongs')}</h2>
                <button type="button" onClick={() => playTracks(songs)}>
                  <Play size={15} fill="currentColor" /> {t('playAll')}
                </button>
              </div>
              <TrackList tracks={songs} showAlbum compact />
            </section>
          ))
        : view === 'recent'
          ? renderResource('recent', recent, (items) => (
              <section className="content-section content-section--last">
                <div className="section-heading">
                  <div>
                    <h2>{t('recentlyPlayed')}</h2>
                    <p>{t('remoteHistoryLabel')}</p>
                  </div>
                </div>
                <TrackList tracks={items.map((item) => item.song)} showAlbum compact />
              </section>
            ))
          : renderResource('playlists', playlists, (items) => (
              <section className="content-section content-section--last">
                <div className="section-heading">
                  <h2>{view === 'summary' ? t('yourPlaylists') : t('myPlaylists')}</h2>
                </div>
                <div className="account-playlist-grid">
                  {items.map((playlist) => (
                    <button
                      type="button"
                      className="account-playlist-card"
                      key={playlist.id}
                      onClick={() => onNavigate({ page: 'account-playlist', playlist })}
                    >
                      <Artwork artwork={playlist.artwork} />
                      <span className="account-playlist-card__copy">
                        <strong>{playlist.title}</strong>
                        <small>
                          {playlist.owner.displayName} ·{' '}
                          {common('songCount', { count: playlist.trackCount })}
                        </small>
                        <small>
                          {playlist.ownership === 'owned'
                            ? t('ownedPlaylist')
                            : playlist.ownership === 'favorite'
                              ? t('favoriteCollection')
                              : playlist.ownership === 'system'
                                ? t('systemCollection')
                                : t('savedPlaylist')}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
    </div>
  );
}
