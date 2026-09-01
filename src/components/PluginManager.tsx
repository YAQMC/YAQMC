import {
  Puzzle,
  ShieldAlert,
  Trash2,
  FilePlus,
  Copy,
  Power,
  FolderOpen,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isNativeRuntime } from '../application/native-player-runtime';
import {
  choosePluginDirectory,
  choosePluginFile,
  inspectPluginPath,
  installPlugin,
  installUnpackedPlugin,
  listPlugins,
  pluginDiagnosticsText,
  pluginHostDeveloperMode,
  pluginHostSafeMode,
  reloadPlugin,
  setPluginDeveloperMode,
  setPluginEnabled,
  setPluginSafeMode,
  uninstallPlugin,
  type PluginInspectResult,
  type PluginRecord,
} from '../application/plugin-runtime';
import { PluginSettingsForm } from './PluginSettingsForm';

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
  return t(`permission.${permissionKey(permission)}`);
}

function isSensitivePermission(permission: string): boolean {
  return (
    permission === 'player.control' ||
    permission === 'provider.playback' ||
    permission === 'provider.account' ||
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

function pluginStatusLabel(status: PluginRecord['status'], t: (key: string) => string): string {
  return t(`status.${status}`);
}

function permissionChanges(
  previous: string[] | null,
  next: string[],
): { added: string[]; removed: string[] } {
  if (!previous) return { added: [], removed: [] };
  return {
    added: next.filter((item) => !previous.includes(item)),
    removed: previous.filter((item) => !next.includes(item)),
  };
}

export function PluginManager() {
  const { t } = useTranslation('settings', { keyPrefix: 'plugins' });
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [safeMode, setSafeMode] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspect, setInspect] = useState<PluginInspectResult | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [pendingUnpacked, setPendingUnpacked] = useState(false);
  const [grant, setGrant] = useState<string[]>([]);
  const [details, setDetails] = useState<PluginRecord | null>(null);
  const [installedPermissions, setInstalledPermissions] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    if (!isNativeRuntime) return;
    const [nextPlugins, nextSafeMode, nextDeveloperMode] = await Promise.all([
      listPlugins(),
      pluginHostSafeMode(),
      pluginHostDeveloperMode(),
    ]);
    setPlugins(nextPlugins);
    setSafeMode(nextSafeMode);
    setDeveloperMode(nextDeveloperMode);
  }, []);

  useEffect(() => {
    if (!isNativeRuntime) return undefined;
    let active = true;
    const timer = window.setTimeout(() => {
      void refresh().catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  const beginReview = async (path: string, unpacked: boolean) => {
    const next = await inspectPluginPath(path);
    const existing = plugins.find((plugin) => plugin.id === next.manifest.id);
    setInspect(next);
    setPendingPath(path);
    setPendingUnpacked(unpacked);
    setInstalledPermissions(existing ? existing.permissions : null);
    setGrant(next.permissions.filter((permission) => !isSensitivePermission(permission)));
  };

  const handleInstall = async () => {
    setError(null);
    setBusy(true);
    try {
      const path = await choosePluginFile();
      if (!path) return;
      if (path.toLowerCase().endsWith('.ts')) {
        setError(t('typescriptRequiresBuild'));
        return;
      }
      if (path.toLowerCase().endsWith('.css')) {
        await installPlugin(path, { enable: true, grant: [] });
        await refresh();
        return;
      }
      await beginReview(path, false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleUnpacked = async () => {
    setError(null);
    setBusy(true);
    try {
      const path = await choosePluginDirectory();
      if (!path) return;
      await beginReview(path, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirmInstall = async () => {
    if (!pendingPath) return;
    setBusy(true);
    setError(null);
    try {
      if (pendingUnpacked) {
        await installUnpackedPlugin(pendingPath, { enable: true, grant });
      } else {
        await installPlugin(pendingPath, { enable: true, grant });
      }
      setInspect(null);
      setPendingPath(null);
      setInstalledPermissions(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (plugin: PluginRecord, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await setPluginEnabled(plugin.id, enabled, enabled ? plugin.permissions : []);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (plugin: PluginRecord) => {
    if (!window.confirm(t('uninstallConfirm', { name: plugin.name }))) return;
    const removeData = window.confirm(t('removeDataConfirm'));
    setBusy(true);
    try {
      await uninstallPlugin(plugin.id, removeData);
      setDetails(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleSafeMode = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await setPluginSafeMode(!safeMode);
      setSafeMode(next);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleDeveloperMode = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await setPluginDeveloperMode(!developerMode);
      setDeveloperMode(next);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const reviewDelta = inspect
    ? permissionChanges(installedPermissions, inspect.permissions)
    : { added: [], removed: [] };

  return (
    <div className="plugin-manager">
      {!isNativeRuntime && (
        <p className="settings-empty" role="status">
          {t('desktopOnly')}
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-row">
        <div>
          <strong>{t('install')}</strong>
          <span>{t('installDescription')}</span>
        </div>
        <button
          type="button"
          className="button button--secondary"
          disabled={!isNativeRuntime || busy}
          onClick={() => void handleInstall()}
        >
          <FilePlus size={14} /> {t('installAction')}
        </button>
      </div>
      {developerMode && (
        <div className="settings-row">
          <div>
            <strong>{t('installUnpacked')}</strong>
            <span>{t('installUnpackedDescription')}</span>
          </div>
          <button
            type="button"
            className="button button--secondary"
            disabled={!isNativeRuntime || busy}
            onClick={() => void handleUnpacked()}
          >
            <FolderOpen size={14} /> {t('installUnpackedAction')}
          </button>
        </div>
      )}
      <div className="settings-row">
        <div>
          <strong>{t('safeMode')}</strong>
          <span>{t('safeModeDescription')}</span>
        </div>
        <button
          type="button"
          className={safeMode ? 'button button--secondary' : 'button button--quiet'}
          aria-pressed={safeMode}
          disabled={!isNativeRuntime || busy}
          onClick={() => void handleSafeMode()}
        >
          <ShieldAlert size={14} /> {safeMode ? t('leaveSafeMode') : t('enterSafeMode')}
        </button>
      </div>
      <div className="settings-row">
        <div>
          <strong>{t('developerMode')}</strong>
          <span>{t('developerModeDescription')}</span>
        </div>
        <button
          type="button"
          className={developerMode ? 'button button--secondary' : 'button button--quiet'}
          aria-pressed={developerMode}
          disabled={!isNativeRuntime || busy}
          onClick={() => void handleDeveloperMode()}
        >
          {developerMode ? t('leaveDeveloperMode') : t('enterDeveloperMode')}
        </button>
      </div>
      {safeMode && (
        <p className="settings-empty" role="status">
          {t('safeModeActive')}
        </p>
      )}
      <h3 className="plugin-manager__heading">{t('installed')}</h3>
      {plugins.length === 0 ? (
        <p className="settings-empty plugin-manager__empty">{t('empty')}</p>
      ) : (
        <ul className="plugin-manager__list">
          {plugins.map((plugin) => {
            const chips = capabilityChips(plugin);
            return (
              <li key={plugin.id} className="plugin-card" data-status={plugin.status}>
                <button
                  type="button"
                  className="plugin-card__main"
                  aria-label={t('openDetails', { name: plugin.name })}
                  onClick={() => setDetails(plugin)}
                >
                  <span className="plugin-card__icon" aria-hidden="true">
                    <Puzzle size={18} />
                  </span>
                  <span className="plugin-card__copy">
                    <span className="plugin-card__title-row">
                      <strong>{plugin.name}</strong>
                      <span className="plugin-card__status">
                        {pluginStatusLabel(plugin.status, t)}
                      </span>
                    </span>
                    <small>
                      {t('version', { version: plugin.version })} · API {plugin.apiVersion}
                      {plugin.unsigned ? ` · ${t('unsigned')}` : ''}
                    </small>
                    {chips.length > 0 && (
                      <span className="plugin-card__capabilities" aria-label={t('capabilities')}>
                        {chips.map((chip) => (
                          <span key={chip} className="plugin-chip">
                            {chip}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </button>
                <div className="plugin-card__actions">
                  <button
                    type="button"
                    className="button button--quiet plugin-card__toggle"
                    aria-pressed={plugin.enabled}
                    disabled={busy || plugin.status === 'incompatible'}
                    onClick={() => void toggle(plugin, !plugin.enabled)}
                  >
                    <Power size={14} /> {plugin.enabled ? t('disable') : t('enable')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {inspect && (
        <div className="plugin-review" role="dialog" aria-label={t('reviewTitle')}>
          <h3>{t('reviewTitle')}</h3>
          <p>
            {inspect.manifest.name} {inspect.manifest.version} · API{' '}
            {inspect.manifest.apiVersion ?? 1}
          </p>
          <p>
            SHA-256: <code>{inspect.sha256}</code>
          </p>
          <p>{t('unsigned')}</p>
          {inspect.manifest.provider && (
            <p>
              {t('provider')}: {inspect.manifest.provider.id} · WIT{' '}
              {inspect.manifest.provider.witVersion} · {inspect.manifest.provider.world}
            </p>
          )}
          <ul>
            {inspect.permissions.map((permission) => (
              <li key={permission}>
                <label>
                  <input
                    type="checkbox"
                    checked={grant.includes(permission)}
                    disabled={!isSensitivePermission(permission)}
                    onChange={(event) => {
                      setGrant((current) =>
                        event.target.checked
                          ? [...current, permission]
                          : current.filter((value) => value !== permission),
                      );
                    }}
                  />
                  {permissionLabel(permission, t)}
                  {isSensitivePermission(permission) ? ` (${t('sensitive')})` : ''}
                </label>
              </li>
            ))}
          </ul>
          {reviewDelta.added.length > 0 && (
            <p>
              {t('permissionsAdded')}: {reviewDelta.added.join(', ')}
            </p>
          )}
          {reviewDelta.removed.length > 0 && (
            <p>
              {t('permissionsRemoved')}: {reviewDelta.removed.join(', ')}
            </p>
          )}
          <p>
            {t('deniedCapabilities')}: {t('deniedList')}
          </p>
          {(inspect.scriptScan.findings.length > 0 || inspect.styleScan.findings.length > 0) && (
            <pre className="plugin-scan">
              {[...inspect.styleScan.findings, ...inspect.scriptScan.findings]
                .map((finding) => `${finding.kind}: ${finding.count} — ${finding.detail}`)
                .join('\n')}
            </pre>
          )}
          <div className="plugin-review__actions">
            <button
              type="button"
              className="button button--quiet"
              onClick={() => {
                setInspect(null);
                setInstalledPermissions(null);
              }}
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void confirmInstall()}
            >
              {t('accept')}
            </button>
          </div>
        </div>
      )}
      {details && (
        <div className="plugin-review" role="dialog" aria-label={details.name}>
          <h3>{details.name}</h3>
          <p>{details.description}</p>
          <p>
            {details.id} · {details.version} · API {details.apiVersion}
          </p>
          <p>
            SHA-256: <code>{details.packageSha256}</code>
          </p>
          <p>
            {t('source')}: {details.source} · {t('risk')}: {details.riskRating}
          </p>
          <div className="plugin-capability-row">
            {capabilityChips(details).map((chip) => (
              <span key={chip} className="plugin-chip">
                {chip}
              </span>
            ))}
          </div>
          <p>
            {t('entrypoints')}: {t('stylesCount', { count: details.entrypoints.styles })} ·{' '}
            {t('scenesCount', { count: details.entrypoints.scenes })} ·{' '}
            {details.entrypoints.script ? t('scriptYes') : t('scriptNo')}
            {' · '}
            {details.entrypoints.component ? t('componentYes') : t('componentNo')}
          </p>
          {details.provider && (
            <p>
              {t('provider')}: {details.provider.id} · WIT {details.provider.witVersion} ·{' '}
              {details.provider.world}
              {details.provider.circuitOpen
                ? ` · ${t('circuitOpen', { count: details.provider.consecutiveFaults })}`
                : ''}
            </p>
          )}
          <p>
            {t('permissions')}: {details.permissions.join(', ') || t('none')}
          </p>
          {(details.networkOrigins ?? []).length > 0 && (
            <p>
              {t('networkOrigins')}: {details.networkOrigins?.join(', ')}
            </p>
          )}
          {details.status === 'failed' && (details.lastError || details.statusReason) && (
            <p role="status">
              {t('failed')}: {details.lastError ?? details.statusReason}
            </p>
          )}
          {details.settingsSchema ? (
            <PluginSettingsForm pluginId={details.id} schema={details.settingsSchema} />
          ) : null}
          <div className="plugin-review__actions">
            {developerMode && details.unpackedPath && (
              <button
                type="button"
                className="button button--quiet"
                onClick={() => void reloadPlugin(details.id).then(refresh)}
              >
                <RefreshCw size={14} /> {t('reload')}
              </button>
            )}
            <button
              type="button"
              className="button button--quiet"
              onClick={() => void navigator.clipboard.writeText(pluginDiagnosticsText(details))}
            >
              <Copy size={14} /> {t('copyDiagnostics')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => void remove(details)}
            >
              <Trash2 size={14} /> {t('uninstall')}
            </button>
            <button type="button" className="button" onClick={() => setDetails(null)}>
              {t('close')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
