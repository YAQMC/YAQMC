import { useTranslation } from 'react-i18next';

interface ErrorStateProps {
  title: string;
  message: string;
  onRetry?: () => void;
}

/** Page-level failure: one layout, alert semantics and retry affordance for every route. */
export function ErrorState({ title, message, onRetry }: ErrorStateProps) {
  const { t } = useTranslation('common');
  return (
    <div className="empty-state empty-state--error">
      <h1>{title}</h1>
      <p role="alert">{message}</p>
      {onRetry && (
        <button type="button" className="button button--primary" onClick={onRetry}>
          {t('retry')}
        </button>
      )}
    </div>
  );
}
