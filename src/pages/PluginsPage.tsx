import { useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutGrid } from 'lucide-react';
import type { AppRoute, PluginsTab } from '../application/navigation';
import { dispatchPluginUiAction } from '../application/plugin-runtime';
import { usePluginNavigation } from '../application/plugin-pages';
import { usePluginUiSnapshot } from '../application/plugin-ui';
import { PluginManager } from '../components/PluginManager';
import { PluginStore } from '../components/PluginStore';

const TABS: readonly PluginsTab[] = ['manage', 'store'];

interface PluginsPageProps {
  tab: PluginsTab;
  onNavigate: (route: AppRoute) => void;
}

/** Host plugin center: management of installed plugins and the GitHub-topic store. */
export function PluginsPage({ tab, onNavigate }: PluginsPageProps) {
  const { t } = useTranslation('settings', { keyPrefix: 'plugins.center' });
  const tabRefs = useRef<Partial<Record<PluginsTab, HTMLButtonElement | null>>>({});
  // Panels stay mounted once opened so search, filters and scroll survive tab switches.
  const [visited, setVisited] = useState<ReadonlySet<PluginsTab>>(() => new Set([tab]));
  const [focusPluginId, setFocusPluginId] = useState<string | null>(null);
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  const pluginNavigation = usePluginNavigation();
  const pluginActions = usePluginUiSnapshot().sidebar;

  const select = (next: PluginsTab) => {
    if (next !== tab) onNavigate({ page: 'plugins', tab: next });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(tab);
    const target =
      event.key === 'ArrowRight'
        ? TABS[(index + 1) % TABS.length]
        : event.key === 'ArrowLeft'
          ? TABS[(index + TABS.length - 1) % TABS.length]
          : event.key === 'Home'
            ? TABS[0]
            : event.key === 'End'
              ? TABS[TABS.length - 1]
              : null;
    if (!target) return;
    event.preventDefault();
    select(target);
    tabRefs.current[target]?.focus();
  };

  return (
    <section className="page standard-page plugins-page" aria-labelledby="plugins-title">
      <header className="plugins-page__header">
        <h1 id="plugins-title">{t('title')}</h1>
        <div className="plugins-tabs" role="tablist" aria-label={t('title')}>
          {TABS.map((id) => (
            <button
              key={id}
              ref={(element) => {
                tabRefs.current[id] = element;
              }}
              type="button"
              role="tab"
              id={`plugins-tab-${id}`}
              aria-controls={`plugins-panel-${id}`}
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              className="plugins-tabs__tab"
              onClick={() => select(id)}
              onKeyDown={onTabKeyDown}
            >
              {t(id === 'manage' ? 'manageTab' : 'storeTab')}
            </button>
          ))}
        </div>
      </header>

      {tab === 'manage' && (pluginNavigation.length > 0 || pluginActions.length > 0) && (
        <nav className="plugins-page__shortcuts" aria-label={t('pluginPages')}>
          <span>{t('pluginPages')}</span>
          {pluginNavigation.map((entry) => (
            <button
              key={`page:${entry.pluginId}:${entry.id}`}
              type="button"
              className="button button--quiet"
              onClick={() =>
                onNavigate({ page: 'plugin-page', pluginId: entry.pluginId, pageId: entry.pageId })
              }
            >
              <LayoutGrid size={14} /> {entry.label}
              <small>{entry.pluginName}</small>
            </button>
          ))}
          {pluginActions.map((action) => (
            <button
              key={`${action.pluginId}:${action.id}`}
              type="button"
              className="button button--quiet"
              onClick={() => dispatchPluginUiAction(action.pluginId, action.id, 'sidebar')}
            >
              <LayoutGrid size={14} /> {action.label}
            </button>
          ))}
        </nav>
      )}

      {TABS.filter((id) => visited.has(id)).map((id) => (
        <div
          key={id}
          id={`plugins-panel-${id}`}
          role="tabpanel"
          aria-labelledby={`plugins-tab-${id}`}
          hidden={tab !== id}
          className="plugins-page__panel"
        >
          {id === 'manage' ? (
            <PluginManager
              focusPluginId={focusPluginId}
              onFocusHandled={() => setFocusPluginId(null)}
            />
          ) : (
            <PluginStore
              onShowInstalled={(pluginId) => {
                setFocusPluginId(pluginId);
                select('manage');
              }}
            />
          )}
        </div>
      ))}
    </section>
  );
}
