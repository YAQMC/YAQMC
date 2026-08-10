import { useTranslation } from 'react-i18next';

export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation('pages');
  const accessibleLabel = label ?? t('loadingMusic');
  return (
    <div className="loading-page" aria-label={accessibleLabel} aria-busy="true">
      <div className="skeleton skeleton--hero" />
      <div className="skeleton-heading" />
      <div className="skeleton-grid">
        {Array.from({ length: 5 }, (_, index) => (
          <div className="skeleton-card" key={index}>
            <div className="skeleton skeleton--square" />
            <div className="skeleton skeleton--line" />
            <div className="skeleton skeleton--line-short" />
          </div>
        ))}
      </div>
    </div>
  );
}
