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
  type LucideIcon,
} from 'lucide-react';
import { isLibraryRoute, isPrimaryRoute, type AppRoute } from '../application/navigation';
import { isAndroidRuntime } from '../application/host-capabilities';
import { dispatchPluginUiAction } from '../application/plugin-runtime';
import { usePluginUiSnapshot } from '../application/plugin-ui';
import { usePluginNavigation } from '../application/plugin-pages';
import { useAccountIdentity } from '../application/account-identity';
import { useTranslation } from 'react-i18next';
import { AccountAvatar } from './AccountAvatar';

interface SidebarProps {
  inert?: boolean;
  route: AppRoute;
  onNavigate: (route: AppRoute) => void;
}

type NavPage = Extract<
  AppRoute['page'],
  | 'home'
  | 'search'
  | 'explore'
  | 'library'
  | 'favorites'
  | 'account-playlists'
  | 'account-recent'
  | 'statistics'
  | 'settings'
>;

type NavLabelKey =
  | 'home'
  | 'search'
  | 'explore'
  | 'library'
  | 'favorites'
  | 'playlists'
  | 'recentlyPlayed'
  | 'statistics'
  | 'settings'
  | 'yourMusic'
  | 'application';

interface NavItem {
  page: NavPage;
  labelKey: NavLabelKey;
  icon: LucideIcon;
}

// Phones and Android collapse the account sections into Library (MediaLibraryPage links them).
const compactItems: NavItem[] = [
  { page: 'home', labelKey: 'home', icon: Home },
  { page: 'explore', labelKey: 'explore', icon: Compass },
  { page: 'library', labelKey: 'library', icon: Library },
  { page: 'search', labelKey: 'search', icon: Search },
];

const desktopSections: { labelKey?: NavLabelKey; items: NavItem[] }[] = [
  {
    items: [
      { page: 'home', labelKey: 'home', icon: Home },
      { page: 'search', labelKey: 'search', icon: Search },
      { page: 'explore', labelKey: 'explore', icon: Compass },
    ],
  },
  {
    labelKey: 'yourMusic',
    items: [
      { page: 'favorites', labelKey: 'favorites', icon: Heart },
      { page: 'account-playlists', labelKey: 'playlists', icon: ListMusic },
      { page: 'account-recent', labelKey: 'recentlyPlayed', icon: Clock3 },
    ],
  },
  {
    labelKey: 'application',
    items: [
      { page: 'statistics', labelKey: 'statistics', icon: BarChart3 },
      { page: 'settings', labelKey: 'settings', icon: Settings },
    ],
  },
];

function isItemActive(route: AppRoute, page: NavPage): boolean {
  if (page === 'library') return isLibraryRoute(route);
  if (page === 'account-playlists') {
    return isPrimaryRoute(route, page) || isPrimaryRoute(route, 'account-playlist');
  }
  return isPrimaryRoute(route, page);
}

export function Sidebar({ route, onNavigate, inert }: SidebarProps) {
  const { t } = useTranslation('navigation');
  const pluginSidebar = usePluginUiSnapshot().sidebar;
  const pluginNavigation = usePluginNavigation();
  const identity = useAccountIdentity();
  const sections: typeof desktopSections = isAndroidRuntime()
    ? [{ items: compactItems }]
    : desktopSections;
  return (
    <aside className="sidebar" data-yaqmc="sidebar" inert={inert}>
      <div className="sidebar__brand" aria-label="YAQMC">
        <span className="sidebar__brand-mark" aria-hidden="true" />
        <span>YAQMC</span>
      </div>

      <nav className="sidebar__nav" aria-label={t('primary')}>
        {sections.flatMap(({ labelKey, items }) => [
          ...(labelKey
            ? [
                <p key={labelKey} className="sidebar__section-label">
                  {t(labelKey)}
                </p>,
              ]
            : []),
          ...items.map(({ page, labelKey: itemKey, icon: Icon }) => (
            <button
              type="button"
              key={page}
              className="sidebar__item"
              aria-label={t(itemKey)}
              title={t(itemKey)}
              data-active={isItemActive(route, page) || undefined}
              onClick={() => onNavigate({ page })}
            >
              <Icon size={18} />
              <span>{t(itemKey)}</span>
            </button>
          )),
        ])}
        {!isAndroidRuntime() && (pluginSidebar.length > 0 || pluginNavigation.length > 0) && (
          <p className="sidebar__section-label">Plugins</p>
        )}
        {!isAndroidRuntime() &&
          pluginNavigation.map((entry) => (
            <button
              type="button"
              key={`page:${entry.pluginId}:${entry.id}`}
              className="sidebar__item"
              title={`${entry.label} · ${entry.pluginName}`}
              data-active={
                (route.page === 'plugin-page' &&
                  route.pluginId === entry.pluginId &&
                  route.pageId === entry.pageId) ||
                undefined
              }
              onClick={() =>
                onNavigate({ page: 'plugin-page', pluginId: entry.pluginId, pageId: entry.pageId })
              }
            >
              <Puzzle size={18} />
              <span>{entry.label}</span>
            </button>
          ))}
        {!isAndroidRuntime() &&
          pluginSidebar.map((action) => (
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

/** Bottom navigation for phone-sized viewports on any host; hidden by CSS elsewhere. */
export function BottomNav({ route, onNavigate, inert }: SidebarProps) {
  const { t } = useTranslation('navigation');
  return (
    <nav className="android-bottom-nav" aria-label={t('primary')} inert={inert}>
      {compactItems.map(({ page, labelKey, icon: Icon }) => (
        <button
          key={page}
          type="button"
          className="android-bottom-nav__item"
          aria-current={isItemActive(route, page) ? 'page' : undefined}
          data-active={isItemActive(route, page) || undefined}
          onClick={() => onNavigate({ page })}
        >
          <Icon size={20} />
          <span>{t(labelKey)}</span>
        </button>
      ))}
    </nav>
  );
}
