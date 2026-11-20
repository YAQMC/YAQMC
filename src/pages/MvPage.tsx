import { useContext, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ProviderContext } from '../application/provider-context';
import type { MusicVideo } from '../domain/music';
import { formatDuration } from '../utils/format';

export function MvPage({ video }: { video: MusicVideo }) {
  const { t, i18n } = useTranslation('pages', { keyPrefix: 'mv' });
  const provider = useContext(ProviderContext);
  const playCount = new Intl.NumberFormat(i18n.language, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(video.playCount);

  return (
    <div className="page detail-page mv-page">
      <section
        className="mv-page__stage"
        style={{ '--detail-color': video.artwork.dominantColor } as CSSProperties}
      >
        <video
          className="mv-page__video"
          controls
          playsInline
          preload="metadata"
          poster={video.artwork.src}
          src={video.streamUrl}
          aria-label={t('videoLabel', { title: video.title })}
        />
      </section>
      <section className="mv-page__copy">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{video.title}</h1>
        {video.artist && <p className="mv-page__artist">{video.artist}</p>}
        <p className="detail-hero__meta">
          {t('duration')}: {formatDuration(video.durationMs)}
          {video.playCount > 0 && (
            <>
              <span>·</span>
              {t('playCount', { views: playCount })}
            </>
          )}
          {provider && (
            <>
              <span>·</span>
              {provider.displayName}
            </>
          )}
        </p>
        {video.description && <p className="mv-page__description">{video.description}</p>}
      </section>
    </div>
  );
}
