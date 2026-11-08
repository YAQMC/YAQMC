import { Download, ExternalLink, Puzzle, RefreshCw, Search, Star } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PluginStoreAsset,
  PluginStoreAssetRef,
  PluginStoreFilter,
  PluginStoreRelease,
  PluginStoreRepository,
  PluginStoreSort,
} from '@yaqmc/client';
import { hasHostCapability } from '../application/host-capabilities';
import { listPlugins, type PluginRecord } from '../application/plugin-runtime';
import {
  createLatestGate,
  currentStorePlatform,
  defaultStoreAsset,
  formatBytes,
  latestInstallableRelease,
  parseStoreError,
  storeInstallState,
  type StoreError,
} from '../application/plugin-store';
import { openExternalUrl } from '../application/external-links';
import { getHostBridge, getYaqmcClient } from '../application/yaqmc-runtime';
import { PluginDialog } from './PluginDialog';
import { PluginUpdatePanel } from './PluginUpdatePanel';
import { Select } from './ui/Select';

const client = getYaqmcClient();
const SEARCH_DEBOUNCE_MS = 350;
/** Release summaries are prefetched for a bounded number of cards to respect anonymous quotas. */
const PREFETCH_LIMIT = 12;
const PREFETCH_CONCURRENCY = 2;

type ReleaseSummary =
  | { status: 'loading' }
  | { status: 'ready'; latest: PluginStoreRelease | null; any: boolean }
  | { status: 'error' };

interface SearchState {
  items: PluginStoreRepository[];
  page: number;
  hasMore: boolean;
  totalCount: number;
  incomplete: boolean;
  stale: boolean;
}

const EMPTY: SearchState = {
  items: [],
  page: 0,
  hasMore: false,
  totalCount: 0,
  incomplete: false,
  stale: false,
};

function formatDate(value: string | null | undefined, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(locale);
}

export function PluginStore({ onShowInstalled }: { onShowInstalled: (pluginId: string) => void }) {
  const { t, i18n } = useTranslation('settings', { keyPrefix: 'plugins.store' });
  const available = hasHostCapability('plugins');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PluginStoreFilter>('all');
  const [sort, setSort] = useState<PluginStoreSort>('best-match');
  const [state, setState] = useState<SearchState>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<StoreError | null>(null);
  const [summaries, setSummaries] = useState<ReadonlyMap<string, ReleaseSummary>>(new Map());
  const [installed, setInstalled] = useState<PluginRecord[]>([]);
  const [selected, setSelected] = useState<PluginStoreRepository | null>(null);
  const gate = useRef(createLatestGate());
  const summaryRequested = useRef(new Set<string>());

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(input), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input]);

  const refreshInstalled = useCallback(async () => {
    if (hasHostCapability('plugins')) setInstalled(await listPlugins());
  }, []);

  useEffect(() => {
    if (!available) return undefined;
    const load = () => void refreshInstalled().catch(() => undefined);
    const timer = window.setTimeout(load, 0);
    const unlisten = client.on('plugin://changed', load);
    return () => {
      window.clearTimeout(timer);
      unlisten();
    };
  }, [available, refreshInstalled]);

  const search = useCallback(
    async (page: number, refresh: boolean) => {
      const token = gate.current.next();
      setLoading(true);
      setError(null);
      try {
        const result = await client.plugins.storeSearch({ query, filter, sort, page, refresh });
        // Results from an older query never overwrite a newer one.
        if (!gate.current.isCurrent(token)) return;
        setState((current) => {
          const previous = page === 1 ? [] : current.items;
          const known = new Set(previous.map((item) => item.id));
          return {
            items: [...previous, ...result.items.filter((item) => !known.has(item.id))],
            page: result.page,
            hasMore: result.hasMore,
            totalCount: result.totalCount,
            incomplete: result.incompleteResults,
            stale: result.stale,
          };
        });
      } catch (caught) {
        if (gate.current.isCurrent(token)) setError(parseStoreError(caught));
      } finally {
        if (gate.current.isCurrent(token)) setLoading(false);
      }
    },
    [filter, query, sort],
  );

  useEffect(() => {
    if (!available) return undefined;
    const timer = window.setTimeout(() => void search(1, false), 0);
    return () => window.clearTimeout(timer);
  }, [available, search]);

  // Bounded, sequential-ish release summary prefetch for the first cards only.
  useEffect(() => {
    const pending = state.items
      .slice(0, PREFETCH_LIMIT)
      .filter((repo) => !summaryRequested.current.has(repo.fullName));
    if (pending.length === 0) return;
    for (const repo of pending) summaryRequested.current.add(repo.fullName);
    let stopped = false;
    const queue = [...pending];
    const worker = async () => {
      while (!stopped && queue.length > 0) {
        const repo = queue.shift()!;
        setSummaries((current) => new Map(current).set(repo.fullName, { status: 'loading' }));
        try {
          const page = await client.plugins.storeReleases({ owner: repo.owner, repo: repo.repo });
          setSummaries((current) =>
            new Map(current).set(repo.fullName, {
              status: 'ready',
              latest: latestInstallableRelease(page.releases),
              any: page.releases.length > 0 || page.hiddenPrereleases > 0,
            }),
          );
        } catch (caught) {
          setSummaries((current) => new Map(current).set(repo.fullName, { status: 'error' }));
          // Stop spending quota once GitHub says no; details can still be opened.
          if (parseStoreError(caught).kind === 'rate-limited') stopped = true;
        }
      }
    };
    for (let index = 0; index < PREFETCH_CONCURRENCY; index += 1) void worker();
    return () => {
      stopped = true;
    };
  }, [state.items]);

  const errorText = (value: StoreError) =>
    value.kind === 'rate-limited'
      ? value.resetAtMs
        ? t('errors.rateLimitedUntil', {
            time: new Date(value.resetAtMs).toLocaleTimeString(i18n.language),
          })
        : t('errors.rate-limited')
      : t(`errors.${value.kind}`, { detail: value.detail });

  if (!available) {
    return (
      <p className="settings-empty" role="status">
        {t('unavailable')}
      </p>
    );
  }

  return (
    <div className="plugin-store">
      <div className="plugin-toolbar" role="toolbar" aria-label={t('toolbar')}>
        <label className="plugin-toolbar__search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={input}
            placeholder={t(`placeholder.${filter}`)}
            aria-label={t(`placeholder.${filter}`)}
            maxLength={200}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setQuery(input);
            }}
          />
        </label>
        <Select<PluginStoreFilter>
          value={filter}
          ariaLabel={t('filterLabel')}
          options={(['all', 'name', 'description', 'author', 'repository'] as const).map(
            (value) => ({ value, label: t(`filter.${value}`) }),
          )}
          onChange={setFilter}
        />
        <Select<PluginStoreSort>
          value={sort}
          ariaLabel={t('sortLabel')}
          options={(['best-match', 'stars', 'updated'] as const).map((value) => ({
            value,
            label: t(`sort.${value}`),
          }))}
          onChange={setSort}
        />
        <button
          type="button"
          className="button button--quiet"
          disabled={loading}
          onClick={() => {
            summaryRequested.current.clear();
            setSummaries(new Map());
            void search(1, true);
          }}
        >
          <RefreshCw size={14} /> {t('refresh')}
        </button>
      </div>
      <p className="plugin-manager__hint">{t('discoveryNotice')}</p>

      <div className="plugin-store__status" role="status" aria-live="polite">
        {loading && state.items.length === 0 && t('loading')}
        {!loading && !error && state.page > 0 && t('resultCount', { count: state.totalCount })}
        {state.incomplete && ` · ${t('incomplete')}`}
        {state.stale && ` · ${t('stale')}`}
      </div>
      {error && (
        <div className="plugin-banner plugin-banner--error" role="alert">
          <span>{errorText(error)}</span>
          {state.items.length > 0 && <span>{t('showingCached')}</span>}
          <button
            type="button"
            className="button button--quiet"
            onClick={() => void search(1, true)}
          >
            {t('retry')}
          </button>
        </div>
      )}
      {!loading && !error && state.page > 0 && state.items.length === 0 && (
        <p className="settings-empty plugin-manager__empty">
          {query.trim() ? t('noResults') : t('noPlugins')}
        </p>
      )}

      <ul className="plugin-grid plugin-grid--store">
        {state.items.map((repo) => (
          <StoreCard
            key={repo.id}
            repo={repo}
            summary={summaries.get(repo.fullName)}
            installed={installed}
            locale={i18n.language}
            onOpen={() => setSelected(repo)}
          />
        ))}
      </ul>
      {state.hasMore && (
        <button
          type="button"
          className="button button--quiet plugin-store__more"
          disabled={loading}
          onClick={() => void search(state.page + 1, false)}
        >
          {loading ? t('loading') : t('loadMore')}
        </button>
      )}

      {selected && (
        <StoreDetails
          repo={selected}
          installed={installed}
          onClose={() => setSelected(null)}
          onInstalled={() => void refreshInstalled()}
          onShowInstalled={(pluginId) => {
            setSelected(null);
            onShowInstalled(pluginId);
          }}
          errorText={errorText}
        />
      )}
    </div>
  );
}

/** Local icon only: remote avatars would need a looser `img-src` policy. */
function RepoAvatar({ repo }: { repo: PluginStoreRepository }) {
  return (
    <span className="plugin-card__icon" aria-hidden="true" data-owner-type={repo.ownerType}>
      <Puzzle size={18} />
    </span>
  );
}

function StoreCard({
  repo,
  summary,
  installed,
  locale,
  onOpen,
}: {
  repo: PluginStoreRepository;
  summary: ReleaseSummary | undefined;
  installed: readonly PluginRecord[];
  locale: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation('settings', { keyPrefix: 'plugins.store' });
  const latest = summary?.status === 'ready' ? summary.latest : null;
  const state = storeInstallState(repo, installed, latest);
  const updated = formatDate(repo.pushedAt ?? repo.updatedAt, locale);
  const status = state.candidateUpdate
    ? t('state.updateCandidate')
    : state.installed.length > 0
      ? t('state.installed', { version: state.installed.map((p) => p.version).join(', ') })
      : summary?.status === 'ready'
        ? latest
          ? t('state.installable')
          : summary.any
            ? t('state.noPackage')
            : t('state.noRelease')
        : summary?.status === 'loading'
          ? t('state.checking')
          : t('state.openDetails');
  return (
    <li
      className="plugin-card plugin-card--store"
      data-installed={state.installed.length > 0 || undefined}
    >
      <div className="plugin-card__head">
        <RepoAvatar repo={repo} />
        <div className="plugin-card__copy">
          <button type="button" className="plugin-card__name" onClick={onOpen}>
            {repo.repo}
          </button>
          <small className="plugin-card__repo">{repo.fullName}</small>
        </div>
        <span
          className="plugin-card__status"
          data-tone={repo.organizationOwned ? 'org' : undefined}
        >
          {repo.organizationOwned ? t('sourceOrganization') : t('sourceCommunity')}
        </span>
      </div>
      <p className="plugin-card__description">{repo.description ?? t('noDescription')}</p>
      <p className="plugin-card__meta">
        {[
          latest?.tagName,
          repo.owner,
          repo.license,
          updated ? t('updated', { date: updated }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        <span className="plugin-card__stars" aria-label={t('stars', { count: repo.stars })}>
          <Star size={12} aria-hidden="true" /> {repo.stars}
        </span>
      </p>
      {repo.archived && <p className="plugin-card__reason">{t('archived')}</p>}
      <div className="plugin-card__actions">
        <span className="plugin-card__state">{status}</span>
        <button type="button" className="button button--secondary" onClick={onOpen}>
          {state.installed.length > 0 ? (
            t('details')
          ) : (
            <>
              <Download size={14} /> {t('install')}
            </>
          )}
        </button>
      </div>
    </li>
  );
}

function StoreDetails({
  repo,
  installed,
  onClose,
  onInstalled,
  onShowInstalled,
  errorText,
}: {
  repo: PluginStoreRepository;
  installed: readonly PluginRecord[];
  onClose: () => void;
  onInstalled: () => void;
  onShowInstalled: (pluginId: string) => void;
  errorText: (error: StoreError) => string;
}) {
  const { t, i18n } = useTranslation('settings', { keyPrefix: 'plugins.store' });
  const platform = useMemo(() => currentStorePlatform(getHostBridge().kind), []);
  const [prereleases, setPrereleases] = useState(false);
  const [releases, setReleases] = useState<PluginStoreRelease[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [hidden, setHidden] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<StoreError | null>(null);
  const [releaseId, setReleaseId] = useState<number | null>(null);
  const [assetId, setAssetId] = useState<number | null>(null);
  const [install, setInstall] = useState<PluginStoreAssetRef | null>(null);
  const [installedId, setInstalledId] = useState<string | null>(null);
  const gate = useRef(createLatestGate());
  const state = storeInstallState(repo, installed, latestInstallableRelease(releases));
  const release = releases.find((candidate) => candidate.id === releaseId) ?? null;

  const choose = useCallback(
    (next: PluginStoreRelease | null) => {
      setReleaseId(next?.id ?? null);
      setAssetId(next ? (defaultStoreAsset(next.assets, platform)?.id ?? null) : null);
    },
    [platform],
  );

  const load = useCallback(
    async (nextPage: number, refresh = false) => {
      const token = gate.current.next();
      setLoading(true);
      setError(null);
      try {
        const result = await client.plugins.storeReleases({
          owner: repo.owner,
          repo: repo.repo,
          includePrereleases: prereleases,
          page: nextPage,
          refresh,
        });
        if (!gate.current.isCurrent(token)) return;
        if (nextPage === 1) {
          setReleases(result.releases);
          choose(latestInstallableRelease(result.releases));
        } else {
          setReleases((current) => [...current, ...result.releases]);
        }
        setPage(result.page);
        setHasMore(result.hasMore);
        setHidden((current) => (nextPage === 1 ? 0 : current) + result.hiddenPrereleases);
      } catch (caught) {
        if (gate.current.isCurrent(token)) setError(parseStoreError(caught));
      } finally {
        if (gate.current.isCurrent(token)) setLoading(false);
      }
    },
    [choose, prereleases, repo.owner, repo.repo],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(1), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const asset: PluginStoreAsset | null = release?.assets.find((a) => a.id === assetId) ?? null;

  return (
    <PluginDialog label={repo.fullName} closeLabel={t('close')} wide onClose={onClose}>
      <div className="plugin-details">
        <header className="plugin-details__header">
          <RepoAvatar repo={repo} />
          <div>
            <h2>{repo.repo}</h2>
            <p>
              {repo.fullName} ·{' '}
              {repo.organizationOwned ? t('sourceOrganization') : t('sourceCommunity')}
            </p>
          </div>
        </header>
        {repo.description && <p>{repo.description}</p>}
        <p className="plugin-manager__hint">{t('trustNotice')}</p>
        <div className="plugin-review__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={() => void openExternalUrl(repo.htmlUrl).catch(() => undefined)}
          >
            {t('openRepository')} <ExternalLink size={12} />
          </button>
          {state.installed.map((plugin) => (
            <button
              key={plugin.id}
              type="button"
              className="button button--quiet"
              onClick={() => onShowInstalled(plugin.id)}
            >
              {t('showInstalled', { name: plugin.name, version: plugin.version })}
            </button>
          ))}
        </div>

        <h3>{t('releases')}</h3>
        <label className="plugin-check">
          <input
            type="checkbox"
            checked={prereleases}
            onChange={(event) => setPrereleases(event.target.checked)}
          />
          {t('includePrereleases')}
        </label>
        {error && (
          <p className="plugin-banner plugin-banner--error" role="alert">
            {errorText(error)}{' '}
            <button
              type="button"
              className="button button--quiet"
              onClick={() => void load(1, true)}
            >
              {t('retry')}
            </button>
          </p>
        )}
        {loading && releases.length === 0 && <p role="status">{t('loadingReleases')}</p>}
        {!loading && !error && releases.length === 0 && (
          <p className="settings-empty" role="status">
            {hidden > 0 ? t('onlyPrereleases', { count: hidden }) : t('noReleasesDetail')}
          </p>
        )}
        {releases.length > 0 && (
          <fieldset className="plugin-releases">
            <legend>{t('chooseRelease')}</legend>
            {releases.map((candidate) => (
              <label key={candidate.id} className="plugin-releases__item">
                <input
                  type="radio"
                  name={`release-${repo.id}`}
                  checked={candidate.id === releaseId}
                  disabled={install !== null}
                  onChange={() => choose(candidate)}
                />
                <span>
                  <strong>{candidate.name ?? candidate.tagName}</strong>{' '}
                  <small>
                    {candidate.tagName}
                    {candidate.prerelease ? ` · ${t('prerelease')}` : ''}
                    {formatDate(candidate.publishedAt, i18n.language)
                      ? ` · ${formatDate(candidate.publishedAt, i18n.language)}`
                      : ''}
                    {' · '}
                    {candidate.assets.length > 0
                      ? t('packageCount', { count: candidate.assets.length })
                      : t('state.noPackage')}
                  </small>
                </span>
              </label>
            ))}
            {hasMore && (
              <button
                type="button"
                className="button button--quiet"
                disabled={loading}
                onClick={() => void load(page + 1)}
              >
                {t('moreReleases')}
              </button>
            )}
          </fieldset>
        )}

        {release && (
          <section className="plugin-release-detail" aria-label={release.tagName}>
            {release.body && (
              <>
                <h3>{t('releaseNotes')}</h3>
                {/* Untrusted Markdown is shown as plain text; no HTML, scripts or links render. */}
                <pre className="plugin-release-notes">{release.body}</pre>
              </>
            )}
            <h3>{t('packages')}</h3>
            {release.assets.length === 0 ? (
              <p className="settings-empty">
                {t('noPackageDetail', { count: release.otherAssetCount })}
              </p>
            ) : (
              <fieldset className="plugin-releases">
                <legend>{t('choosePackage')}</legend>
                {release.assets.length > 1 && !asset && (
                  <p className="plugin-manager__hint">{t('multiplePackages')}</p>
                )}
                {release.assets.map((candidate) => (
                  <label key={candidate.id} className="plugin-releases__item">
                    <input
                      type="radio"
                      name={`asset-${release.id}`}
                      checked={candidate.id === assetId}
                      disabled={install !== null}
                      onChange={() => setAssetId(candidate.id)}
                    />
                    <span>
                      <code>{candidate.name}</code>{' '}
                      <small>
                        {formatBytes(candidate.size)}
                        {candidate.sha256 ? ` · SHA-256 ${candidate.sha256.slice(0, 12)}…` : ''}
                      </small>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <p className="plugin-manager__hint">{t('compatibilityNotice')}</p>
            <div className="plugin-review__actions">
              <button
                type="button"
                className="button"
                disabled={!asset || install !== null}
                onClick={() =>
                  asset &&
                  setInstall({
                    owner: repo.owner,
                    repo: repo.repo,
                    releaseId: release.id,
                    assetId: asset.id,
                  })
                }
              >
                <Download size={14} /> {t('downloadAndReview')}
              </button>
            </div>
          </section>
        )}

        {install && (
          <PluginUpdatePanel
            key={`${install.releaseId}:${install.assetId}`}
            request={{ github: install }}
            onChanged={async () => onInstalled()}
            onCompleted={(pluginId) => setInstalledId(pluginId)}
            onClose={() => setInstall(null)}
          />
        )}
        {installedId && (
          <p className="plugin-banner" role="status">
            {t('installedNotice')}{' '}
            <button
              type="button"
              className="button button--secondary"
              onClick={() => onShowInstalled(installedId)}
            >
              {t('showInManagement')}
            </button>
          </p>
        )}
      </div>
    </PluginDialog>
  );
}
