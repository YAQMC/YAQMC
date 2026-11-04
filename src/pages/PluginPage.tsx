import { Puzzle } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { usePluginPage, type PluginPageBlock } from '../application/plugin-pages';
import {
  dispatchPluginPageAction,
  notifyPluginPageVisibility,
} from '../application/plugin-runtime';
import { ErrorState } from '../components/ui/ErrorState';

interface PluginPageProps {
  pluginId: string;
  pageId: string;
}

/** Plugin API v4 page. All markup is YAQMC's; the plugin only supplies validated block data. */
export function PluginPage({ pluginId, pageId }: PluginPageProps) {
  const { t } = useTranslation('pages');
  const page = usePluginPage(pluginId, pageId);
  const registered = page !== null;

  useEffect(() => {
    if (!registered) return;
    notifyPluginPageVisibility(pluginId, pageId, true);
    return () => notifyPluginPageVisibility(pluginId, pageId, false);
  }, [pageId, pluginId, registered]);

  if (!page) {
    return <ErrorState title={t('itemUnavailable')} message={t('pluginPage.unavailable')} />;
  }

  const act = (actionId: string) => dispatchPluginPageAction(pluginId, pageId, actionId);

  return (
    <div className="page plugin-page" data-plugin-id={pluginId} data-plugin-page={pageId}>
      <header className="page-heading plugin-page__heading">
        <p className="eyebrow plugin-page__source">
          <Puzzle size={13} aria-hidden="true" />
          {t('pluginPage.providedBy', { plugin: page.pluginName })}
        </p>
        <h1>{page.title}</h1>
      </header>
      {page.blocks.length === 0 ? (
        <p className="plugin-page__waiting" role="status">
          {t('pluginPage.loading', { plugin: page.pluginName })}
        </p>
      ) : (
        <div className="plugin-page__blocks">
          {page.blocks.map((block, index) => (
            <PluginBlock key={index} block={block} onAction={act} />
          ))}
        </div>
      )}
    </div>
  );
}

function PluginBlock({
  block,
  onAction,
}: {
  block: PluginPageBlock;
  onAction: (actionId: string) => void;
}) {
  switch (block.type) {
    case 'heading':
      return <h2 className="plugin-page__subheading">{block.text}</h2>;
    case 'text':
      return (
        <p className="plugin-page__text" data-tone={block.tone}>
          {block.text}
        </p>
      );
    case 'notice':
      return (
        <p
          className="plugin-page__notice"
          data-level={block.level}
          role={block.level === 'error' ? 'alert' : 'status'}
        >
          {block.text}
        </p>
      );
    case 'divider':
      return <hr className="plugin-page__divider" />;
    case 'stats':
      return (
        <dl className="plugin-page__stats">
          {block.items.map((item, index) => (
            <div key={index}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'list':
      return (
        <ul className="plugin-page__list">
          {block.items.map((item) => {
            const body = (
              <>
                <strong>{item.title}</strong>
                {item.subtitle && <span>{item.subtitle}</span>}
              </>
            );
            return (
              <li key={item.id}>
                {item.actionId ? (
                  <button type="button" onClick={() => onAction(item.actionId!)}>
                    {body}
                  </button>
                ) : (
                  <div>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      );
    case 'actions':
      return (
        <div className="plugin-page__actions">
          {block.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`button button--${item.variant}`}
              onClick={() => onAction(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      );
  }
}
