import {
  Copy,
  ExternalLink,
  FilePlus,
  FolderOpen,
  Power,
  Puzzle,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasHostCapability, isAndroidRuntime } from '../application/host-capabilities';
import {
  choosePluginDirectory,
  choosePluginFile,
  listPlugins,
  pluginDiagnosticsText,
  pluginHostDeveloperMode,
  pluginHostSafeMode,
  setPluginDeveloperMode,
  setPluginEnabled,
  setPluginSafeMode,
  uninstallPlugin,
  type PluginRecord,
} from '../application/plugin-runtime';
import { storeSourceRepository } from '../application/plugin-store';
import { getYaqmcClient } from '../application/yaqmc-runtime';
import { openExternalUrl } from '../application/external-links';
import { PluginDialog } from './PluginDialog';
import { PluginSettingsForm } from './PluginSettingsForm';
import { PluginUpdatePanel } from './PluginUpdatePanel';
import { Select } from './ui/Select';
import { ActionMenu, ActionMenuItem } from './ui/ActionMenu';
import type { PluginUpdatePrepareRequest } from '@yaqmc/client';

type StatusFilter = 'all' | 'active' | 'disabled' | 'attention';

function permissionKey(permission: string): string {
  if (permission.startsWith('network:')) return 'network_origin';
  return permission.replaceAll('.', '_').replaceAll(':', '_');
}

function permissionLabel(
  permission: string,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  if (permission.startsWith('network:')) {
    return t('permission.network_origin', { origin: permission.slice('network:'.length) });
  }
  return t(`permission.${permissionKey(permission)}`, { defaultValue: permission });
}

function isSensitivePermission(permission: string): boolean {
  return (
    permission === 'player.control' ||
    permission === 'provider.playback' ||
    permission === 'provider.account' ||
    permission === 'files.read' ||
    permission === 'files.write' ||
    permission.startsWith('network:')
  );
}

function capabilityChips(plugin: PluginRecord): string[] {
  const chips: string[] = [];
  if (plugin.entrypoints.styles) chips.push('Styles');
  if (plugin.entrypoints.scenes) chips.push('Scenes');
  if (plugin.entrypoints.script) chips.push('Script');
  if (plugin.entrypoints.component) chips.push('WASM Component');
  if (plugin.provider) chips.push(...plugin.provider.capabilities);
  if (plugin.permissions.some((item) => item.startsWith('ui.'))) chips.push('UI');
  if (plugin.permissions.some((item) => item.startsWith('network:'))) chips.push('Network');
  return chips;
}

function matchesStatus(plugin: PluginRecord, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return plugin.status === 'active';
  if (filter === 'attention') return plugin.status === 'failed' || plugin.status === 'incompatible';
  return !plugin.enabled && plugin.status !== 'failed' && plugin.status !== 'incompatible';
}

/** Why a plugin is not running, in words; never just a coloured dot. */
function statusReason(plugin: PluginRecord): string | null {
  if (plugin.status === 'failed') return plugin.lastError ?? plugin.statusReason ?? null;
  if (plugin.status === 'incompatible' || plugin.statusReason) return plugin.statusReason ?? null;
  return null;
}

interface PluginManagerProps {
  /** Opens this plugin's details once it appears (e.g. after a store installation). */
  focusPluginId?: string | null;
  onFocusHandled?: () => void;
}

export function PluginManager({ focusPluginId = null, onFocusHandled }: PluginManagerProps) {
  const { t } = useTranslation('settings', { keyPrefix: 'plugins' });
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [safeMode, setSafeMode] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [updateRequest, setUpdateRequest] = useState<PluginUpdatePrepareRequest | null>(null);
  const [updateId, setUpdateId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [enableReviewId, setEnableReviewId] = useState<string | null>(null);
  const [enableGrants, setEnableGrants] = useState<string[]>([]);
  const actionPending = useRef(false);
  const available = hasHostCapability('plugins');
  const android = isAndroidRuntime();
  const details = plugins.find((plugin) => plugin.id === detailsId) ?? null;
  const enableReview = plugins.find((plugin) => plugin.id === enableReviewId) ?? null;

  const refresh = useCallback(async () => {
    if (!hasHostCapability('plugins')) return;
    const [nextPlugins, nextSafeMode, nextDeveloperMode] = await Promise.all([
      listPlugins(),
      pluginHostSafeMode(),
      pluginHostDeveloperMode(),
    ]);
    setPlugins(nextPlugins);
    setSafeMode(nextSafeMode);
    setDeveloperMode(nextDeveloperMode);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!hasHostCapability('plugins')) return undefined;
    let active = true;
    const load = () =>
      void refresh().catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    const timer = window.setTimeout(load, 0);
    // Store installs, uninstalls and failures elsewhere keep this list authoritative.
    const unlisten = getYaqmcClient().on('plugin://changed', load);
    return () => {
      active = false;
      window.clearTimeout(timer);
      unlisten();
    };
  }, [refresh]);

  useEffect(() => {
    if (!focusPluginId || !plugins.some((plugin) => plugin.id === focusPluginId)) return undefined;
    const timer = window.setTimeout(() => {
      setDetailsId(focusPluginId);
      setStatusFilter('all');
      setQuery('');
      onFocusHandled?.();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusPluginId, onFocusHandled, plugins]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return plugins.filter(
      (plugin) =>
        matchesStatus(plugin, statusFilter) &&
        (!needle ||
          [plugin.name, plugin.id, plugin.description ?? '', ...plugin.authors].some((field) =>
            field.toLowerCase().includes(needle),
          )),
    );
  }, [plugins, query, statusFilter]);

  const run = async (action: () => Promise<unknown>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };

  const handleInstall = () =>
    run(async () => {
      const path = await choosePluginFile();
      if (!path) return;
      if (path.toLowerCase().endsWith('.ts')) {
        setError(t('typescriptRequiresBuild'));
        return;
      }
      setUpdateId(null);
      setUpdateRequest({ path, unpacked: false });
    });

  const handleUnpacked = () =>
    run(async () => {
      const path = await choosePluginDirectory();
      if (!path) return;
      setUpdateId(null);
      setUpdateRequest({ path, unpacked: true });
    });

  const checkUpdates = () =>
    run(async () => {
      setNotice(null);
      const operation = await getYaqmcClient().plugins.checkUpdates();
      setNotice(
        operation.error
          ? t('center.checkFailed', { error: operation.error })
          : t('center.checkStarted'),
      );
    });

  const toggle = (plugin: PluginRecord, enabled: boolean, grants = plugin.grantedPermissions) =>
    run(async () => {
      await setPluginEnabled(plugin.id, enabled, enabled ? grants : []);
      setEnableReviewId(null);
      await refresh();
    });

  const requestToggle = (plugin: PluginRecord) => {
    if (
      !plugin.enabled &&
      plugin.permissions.some(
        (permission) =>
          isSensitivePermission(permission) && !plugin.grantedPermissions.includes(permission),
      )
    ) {
      setEnableReviewId(plugin.id);
      setEnableGrants([...plugin.grantedPermissions]);
      return;
    }
    void toggle(plugin, !plugin.enabled);
  };

  const remove = (plugin: PluginRecord) => {
    if (busy || actionPending.current) return;
    if (!window.confirm(t('uninstallConfirm', { name: plugin.name }))) return;
    const removeData = window.confirm(t('removeDataConfirm'));
    void run(async () => {
      await uninstallPlugin(plugin.id, removeData);
      setDetailsId(null);
      await refresh();
    });
  };

  const openUpdate = (plugin: PluginRecord) => {
    setUpdateRequest(null);
    setUpdateId(plugin.id);
    setDetailsId(null);
  };

  const sourceText = (plugin: PluginRecord) => {
    const store = storeSourceRepository(plugin.source);
    if (store) return t('center.sourceStore', { repository: store.repository });
    if (plugin.source.startsWith('trusted:')) return t('center.sourceTrusted');
    if (plugin.source === 'builtin') return t('center.sourceBuiltin');
    return t('center.sourceLocal');
  };

  const sensitiveGrantsButton = (
    permissions: string[],
    selected: string[],
    change: (grants: string[]) => void,
  ) => {
    const sensitive = permissions.filter(isSensitivePermission);
    if (sensitive.length === 0) return null;
    const allSelected = sensitive.every((permission) => selected.includes(permission));
    return (
      <button
        type="button"
        className="button button--quiet"
        disabled={busy}
        onClick={() =>
          change(
            allSelected
              ? selected.filter((permission) => !isSensitivePermission(permission))
              : [...new Set([...selected, ...sensitive])],
          )
        }
      >
        {t(allSelected ? 'clearSensitive' : 'selectSensitive')}
      </button>
    );
  };

  if (!available) {
    return (
      <div className="plugin-manager">
        <p className="settings-empty" role="status">
          {t('center.unavailable')}
        </p>
      </div>
    );
  }

  return (
    <div className="plugin-manager" aria-busy={busy || undefined}>
      <div className="plugin-toolbar" role="toolbar" aria-label={t('center.manageToolbar')}>
        <label className="plugin-toolbar__search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={t('center.searchInstalled')}
            aria-label={t('center.searchInstalled')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Select<StatusFilter>
          value={statusFilter}
          ariaLabel={t('center.statusFilter')}
          options={[
            { value: 'all', label: t('center.statusAll') },
            { value: 'active', label: t('status.active') },
            { value: 'disabled', label: t('status.disabled') },
            { value: 'attention', label: t('center.statusAttention') },
          ]}
          onChange={setStatusFilter}
        />
        <button
          type="button"
          className="button button--secondary"
          disabled={busy}
          onClick={() => void handleInstall()}
        >
          <FilePlus size={14} /> {t('installAction')}
        </button>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          title={t('center.checkUpdatesHint')}
          onClick={() => void checkUpdates()}
        >
          <ShieldCheck size={14} /> {t('center.checkUpdates')}
        </button>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          <RefreshCw size={14} /> {t('center.refresh')}
        </button>
      </div>
      <p className="plugin-manager__hint">{t('installDescription')}</p>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="settings-empty" role="status">
          {notice}
        </p>
      )}
      {safeMode && (
        <p className="plugin-banner" role="status">
          <ShieldAlert size={16} /> {t('safeModeActive')}
        </p>
      )}

      {enableReview && (
        <PluginDialog
          label={`${t('reviewTitle')} · ${enableReview.name}`}
          closeLabel={t('close')}
          onClose={() => setEnableReviewId(null)}
        >
          <h2>
            {t('reviewTitle')} · {enableReview.name}
          </h2>
          <p>{t('enableReviewDescription')}</p>
          {sensitiveGrantsButton(enableReview.permissions, enableGrants, setEnableGrants)}
          <ul className="plugin-permissions">
            {enableReview.permissions.filter(isSensitivePermission).map((permission) => (
              <li key={permission}>
                <label>
                  <input
                    type="checkbox"
                    checked={enableGrants.includes(permission)}
                    disabled={busy}
                    onChange={(event) =>
                      setEnableGrants((current) =>
                        event.target.checked
                          ? [...current, permission]
                          : current.filter((item) => item !== permission),
                      )
                    }
                  />
                  {permissionLabel(permission, t)}
                </label>
              </li>
            ))}
          </ul>
          <div className="plugin-review__actions">
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => setEnableReviewId(null)}
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              className="button"
              disabled={
                busy ||
                safeMode ||
                enableReview.permissions.some(
                  (permission) =>
                    isSensitivePermission(permission) && !enableGrants.includes(permission),
                )
              }
              onClick={() => void toggle(enableReview, true, enableGrants)}
            >
              {t('enable')}
            </button>
          </div>
        </PluginDialog>
      )}

      <div className="plugin-manager__heading">
        <h2>{t('installed')}</h2>
        {loaded && (
          <span>{t('center.countOf', { shown: visible.length, total: plugins.length })}</span>
        )}
      </div>
      {loaded && plugins.length === 0 ? (
        <p className="settings-empty plugin-manager__empty">{t('empty')}</p>
      ) : loaded && visible.length === 0 ? (
        <p className="settings-empty plugin-manager__empty">{t('center.noMatches')}</p>
      ) : (
        <ul className="plugin-grid">
          {visible.map((plugin) => {
            const chips = capabilityChips(plugin);
            const reason = statusReason(plugin);
            return (
              <li key={plugin.id} className="plugin-card" data-status={plugin.status}>
                <div className="plugin-card__head">
                  <span className="plugin-card__icon" aria-hidden="true">
                    <Puzzle size={18} />
                  </span>
                  <div className="plugin-card__copy">
                    <button
                      type="button"
                      className="plugin-card__name"
                      aria-label={t('openDetails', { name: plugin.name })}
                      onClick={() => setDetailsId(plugin.id)}
                    >
                      {plugin.name}
                    </button>
                    <small>
                      {t('version', { version: plugin.version })}
                      {plugin.authors.length > 0 ? ` · ${plugin.authors.join(', ')}` : ''}
                    </small>
                  </div>
                  <span className="plugin-card__status">{t(`status.${plugin.status}`)}</span>
                </div>
                {plugin.description && (
                  <p className="plugin-card__description">{plugin.description}</p>
                )}
                {reason && (
                  <p className="plugin-card__reason" role="status">
                    {reason}
                  </p>
                )}
                {chips.length > 0 && (
                  <span className="plugin-card__capabilities" aria-label={t('capabilities')}>
                    {chips.map((chip) => (
                      <span key={chip} className="plugin-chip">
                        {chip}
                      </span>
                    ))}
                  </span>
                )}
                <div className="plugin-card__actions">
                  <button
                    type="button"
                    className="button button--quiet plugin-card__toggle"
                    aria-pressed={plugin.enabled}
                    disabled={
                      busy || (safeMode && !plugin.enabled) || plugin.status === 'incompatible'
                    }
                    onClick={() => requestToggle(plugin)}
                  >
                    <Power size={14} /> {plugin.enabled ? t('disable') : t('enable')}
                  </button>
                  <button
                    type="button"
                    className="button button--quiet"
                    onClick={() => setDetailsId(plugin.id)}
                  >
                    {t('center.details')}
                  </button>
                  <ActionMenu label={t('center.moreActions', { name: plugin.name })} size="small">
                    <ActionMenuItem disabled={busy} onClick={() => openUpdate(plugin)}>
                      {t('updates.title')}
                    </ActionMenuItem>
                    <ActionMenuItem
                      onClick={() =>
                        run(() => navigator.clipboard.writeText(pluginDiagnosticsText(plugin)))
                      }
                    >
                      {t('copyDiagnostics')}
                    </ActionMenuItem>
                    <ActionMenuItem disabled={busy} onClick={() => remove(plugin)}>
                      {t('uninstall')}
                    </ActionMenuItem>
                  </ActionMenu>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <details className="plugin-advanced">
        <summary>{t('center.advanced')}</summary>
        <div className="settings-row">
          <div>
            <strong>{t('safeMode')}</strong>
            <span>{t('safeModeDescription')}</span>
          </div>
          <button
            type="button"
            className={safeMode ? 'button button--secondary' : 'button button--quiet'}
            aria-pressed={safeMode}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setSafeMode(await setPluginSafeMode(!safeMode));
                await refresh();
              })
            }
          >
            <ShieldAlert size={14} /> {safeMode ? t('leaveSafeMode') : t('enterSafeMode')}
          </button>
        </div>
        <div className="settings-row">
          <div>
            <strong>{t('developerMode')}</strong>
            <span>
              {android ? t('center.developerModeAndroid') : t('developerModeDescription')}
            </span>
          </div>
          <button
            type="button"
            className={developerMode ? 'button button--secondary' : 'button button--quiet'}
            aria-pressed={developerMode}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setDeveloperMode(await setPluginDeveloperMode(!developerMode));
                await refresh();
              })
            }
          >
            {developerMode ? t('leaveDeveloperMode') : t('enterDeveloperMode')}
          </button>
        </div>
        {developerMode && !android && (
          <div className="settings-row">
            <div>
              <strong>{t('installUnpacked')}</strong>
              <span>{t('installUnpackedDescription')}</span>
            </div>
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => void handleUnpacked()}
            >
              <FolderOpen size={14} /> {t('installUnpackedAction')}
            </button>
          </div>
        )}
      </details>

      {(updateRequest || updateId) && (
        <PluginDialog
          label={t('updates.title')}
          closeLabel={t('close')}
          wide
          onClose={() => {
            setUpdateRequest(null);
            setUpdateId(null);
          }}
        >
          <PluginUpdatePanel
            key={updateId ?? updateRequest?.path}
            plugin={plugins.find((p) => p.id === updateId)}
            request={updateRequest ?? undefined}
            onChanged={refresh}
            onClose={() => {
              setUpdateRequest(null);
              setUpdateId(null);
            }}
          />
        </PluginDialog>
      )}

      {details && (
        <PluginDialog
          label={details.name}
          closeLabel={t('close')}
          wide
          onClose={() => setDetailsId(null)}
        >
          <div className="plugin-details">
            <header className="plugin-details__header">
              <span className="plugin-card__icon" aria-hidden="true">
                <Puzzle size={20} />
              </span>
              <div>
                <h2>{details.name}</h2>
                <p>
                  {t('version', { version: details.version })} · {t(`status.${details.status}`)}
                </p>
              </div>
            </header>
            {details.description && <p>{details.description}</p>}
            {statusReason(details) && (
              <p className="plugin-card__reason" role="status">
                {details.status === 'failed' ? `${t('failed')}: ` : ''}
                {statusReason(details)}
              </p>
            )}
            <dl className="plugin-details__facts">
              <dt>{t('center.pluginId')}</dt>
              <dd>
                <code>{details.id}</code>
              </dd>
              <dt>{t('center.apiPlatforms')}</dt>
              <dd>
                API {details.apiVersion} ·{' '}
                {details.platforms.length > 0
                  ? details.platforms.join(', ')
                  : t('center.allPlatforms')}
              </dd>
              {details.authors.length > 0 && (
                <>
                  <dt>{t('center.authors')}</dt>
                  <dd>{details.authors.join(', ')}</dd>
                </>
              )}
              {details.license && (
                <>
                  <dt>{t('center.license')}</dt>
                  <dd>{details.license}</dd>
                </>
              )}
              <dt>{t('source')}</dt>
              <dd>
                {sourceText(details)}
                {details.unsigned ? ` · ${t('unsigned')}` : ''}
              </dd>
              {details.repository && (
                <>
                  <dt>{t('center.repository')}</dt>
                  <dd>
                    <button
                      type="button"
                      className="plugin-link"
                      onClick={() => void run(() => openExternalUrl(details.repository!))}
                    >
                      {details.repository} <ExternalLink size={12} />
                    </button>
                  </dd>
                </>
              )}
              <dt>{t('center.release')}</dt>
              <dd>
                {details.release?.channel ?? 'stable'} ·{' '}
                {details.release?.buildId ?? t('updates.legacyBuild')}
              </dd>
              <dt>SHA-256</dt>
              <dd>
                <code className="plugin-details__hash">{details.packageSha256}</code>
              </dd>
              <dt>{t('risk')}</dt>
              <dd>{details.riskRating}</dd>
              <dt>{t('entrypoints')}</dt>
              <dd>
                {t('stylesCount', { count: details.entrypoints.styles })} ·{' '}
                {t('scenesCount', { count: details.entrypoints.scenes })} ·{' '}
                {details.entrypoints.script ? t('scriptYes') : t('scriptNo')} ·{' '}
                {details.entrypoints.component ? t('componentYes') : t('componentNo')}
              </dd>
              {details.provider && (
                <>
                  <dt>{t('provider')}</dt>
                  <dd>
                    {details.provider.id} · WIT {details.provider.witVersion} ·{' '}
                    {details.provider.world}
                    {details.provider.circuitOpen
                      ? ` · ${t('circuitOpen', { count: details.provider.consecutiveFaults })}`
                      : ''}
                  </dd>
                </>
              )}
            </dl>
            <h3>{t('permissions')}</h3>
            {details.permissions.length === 0 ? (
              <p>{t('none')}</p>
            ) : (
              <ul className="plugin-permissions">
                {details.permissions.map((permission) => (
                  <li key={permission}>
                    {permissionLabel(permission, t)}
                    {isSensitivePermission(permission) ? ` (${t('sensitive')})` : ''}
                    {details.grantedPermissions.includes(permission)
                      ? ''
                      : ` · ${t('center.notGranted')}`}
                  </li>
                ))}
              </ul>
            )}
            {details.settingsSchema ? (
              <>
                <h3>{t('center.configuration')}</h3>
                <PluginSettingsForm
                  key={details.id}
                  pluginId={details.id}
                  schema={details.settingsSchema}
                />
              </>
            ) : null}
            <div className="plugin-review__actions">
              <button
                type="button"
                className="button button--quiet"
                disabled={busy}
                onClick={() => openUpdate(details)}
              >
                <RefreshCw size={14} /> {t('updates.title')}
              </button>
              {developerMode && details.unpackedPath && (
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={busy}
                  onClick={() => {
                    setUpdateRequest({
                      pluginId: details.id,
                      path: details.unpackedPath!,
                      unpacked: true,
                    });
                    setUpdateId(details.id);
                    setDetailsId(null);
                  }}
                >
                  <RefreshCw size={14} /> {t('reload')}
                </button>
              )}
              <button
                type="button"
                className="button button--quiet"
                disabled={busy}
                onClick={() =>
                  void run(() => navigator.clipboard.writeText(pluginDiagnosticsText(details)))
                }
              >
                <Copy size={14} /> {t('copyDiagnostics')}
              </button>
              <button
                type="button"
                className="button button--quiet plugin-danger"
                disabled={busy}
                onClick={() => remove(details)}
              >
                <Trash2 size={14} /> {t('uninstall')}
              </button>
            </div>
          </div>
        </PluginDialog>
      )}
    </div>
  );
}
