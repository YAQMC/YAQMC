import { useMemo, useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  StatisticsDimensionTotal,
  StatisticsEntityTotal,
  StatisticsExportFormat,
  StatisticsRange,
  StatisticsSnapshot,
} from '@yaqmc/client';
import { useStatisticsRuntime } from '../application/statistics-runtime';
import { EntityLink } from '../components/EntityLink';
import { LoadingState } from '../components/ui/LoadingState';

const RANGES: StatisticsRange[] = ['7-days', '30-days', '365-days', 'all-time'];

export function StatisticsPage() {
  const { t, i18n } = useTranslation('pages');
  const { t: common } = useTranslation('common');
  const [range, setRange] = useState<StatisticsRange>('30-days');
  const { resource, refresh, exportData, clear } = useStatisticsRuntime(range);
  const [busyAction, setBusyAction] = useState<StatisticsExportFormat | 'clear' | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const formatDuration = useMemo(() => durationFormatter(i18n.language), [i18n.language]);

  const runExport = async (format: StatisticsExportFormat) => {
    setBusyAction(format);
    setMessage(null);
    setActionError(null);
    try {
      const result = await exportData(format);
      if (result) {
        setMessage(t('statistics.exported', { count: result.sessionCount }));
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const runClear = async () => {
    setBusyAction('clear');
    setMessage(null);
    setActionError(null);
    try {
      const result = await clear();
      setMessage(t('statistics.cleared', { count: result.deletedSessions }));
      setConfirmClear(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const snapshot = resource.data;
  return (
    <section className="statistics-page" aria-labelledby="statistics-title">
      <header className="statistics-page__header">
        <div>
          <p className="page-eyebrow">{t('statistics.eyebrow')}</p>
          <h1 id="statistics-title">{t('statistics.title')}</h1>
          <p>{t('statistics.subtitle')}</p>
        </div>
        <div className="statistics-page__actions">
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => void runExport('json')}
          >
            <Download size={16} />
            {busyAction === 'json' ? t('statistics.exporting') : t('statistics.exportJson')}
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => void runExport('csv')}
          >
            <Download size={16} />
            {busyAction === 'csv' ? t('statistics.exporting') : t('statistics.exportCsv')}
          </button>
        </div>
      </header>

      <div className="statistics-page__ranges" role="tablist" aria-label={t('statistics.ranges')}>
        {RANGES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            id={`statistics-range-${candidate}`}
            aria-controls="statistics-range-panel"
            aria-selected={range === candidate}
            tabIndex={range === candidate ? 0 : -1}
            onClick={() => setRange(candidate)}
            onKeyDown={(event) => {
              const current = RANGES.indexOf(candidate);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? RANGES.length - 1
                    : event.key === 'ArrowLeft'
                      ? (current - 1 + RANGES.length) % RANGES.length
                      : event.key === 'ArrowRight'
                        ? (current + 1) % RANGES.length
                        : current;
              if (next === current) return;
              event.preventDefault();
              setRange(RANGES[next]!);
              const tabs =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                );
              tabs?.[next]?.focus();
            }}
          >
            {t(`statistics.range.${candidate}`)}
          </button>
        ))}
      </div>

      {message && (
        <p role="status" className="statistics-page__notice">
          {message}
        </p>
      )}
      {actionError && (
        <p role="alert" className="statistics-page__notice statistics-page__notice--error">
          {t('statistics.actionFailed', { error: actionError })}
        </p>
      )}
      {resource.status === 'error' && (
        <div className="statistics-page__notice statistics-page__notice--error" role="alert">
          <span>{t('statistics.loadFailed')}</span>
          <button type="button" onClick={() => void refresh()}>
            {common('retry')}
          </button>
        </div>
      )}

      <div
        id="statistics-range-panel"
        role="tabpanel"
        aria-labelledby={`statistics-range-${range}`}
        aria-busy={resource.status === 'loading'}
      >
        {resource.status === 'loading' && !snapshot ? (
          <LoadingState label={t('statistics.loading')} />
        ) : snapshot ? (
          <StatisticsContent
            snapshot={snapshot}
            locale={i18n.language}
            formatDuration={formatDuration}
          />
        ) : null}
      </div>

      <section className="statistics-page__danger" aria-labelledby="statistics-data-title">
        <div>
          <h2 id="statistics-data-title">{t('statistics.localData')}</h2>
          <p>
            {t('statistics.databaseSize', {
              size: formatBytes(snapshot?.databaseBytes ?? 0, i18n.language),
            })}
          </p>
        </div>
        {confirmClear ? (
          <div
            className="statistics-page__confirm"
            role="group"
            aria-label={t('statistics.confirmClear')}
          >
            <span>{t('statistics.clearWarning')}</span>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              disabled={busyAction !== null}
            >
              {common('cancel')}
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={() => void runClear()}
              disabled={busyAction !== null}
            >
              {busyAction === 'clear' ? t('statistics.clearing') : t('statistics.confirmClear')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="danger-button"
            onClick={() => setConfirmClear(true)}
            disabled={busyAction !== null}
          >
            <Trash2 size={16} />
            {t('statistics.clear')}
          </button>
        )}
      </section>
    </section>
  );
}

function StatisticsContent({
  snapshot,
  locale,
  formatDuration,
}: {
  snapshot: StatisticsSnapshot;
  locale: string;
  formatDuration: (milliseconds: number) => string;
}) {
  const { t } = useTranslation('pages');
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const percent = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
    [locale],
  );
  const hasRecords = snapshot.recordCount > 0;

  return (
    <>
      <div className="statistics-page__summary">
        <Metric
          label={t('statistics.listeningTime')}
          value={formatDuration(snapshot.qualifiedListeningMs)}
        />
        <Metric
          label={t('statistics.qualifiedPlays')}
          value={number.format(snapshot.qualifiedPlayCount)}
        />
        <Metric label={t('statistics.completed')} value={number.format(snapshot.completedCount)} />
        <Metric label={t('statistics.skipRate')} value={percent.format(snapshot.skipRate)} />
      </div>

      {!hasRecords ? (
        <div className="statistics-page__empty">
          <h2>{t('statistics.emptyTitle')}</h2>
          <p>{t('statistics.emptyBody')}</p>
        </div>
      ) : (
        <>
          <DailyTrend snapshot={snapshot} formatDuration={formatDuration} locale={locale} />
          <div className="statistics-page__rankings">
            <EntityRanking
              title={t('statistics.topSongs')}
              entity="song"
              items={snapshot.topSongs}
              formatDuration={formatDuration}
            />
            <EntityRanking
              title={t('statistics.topArtists')}
              entity="artist"
              items={snapshot.topArtists}
              formatDuration={formatDuration}
            />
            <EntityRanking
              title={t('statistics.topAlbums')}
              entity="album"
              items={snapshot.topAlbums}
              formatDuration={formatDuration}
            />
          </div>
          <div className="statistics-page__dimensions">
            <DimensionList
              title={t('statistics.byQuality')}
              items={snapshot.qualities}
              formatDuration={formatDuration}
            />
            <DimensionList
              title={t('statistics.byProvider')}
              items={snapshot.providers}
              formatDuration={formatDuration}
            />
          </div>
        </>
      )}
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <article className="statistics-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function DailyTrend({
  snapshot,
  formatDuration,
  locale,
}: {
  snapshot: StatisticsSnapshot;
  formatDuration: (milliseconds: number) => string;
  locale: string;
}) {
  const { t } = useTranslation('pages');
  const max = Math.max(1, ...snapshot.daily.map((entry) => entry.listenedMs));
  const date = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
    [locale],
  );
  return (
    <section className="statistics-panel" aria-labelledby="statistics-trend-title">
      <h2 id="statistics-trend-title">{t('statistics.trend')}</h2>
      <div className="statistics-trend" role="img" aria-label={t('statistics.trendDescription')}>
        {snapshot.daily.map((entry) => (
          <div
            className="statistics-trend__day"
            key={entry.dayStartMs}
            title={`${date.format(entry.dayStartMs)} · ${formatDuration(entry.listenedMs)}`}
          >
            <span style={{ height: `${Math.max(3, (entry.listenedMs / max) * 100)}%` }} />
            <small>{date.format(entry.dayStartMs)}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function EntityRanking({
  title,
  entity,
  items,
  formatDuration,
}: {
  title: string;
  entity: 'song' | 'artist' | 'album';
  items: StatisticsEntityTotal[];
  formatDuration: (milliseconds: number) => string;
}) {
  const { t } = useTranslation('pages');
  return (
    <section className="statistics-panel">
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="statistics-panel__empty">{t('statistics.noItems')}</p>
      ) : (
        <ol className="statistics-ranking">
          {items.map((item) => (
            <li key={`${item.providerId}:${item.id}`}>
              <EntityLink entity={entity} id={item.id} className="statistics-ranking__entity">
                <strong>{item.title || item.id}</strong>
                {item.subtitle && <small>{item.subtitle}</small>}
              </EntityLink>
              <span>{formatDuration(item.listenedMs)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function DimensionList({
  title,
  items,
  formatDuration,
}: {
  title: string;
  items: StatisticsDimensionTotal[];
  formatDuration: (milliseconds: number) => string;
}) {
  const { t } = useTranslation('pages');
  return (
    <section className="statistics-panel">
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="statistics-panel__empty">{t('statistics.noItems')}</p>
      ) : (
        <dl className="statistics-dimensions">
          {items.map((item) => (
            <div key={item.key}>
              <dt>{item.key || t('statistics.unknown')}</dt>
              <dd>{formatDuration(item.listenedMs)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function durationFormatter(locale: string): (milliseconds: number) => string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return (milliseconds) => {
    const minutes = milliseconds / 60_000;
    if (minutes < 60) return `${number.format(minutes)} min`;
    return `${number.format(minutes / 60)} h`;
  };
}

function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}
