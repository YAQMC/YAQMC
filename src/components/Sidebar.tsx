import {
  BarChart3,
  Clock3,
  Compass,
  Heart,
  Home,
  Library,
  ListMusic,
  Puzzle,
  Search,
  Settings,
} from 'lucide-react';
import { isLibraryRoute, isPrimaryRoute, type AppRoute } from '../application/navigation';
import { isAndroidRuntime } from '../application/host-capabilities';
import { dispatchPluginUiAction } from '../application/plugin-runtime';
import { usePluginUiSnapshot } from '../application/plugin-ui';
import { useAccountIdentity } from '../application/account-identity';
import { useTranslation } from 'react-i18next';
import { AccountAvatar } from './AccountAvatar';

interface SidebarProps {
  route: AppRoute;
  onNavigate: (route: AppRoute) => void;
}

export function Sidebar({ route, onNavigate }: SidebarProps) {
  const { t } = useTranslation('navigation');
  const android = isAndroidRuntime();
  const pluginSidebar = usePluginUiSnapshot().sidebar;
  const identity = useAccountIdentity();
  const primaryItems = android
    ? [
        { label: t('home'), page: 'home' as const, icon: Home },
        { label: t('explore'), page: 'explore' as const, icon: Compass },
        { label: t('library'), page: 'library' as const, icon: Library },
        { label: t('search'), page: 'search' as const, icon: Search },
      ]
    : [
        { label: t('home'), page: 'home' as const, icon: Home },
        { label: t('search'), page: 'search' as const, icon: Search },
        { label: t('explore'), page: 'explore' as const, icon: Compass },
      ];
  return (
    <aside className="sidebar" data-yaqmc="sidebar">
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
            aria-label={label}
            title={label}
            data-active={
              (page === 'library' ? isLibraryRoute(route) : isPrimaryRoute(route, page)) ||
              undefined
            }
            onClick={() => onNavigate({ page })}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}

        {!android && (
          <>
            <p className="sidebar__section-label">{t('yourMusic')}</p>
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
              data-active={isPrimaryRoute(route, 'statistics') || undefined}
              onClick={() => onNavigate({ page: 'statistics' })}
            >
              <BarChart3 size={18} />
              <span>{t('statistics')}</span>
            </button>
            <button
              type="button"
              className="sidebar__item"
              data-active={isPrimaryRoute(route, 'settings') || undefined}
              onClick={() => onNavigate({ page: 'settings' })}
            >
              <Settings size={18} />
              <span>{t('settings')}</span>
            </button>
            {pluginSidebar.length > 0 && <p className="sidebar__section-label">Plugins</p>}
            {pluginSidebar.map((action) => (
              <button
                type="button"
                key={`${action.pluginId}:${action.id}`}
                className="sidebar__item"
                onClick={() => dispatchPluginUiAction(action.pluginId, action.id, 'sidebar')}
              >
                <Puzzle size={18} />
                <span>{action.label}</span>
              </button>
            ))}
          </>
        )}
      </nav>

      <button
        type="button"
        className="sidebar__profile"
        aria-label={t('openSettings')}
        title={t('openSettings')}
        data-yaqmc="account-avatar"
        onClick={() => onNavigate({ page: 'settings' })}
      >
        <AccountAvatar identity={identity} className="sidebar__avatar" />
        <span className="sidebar__profile-copy">
          <strong>{identity.label}</strong>
          <small>{identity.summary}</small>
        </span>
        <span
          className="sidebar__status"
          title={t('providerActive', { provider: identity.providerName })}
        />
      </button>
    </aside>
  );
}

/** Compact navigation used by Android phones; the desktop rail remains intact. */
export function AndroidBottomNav({ route, onNavigate }: SidebarProps) {
  const { t } = useTranslation('navigation');
  const items = [
    { label: t('home'), page: 'home' as const, icon: Home },
    { label: t('explore'), page: 'explore' as const, icon: Compass },
    { label: t('library'), page: 'library' as const, icon: Library },
    { label: t('search'), page: 'search' as const, icon: Search },
  ];
  return (
    <nav className="android-bottom-nav" aria-label={t('primary')}>
      {items.map(({ label, page, icon: Icon }) => (
        <button
          key={page}
          type="button"
          className="android-bottom-nav__item"
          data-active={
            (page === 'library' ? isLibraryRoute(route) : isPrimaryRoute(route, page)) || undefined
          }
          onClick={() => onNavigate({ page })}
        >
          <Icon size={20} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
