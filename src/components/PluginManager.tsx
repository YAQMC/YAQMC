import { Puzzle, ShieldAlert, Trash2, FilePlus, Copy, Power } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isNativeRuntime } from '../application/native-player-runtime';
import {
  choosePluginFile,
  inspectPluginPath,
  installPlugin,
  listPlugins,
  pluginDiagnosticsText,
  pluginHostSafeMode,
  setPluginEnabled,
  setPluginSafeMode,
  uninstallPlugin,
  type PluginInspectResult,
  type PluginRecord,
} from '../application/plugin-runtime';

function permissionLabel(permission: string, t: (key: string) => string): string {
  return t(`permission.${permission.replace('.', '_')}`);
}

export function PluginManager() {
  const { t } = useTranslation('settings', { keyPrefix: 'plugins' });
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [safeMode, setSafeMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspect, setInspect] = useState<PluginInspectResult | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [grant, setGrant] = useState<string[]>([]);
  const [details, setDetails] = useState<PluginRecord | null>(null);

  const refresh = useCallback(async () => {
    if (!isNativeRuntime) return;
    const [nextPlugins, nextSafeMode] = await Promise.all([listPlugins(), pluginHostSafeMode()]);
    setPlugins(nextPlugins);
    setSafeMode(nextSafeMode);
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
      const next = await inspectPluginPath(path);
      setInspect(next);
      setPendingPath(path);
      setGrant(next.permissions.filter((permission) => permission !== 'player.control'));
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
      await installPlugin(pendingPath, { enable: true, grant });
      setInspect(null);
      setPendingPath(null);
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
      {safeMode && (
        <p className="settings-empty" role="status">
          {t('safeModeActive')}
        </p>
      )}
      {plugins.length === 0 && <p className="settings-empty">{t('empty')}</p>}
      <ul className="plugin-manager__list">
        {plugins.map((plugin) => (
          <li key={plugin.id} className="plugin-card">
            <button type="button" className="plugin-card__main" onClick={() => setDetails(plugin)}>
              <Puzzle size={16} />
              <span>
                <strong>{plugin.name}</strong>
                <small>
                  {plugin.version} · {plugin.status} · {t('unsigned')}
                </small>
              </span>
            </button>
            <button
              type="button"
              className="button button--quiet"
              aria-pressed={plugin.enabled}
              disabled={busy || plugin.status === 'incompatible'}
              onClick={() => void toggle(plugin, !plugin.enabled)}
            >
              <Power size={14} /> {plugin.enabled ? t('disable') : t('enable')}
            </button>
          </li>
        ))}
      </ul>
      {inspect && (
        <div className="plugin-review" role="dialog" aria-label={t('reviewTitle')}>
          <h3>{t('reviewTitle')}</h3>
          <p>
            {inspect.manifest.name} {inspect.manifest.version}
          </p>
          <p>
            SHA-256: <code>{inspect.sha256}</code>
          </p>
          <p>{t('unsigned')}</p>
          <ul>
            {inspect.permissions.map((permission) => (
              <li key={permission}>
                <label>
                  <input
                    type="checkbox"
                    checked={grant.includes(permission)}
                    disabled={permission !== 'player.control'}
                    onChange={(event) => {
                      setGrant((current) =>
                        event.target.checked
                          ? [...current, permission]
                          : current.filter((value) => value !== permission),
                      );
                    }}
                  />
                  {permissionLabel(permission, t)}
                  {permission === 'player.control' ? ` (${t('sensitive')})` : ''}
                </label>
              </li>
            ))}
          </ul>
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
            <button type="button" className="button button--quiet" onClick={() => setInspect(null)}>
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
            {details.id} · {details.version}
          </p>
          <p>
            SHA-256: <code>{details.packageSha256}</code>
          </p>
          <p>
            {t('entrypoints')}: {t('stylesCount', { count: details.entrypoints.styles })} ·{' '}
            {t('scenesCount', { count: details.entrypoints.scenes })} ·{' '}
            {details.entrypoints.script ? t('scriptYes') : t('scriptNo')}
          </p>
          <p>
            {t('permissions')}: {details.permissions.join(', ') || t('none')}
          </p>
          {details.statusReason && <p>{details.statusReason}</p>}
          <div className="plugin-review__actions">
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
