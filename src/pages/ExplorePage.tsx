import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppRoute } from '../application/navigation';
import { usePlayerStore } from '../application/player-store';
import { useMusicProvider } from '../application/provider-context';
import { useDiscover } from '../application/use-discover';
import { MediaCard } from '../components/MediaCard';
import { Artwork } from '../components/ui/Artwork';
import type { DiscoverFeed } from '../domain/music';

type DiscoverTab =
  'featured' | 'charts' | 'newSongs' | 'newAlbums' | 'categories' | 'newMvs' | 'podcasts';

const tabOrder: readonly DiscoverTab[] = [
  'featured',
  'charts',
  'newSongs',
  'newAlbums',
  'categories',
  'newMvs',
  'podcasts',
];
const selectedTabByProvider = new Map<string, DiscoverTab>();

function discoverTabs(feed: DiscoverFeed): DiscoverTab[] {
  return tabOrder.filter((tab) => {
    switch (tab) {
      case 'featured':
        return feed.featured.length > 0 || feed.popularSonglists.length > 0;
      case 'charts':
        return feed.charts.length > 0;
      case 'newSongs':
        return Boolean(feed.newSongs?.tracks.length);
      case 'newAlbums':
        return feed.newAlbums.length > 0;
      case 'categories':
        return feed.categories.length > 0;
      case 'newMvs':
        return feed.newMvs.length > 0;
      case 'podcasts':
        return feed.podcasts.length > 0;
    }
  });
}

function CoverCard({
  title,
  subtitle,
  cover,
  eyebrow,
  onClick,
}: {
  title: string;
  subtitle: string;
  cover: string;
  eyebrow: string;
  onClick?: () => void;
}) {
  return (
    <article className="media-card" tabIndex={0}>
      <div className="media-card__art">
        <button type="button" className="media-card__open" onClick={onClick} aria-label={title}>
          <Artwork artwork={{ src: cover, alt: title, dominantColor: '#181818' }} />
        </button>
      </div>
      <button type="button" className="media-card__meta" onClick={onClick}>
        <span className="media-card__title">{title}</span>
        <span className="media-card__subtitle">{subtitle || eyebrow}</span>
      </button>
    </article>
  );
}

interface ExplorePageProps {
  onNavigate: (route: AppRoute) => void;
}

export function ExplorePage({ onNavigate }: ExplorePageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'explore' });
  const provider = useMusicProvider();
  const state = useDiscover();
  const [selection, setSelection] = useState<{ providerId: string; tab: DiscoverTab }>(() => ({
    providerId: provider.id,
    tab: selectedTabByProvider.get(provider.id) ?? 'featured',
  }));
  const tabs = state.status === 'ready' ? discoverTabs(state.discover) : [];
  const rememberedTab = selectedTabByProvider.get(provider.id);
  const requestedTab =
    rememberedTab ?? (selection.providerId === provider.id ? selection.tab : 'featured');
  const activeTab = tabs.includes(requestedTab) ? requestedTab : (tabs[0] ?? null);

  useEffect(() => {
    if (!activeTab || !rememberedTab || tabs.includes(rememberedTab)) return;
    selectedTabByProvider.set(provider.id, activeTab);
  }, [activeTab, provider.id, rememberedTab, tabs]);

  const selectTab = (tab: DiscoverTab) => {
    selectedTabByProvider.set(provider.id, tab);
    setSelection({ providerId: provider.id, tab });
  };
  const moveTabFocus = (tab: DiscoverTab) => {
    selectTab(tab);
    document.getElementById(`discover-tab-${tab}`)?.focus();
  };

  return (
    <div className="page standard-page explore-page">
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
      </header>

      {state.status === 'loading' && <p className="discover-status">{t('loading')}</p>}
      {state.status === 'error' && (
        <p className="discover-status discover-status--error">{state.message}</p>
      )}

      {state.status === 'ready' && activeTab && (
        <>
          <div
            className="search-tabs explore-page__tabs"
            role="tablist"
            aria-label={t('tabsLabel')}
          >
            {tabs.map((tab) => (
              <button
                key={tab}
                id={`discover-tab-${tab}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                aria-controls={`discover-tabpanel-${tab}`}
                tabIndex={activeTab === tab ? 0 : -1}
                onClick={() => selectTab(tab)}
                onKeyDown={(event) => {
                  const index = tabs.indexOf(tab);
                  let nextIndex = index;
                  if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
                  if (event.key === 'ArrowLeft') {
                    nextIndex = (index - 1 + tabs.length) % tabs.length;
                  }
                  if (event.key === 'Home') nextIndex = 0;
                  if (event.key === 'End') nextIndex = tabs.length - 1;
                  if (nextIndex !== index) {
                    event.preventDefault();
                    moveTabFocus(tabs[nextIndex]!);
                  } else if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                  }
                }}
              >
                {tabLabel(tab, t)}
              </button>
            ))}
          </div>

          {tabs.map((tab) => (
            <section
              key={tab}
              id={`discover-tabpanel-${tab}`}
              className="explore-page__tabpanel"
              role="tabpanel"
              aria-labelledby={`discover-tab-${tab}`}
              hidden={activeTab !== tab}
              tabIndex={activeTab === tab ? 0 : -1}
            >
              {activeTab === tab && (
                <DiscoverTabContent tab={tab} feed={state.discover} onNavigate={onNavigate} />
              )}
            </section>
          ))}
        </>
      )}

      {state.status === 'ready' && !activeTab && <p className="discover-status">{t('empty')}</p>}
    </div>
  );
}

function DiscoverTabContent({
  tab,
  feed,
  onNavigate,
}: {
  tab: DiscoverTab;
  feed: DiscoverFeed;
  onNavigate: (route: AppRoute) => void;
}) {
  const { t } = useTranslation('pages', { keyPrefix: 'explore' });
  const playTracks = usePlayerStore((state) => state.playTracks);

  switch (tab) {
    case 'featured':
      return (
        <>
          {feed.featured.length > 0 && (
            <section className="content-section">
              <SectionHeading eyebrow={t('featuredEyebrow')} title={t('featured')} />
              <div className="media-grid media-grid--four">
                {feed.featured.map((card) => (
                  <CoverCard
                    key={card.id}
                    title={card.title}
                    subtitle={card.subtitle}
                    cover={card.cover}
                    eyebrow={t('featuredLabel')}
                  />
                ))}
              </div>
            </section>
          )}
          {feed.popularSonglists.length > 0 && (
            <section className="content-section content-section--last">
              <SectionHeading
                eyebrow={t('popularSonglistsEyebrow')}
                title={t('popularSonglists')}
              />
              <div className="media-grid media-grid--four">
                {feed.popularSonglists.map((playlist) => (
                  <MediaCard
                    key={playlist.id}
                    item={playlist}
                    type="playlist"
                    onOpen={() => onNavigate({ page: 'playlist', id: playlist.id })}
                    onPlay={() => playTracks(playlist.tracks)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      );
    case 'charts':
      return (
        <section className="content-section content-section--last">
          <SectionHeading eyebrow={t('chartsEyebrow')} title={t('charts')} />
          <div className="media-grid media-grid--four">
            {feed.charts.map((chart) => (
              <MediaCard
                key={chart.id}
                item={chart}
                type="playlist"
                onOpen={() => onNavigate({ page: 'playlist', id: chart.id })}
                onPlay={() => playTracks(chart.tracks)}
              />
            ))}
          </div>
        </section>
      );
    case 'newSongs':
      return (
        <section className="content-section content-section--last">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t('newSongsEyebrow')}</p>
              <h2>{t('newSongs')}</h2>
            </div>
            {feed.newSongs && feed.newSongs.tracks.length > 0 && (
              <button type="button" onClick={() => playTracks(feed.newSongs!.tracks)}>
                <Play size={15} fill="currentColor" /> {t('playAll')}
              </button>
            )}
          </div>
          <div className="media-grid media-grid--four">
            {feed.newSongs?.tracks.map((song) => (
              <MediaCard
                key={song.id}
                item={song}
                type="song"
                onOpen={() => onNavigate({ page: 'song', id: song.id })}
                onPlay={() => playTracks([song])}
              />
            ))}
          </div>
        </section>
      );
    case 'newAlbums':
      return (
        <section className="content-section content-section--last">
          <SectionHeading eyebrow={t('newAlbumsEyebrow')} title={t('newAlbums')} />
          <div className="media-grid media-grid--four">
            {feed.newAlbums.map((album) => (
              <MediaCard
                key={album.id}
                item={album}
                type="album"
                onOpen={() => onNavigate({ page: 'album', id: album.id })}
                onPlay={() => playTracks(album.tracks)}
              />
            ))}
          </div>
        </section>
      );
    case 'categories':
      return (
        <section className="content-section content-section--last">
          <SectionHeading eyebrow={t('categoriesEyebrow')} title={t('categories')} />
          <div className="media-grid media-grid--five">
            {feed.categories.map((category) => (
              <CoverCard
                key={category.encArea}
                title={category.title}
                subtitle=""
                cover={category.cover}
                eyebrow={t('categoryLabel')}
                onClick={() =>
                  onNavigate({
                    page: 'area',
                    encArea: category.encArea,
                    title: category.title,
                  })
                }
              />
            ))}
          </div>
        </section>
      );
    case 'newMvs':
      return (
        <section className="content-section content-section--last">
          <SectionHeading eyebrow={t('newMvsEyebrow')} title={t('newMvs')} />
          <div className="media-grid media-grid--four">
            {feed.newMvs.map((mv) => (
              <CoverCard
                key={mv.id}
                title={mv.title}
                subtitle={mv.artist}
                cover={mv.cover}
                eyebrow={t('mvLabel')}
              />
            ))}
          </div>
        </section>
      );
    case 'podcasts':
      return (
        <section className="content-section content-section--last">
          <SectionHeading eyebrow={t('podcastsEyebrow')} title={t('podcasts')} />
          <div className="media-grid media-grid--five">
            {feed.podcasts.map((podcast) => (
              <CoverCard
                key={podcast.id}
                title={podcast.title}
                subtitle={podcast.subtitle}
                cover={podcast.cover}
                eyebrow={t('podcastLabel')}
              />
            ))}
          </div>
        </section>
      );
  }
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
    </div>
  );
}

function tabLabel(tab: DiscoverTab, translate: (key: string) => string): string {
  switch (tab) {
    case 'featured':
      return translate('featuredTab');
    case 'charts':
      return translate('charts');
    case 'newSongs':
      return translate('newSongs');
    case 'newAlbums':
      return translate('newAlbums');
    case 'categories':
      return translate('categories');
    case 'newMvs':
      return translate('newMvs');
    case 'podcasts':
      return translate('podcasts');
  }
}
