import { Clock3, Compass, Heart, Home, Library, ListMusic, Search, Settings } from 'lucide-react';
import { useAccountStore } from '../application/account-runtime';
import { isPrimaryRoute, type AppRoute } from '../application/navigation';
import { useMusicProvider } from '../application/provider-context';
import { useTranslation } from 'react-i18next';

interface SidebarProps {
  route: AppRoute;
  onNavigate: (route: AppRoute) => void;
}

export function Sidebar({ route, onNavigate }: SidebarProps) {
  const { t } = useTranslation('navigation');
  const provider = useMusicProvider();
  const accountSnapshot = useAccountStore((state) => state.snapshot);
  const authenticated = accountSnapshot.state === 'authenticated';
  const accountProfile = authenticated ? accountSnapshot.profile : null;
  const accountEntitlement = authenticated ? accountSnapshot.entitlement : null;
  const providerLabel = provider.id === 'qqmusic' ? t('qqGuest') : t('offlineFixtures');
  const profileLabel = accountProfile?.nickname ?? t('listener');
  const profileInitial = Array.from(profileLabel.trim())[0] ?? 'L';
  const avatarUrl = safeAccountAvatarUrl(accountProfile?.avatarUrl);
  const accountLabel = accountEntitlement
    ? t('accountSummary', {
        tier: t(`accountTier.${accountEntitlement.tier}`),
        membership: t(`accountMembership.${accountEntitlement.membership}`),
      })
    : providerLabel;
  const primaryItems = [
    { label: t('home'), page: 'home' as const, icon: Home },
    { label: t('search'), page: 'search' as const, icon: Search },
    { label: t('explore'), page: 'explore' as const, icon: Compass },
  ];
  return (
    <aside className="sidebar">
      <div className="sidebar__brand" aria-label="YAQMC">
        <span className="sidebar__brand-mark" aria-hidden="true" />
        <span>YAQMC</span>
      </div>

      <nav className="sidebar__nav" aria-label={t('primary')}>
        {primaryItems.map(({ label, page, icon: Icon }) => (
          <button
            type="button"
            key={page}
            className="sidebar__item"
            data-active={isPrimaryRoute(route, page) || undefined}
            onClick={() => onNavigate({ page })}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}

        <p className="sidebar__section-label">{t('yourMusic')}</p>
        <button
          type="button"
          className="sidebar__item"
          data-active={isPrimaryRoute(route, 'library') || undefined}
          onClick={() => onNavigate({ page: 'library' })}
        >
          <Library size={18} />
          <span>{t('library')}</span>
        </button>
        <button
          type="button"
          className="sidebar__item"
          data-active={isPrimaryRoute(route, 'favorites') || undefined}
          onClick={() => onNavigate({ page: 'favorites' })}
        >
          <Heart size={18} />
          <span>{t('favorites')}</span>
        </button>
        <button
          type="button"
          className="sidebar__item"
          data-active={
            isPrimaryRoute(route, 'account-playlists') ||
            isPrimaryRoute(route, 'account-playlist') ||
            undefined
          }
          onClick={() => onNavigate({ page: 'account-playlists' })}
        >
          <ListMusic size={18} />
          <span>{t('playlists')}</span>
        </button>
        <button
          type="button"
          className="sidebar__item"
          data-active={isPrimaryRoute(route, 'account-recent') || undefined}
          onClick={() => onNavigate({ page: 'account-recent' })}
        >
          <Clock3 size={18} />
          <span>{t('recentlyPlayed')}</span>
        </button>

        <p className="sidebar__section-label">{t('application')}</p>
        <button
          type="button"
          className="sidebar__item"
          data-active={isPrimaryRoute(route, 'settings') || undefined}
          onClick={() => onNavigate({ page: 'settings' })}
        >
          <Settings size={18} />
          <span>{t('settings')}</span>
        </button>
      </nav>

      <button
        type="button"
        className="sidebar__profile"
        aria-label={t('openSettings')}
        onClick={() => onNavigate({ page: 'settings' })}
      >
        {avatarUrl ? (
          <img
            className="sidebar__avatar"
            src={avatarUrl}
            alt={t('accountAvatar', { nickname: profileLabel })}
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="sidebar__avatar" aria-hidden="true">
            {profileInitial}
          </span>
        )}
        <span className="sidebar__profile-copy">
          <strong>{profileLabel}</strong>
          <small>{accountLabel}</small>
        </span>
        <span
          className="sidebar__status"
          title={t('providerActive', { provider: provider.displayName })}
        />
      </button>
    </aside>
  );
}

function safeAccountAvatarUrl(value: string | null | undefined): string | null {
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
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
