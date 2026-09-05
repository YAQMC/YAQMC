import { BarChart3, Clock3, Heart, ListMusic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppRoute } from '../application/navigation';

interface MediaLibraryPageProps {
  onNavigate: (route: AppRoute) => void;
}

export function MediaLibraryPage({ onNavigate }: MediaLibraryPageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'library' });
  const destinations = [
    {
      page: 'favorites' as const,
      icon: Heart,
      title: t('favoriteSongs'),
      description: t('hubFavorites'),
    },
    {
      page: 'account-playlists' as const,
      icon: ListMusic,
      title: t('myPlaylists'),
      description: t('hubPlaylists'),
    },
    {
      page: 'account-recent' as const,
      icon: Clock3,
      title: t('recentlyPlayed'),
      description: t('hubRecent'),
    },
    {
      page: 'statistics' as const,
      icon: BarChart3,
      title: t('hubStatistics'),
      description: t('hubStatisticsDescription'),
    },
  ];

  return (
    <div className="page standard-page media-library-page">
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('hubTitle')}</h1>
        <p>{t('hubDescription')}</p>
      </header>
      <div className="media-library-grid">
        {destinations.map(({ page, icon: Icon, title, description }) => (
          <button
            type="button"
            className="media-library-card"
            key={page}
            onClick={() => onNavigate({ page })}
          >
            <span className="media-library-card__icon" aria-hidden="true">
              <Icon size={24} />
            </span>
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
