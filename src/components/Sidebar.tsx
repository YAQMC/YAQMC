import { Compass, Heart, Home, Library, ListMusic, Search, Settings } from 'lucide-react';
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
  const providerLabel = provider.id === 'qqmusic' ? t('qqGuest') : t('offlineFixtures');
  const primaryItems = [
    { label: t('home'), page: 'home' as const, icon: Home },
    { label: t('search'), page: 'search' as const, icon: Search },
    { label: t('explore'), page: 'explore' as const, icon: Compass },
  ];
  return (
    <aside className="sidebar">
      <div className="sidebar__brand" aria-label="YAQMC">
        <span className="sidebar__brand-mark">
          <img src="/yaqmc-logo.png" alt="" />
        </span>
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
          onClick={() => onNavigate({ page: 'library' })}
        >
          <Heart size={18} />
          <span>{t('favorites')}</span>
        </button>
        <button
          type="button"
          className="sidebar__item"
          onClick={() => onNavigate({ page: 'library' })}
        >
          <ListMusic size={18} />
          <span>{t('playlists')}</span>
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
        <span className="sidebar__avatar">L</span>
        <span className="sidebar__profile-copy">
          <strong>{t('listener')}</strong>
          <small>{providerLabel}</small>
        </span>
        <span
          className="sidebar__status"
          title={t('providerActive', { provider: provider.displayName })}
        />
      </button>
    </aside>
  );
}
