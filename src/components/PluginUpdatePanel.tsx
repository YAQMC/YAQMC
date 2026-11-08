import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PluginUpdateInfo,
  PluginUpdateOperation,
  PluginUpdatePrepareRequest,
  PluginReleaseChannel,
} from '@yaqmc/client';
import { getYaqmcClient } from '../application/yaqmc-runtime';
import { choosePluginFile, type PluginRecord } from '../application/plugin-runtime';
import { formatBytes, parseStoreError } from '../application/plugin-store';
import type { enUS } from '../locales/plugin-updates';

const client = getYaqmcClient();
const terminal = (phase: string) =>
  ['completed', 'unchanged', 'failed', 'cancelled'].includes(phase);

export function PluginUpdatePanel({
  plugin,
  request,
  onChanged,
  onCompleted,
  onClose,
}: {
  plugin?: PluginRecord;
  request?: PluginUpdatePrepareRequest;
  onChanged: () => Promise<void>;
  /** Called once with the installed plugin id when the reviewed package is active. */
  onCompleted?: (pluginId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings', { keyPrefix: 'plugins.updates' });
  const { t: permissionText } = useTranslation('settings', { keyPrefix: 'plugins.permission' });
  const label = (permission: string) =>
    permission.startsWith('network:')
      ? permissionText('network_origin', { origin: permission.slice('network:'.length) })
      : permissionText(
          permission.replaceAll('.', '_').replaceAll(':', '_') as Parameters<
            typeof permissionText
          >[0],
          { defaultValue: permission },
        );
  const { t: storeText } = useTranslation('settings', { keyPrefix: 'plugins.store' });
  const operationError = (error: string) => {
    const parsed = parseStoreError(error);
    return parsed.kind === 'other' ? error : storeText(`errors.${parsed.kind}`, { detail: error });
  };
  const [info, setInfo] = useState<PluginUpdateInfo | null>(null);
  const [operation, setOperation] = useState<PluginUpdateOperation | null>(null);
  const [grants, setGrants] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [binding, setBinding] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operationId = useRef<string | null>(null);
  const initialized = useRef(false);
  const observedPhase = useRef('');
  const preview = operation?.preview;
  const id = plugin?.id ?? operation?.pluginId;
  const loadInfo = useCallback(async () => {
    if (plugin?.id) setInfo(await client.plugins.updateInfo(plugin.id));
  }, [plugin]);

  const completed = useRef(onCompleted);
  useEffect(() => {
    completed.current = onCompleted;
  }, [onCompleted]);
  const acceptOperation = useCallback((next: PluginUpdateOperation) => {
    setOperation(next);
    if (
      (next.phase === 'completed' || next.phase === 'unchanged') &&
      next.pluginId &&
      observedPhase.current !== `${next.operationId}:${next.phase}`
    ) {
      completed.current?.(next.pluginId);
    }
    if (next.phase === 'prepared' && observedPhase.current !== `${next.operationId}:prepared`) {
      setGrants(
        next.preview?.grantedPermissions.filter((p) => next.preview?.permissions.includes(p)) ?? [],
      );
      setConfirmed(false);
    }
    observedPhase.current = `${next.operationId}:${next.phase}`;
  }, []);

  const prepare = useCallback(
    async (input: PluginUpdatePrepareRequest) => {
      const next = await client.plugins.prepareUpdate(input);
      operationId.current = next.operationId;
      acceptOperation(next);
    },
    [acceptOperation],
  );

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void (async () => {
        await loadInfo();
        if (request) await prepare(request);
        else if (plugin) {
          const pending = (await client.plugins.updateStatus())
            .filter((op) => op.pluginId === plugin.id && op.preview && !terminal(op.phase))
            .at(-1);
          if (pending) {
            operationId.current = pending.operationId;
            acceptOperation(pending);
          }
        }
      })().catch((e: unknown) => setError(String(e)));
    }
    const unlisten = client.on('plugin://update-progress', (next) => {
      if (next.operationId !== operationId.current) return;
      acceptOperation(next);
      if (terminal(next.phase))
        void Promise.all([loadInfo(), onChanged()]).catch((e: unknown) => setError(String(e)));
    });
    // Query closes the race between returning operationId and the first event,
    // and recovers progress if the event transport reconnects.
    const timer = setInterval(() => {
      const active = operationId.current;
      if (active)
        void client.plugins
          .updateStatus(active)
          .then(([next]) => {
            if (next) {
              const changed = observedPhase.current !== `${next.operationId}:${next.phase}`;
              acceptOperation(next);
              if (changed && terminal(next.phase))
                void Promise.all([loadInfo(), onChanged()]).catch((e: unknown) =>
                  setError(String(e)),
                );
            }
          })
          .catch((e: unknown) => setError(String(e)));
    }, 1000);
    return () => {
      unlisten();
      clearInterval(timer);
    };
  }, [loadInfo, prepare, request, plugin, acceptOperation, onChanged]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = async (stopUsing: boolean) => {
    if (!operation) return;
    acceptOperation(
      await client.plugins.applyUpdate({
        operationId: operation.operationId,
        grant: grants,
        confirm: confirmed,
        stopUsing,
      }),
    );
  };
  const savePolicy = async (
    channel: PluginReleaseChannel,
    automatic: boolean,
    bindingId?: string,
  ) => {
    if (!id || !info) return;
    await client.plugins.setUpdatePolicy({
      pluginId: id,
      sourceId: bindingId ?? info.policy.sourceId,
      channel,
      automatic,
      confirmSource: Boolean(bindingId),
    });
    setBinding(false);
    await loadInfo();
  };
  const canApply =
    operation?.phase === 'prepared' &&
    preview &&
    preview.addedPermissions.every((p) => grants.includes(p)) &&
    (preview.confirmations.length === 0 || confirmed);
  const source =
    info?.sources.find((s) => s.id === (sourceId || info.policy.sourceId)) ?? info?.sources[0];

  return (
    <section className="plugin-review plugin-update-panel" aria-label={t('title')}>
      <h3>
        {t('title')}
        {plugin ? ` · ${plugin.name}` : ''}
      </h3>
      {plugin && (
        <p>
          {plugin.version} · {plugin.release?.channel ?? 'stable'} ·{' '}
          {plugin.release?.buildId ?? t('legacyBuild')}
        </p>
      )}
      {plugin && (
        <p>
          SHA-256: <code style={{ overflowWrap: 'anywhere' }}>{plugin.packageSha256}</code>
        </p>
      )}
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      {info && (
        <>
          {info.sources.length === 0 ? (
            <p>{t('noSources')}</p>
          ) : (
            <>
              <label>
                {t('source')}{' '}
                <select
                  value={source?.id ?? ''}
                  onChange={(e) => setSourceId(e.target.value)}
                  disabled={busy}
                >
                  {info.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              {source && (
                <p>
                  {source.repository} · {source.keyId}
                </p>
              )}
              {(!info.policy.bound || source?.id !== info.policy.sourceId) && (
                <button className="button button--quiet" onClick={() => setBinding(true)}>
                  {t('bind')}
                </button>
              )}
              {binding && source && (
                <div>
                  <p>{t('bindExplanation')}</p>
                  <p>{source.feedUrl}</p>
                  <code>{source.publicKey}</code>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void run(() => savePolicy('stable', true, source.id))}
                  >
                    {t('confirmBind')}
                  </button>
                  <button className="button button--quiet" onClick={() => setBinding(false)}>
                    {t('cancel')}
                  </button>
                </div>
              )}
              {info.policy.bound && (
                <>
                  <label>
                    {t('channel')}{' '}
                    <select
                      value={info.policy.channel}
                      disabled={busy}
                      onChange={(e) =>
                        void run(() =>
                          savePolicy(e.target.value as PluginReleaseChannel, info.policy.automatic),
                        )
                      }
                    >
                      {(['stable', 'beta', 'nightly'] as const).map((channel) => (
                        <option key={channel}>{channel}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={info.policy.automatic}
                      disabled={busy}
                      onChange={(e) =>
                        void run(() => savePolicy(info.policy.channel, e.target.checked))
                      }
                    />
                    {t('automatic')}
                  </label>
                  <p>{t('schedule')}</p>
                  <button
                    className="button button--quiet"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const op = await client.plugins.checkUpdates(plugin?.id);
                        operationId.current = op.operationId;
                        acceptOperation(op);
                      })
                    }
                  >
                    {t('check')}
                  </button>
                </>
              )}
              {info.available
                .filter((r) => r.channel === info.policy.channel)
                .map((release) => (
                  <p key={release.releaseId}>
                    {release.version} · {release.channel} · {release.buildId}{' '}
                    <button
                      className="button button--quiet"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          prepare({ pluginId: id ?? undefined, releaseId: release.releaseId }),
                        )
                      }
                    >
                      {t('review')}
                    </button>
                  </p>
                ))}
            </>
          )}
          {info.policy.lastResult && (
            <p>
              {t('lastResult')}: {info.policy.lastResult}
            </p>
          )}
        </>
      )}
      {!request?.github && (
        <button
          className="button button--quiet"
          disabled={
            busy ||
            (operation !== null && !terminal(operation.phase) && operation.phase !== 'prepared')
          }
          onClick={() =>
            void run(async () => {
              const path = await choosePluginFile();
              if (path) {
                if (operation?.phase === 'prepared')
                  await client.plugins.cancelUpdate(operation.operationId);
                await prepare({ pluginId: id ?? undefined, path });
              }
            })
          }
        >
          {t('local')}
        </button>
      )}
      {operation && (
        <p role="status">
          {t(`phase.${operation.phase as keyof typeof enUS.phase}`, {
            defaultValue: operation.phase,
          })}
          {operation.totalBytes
            ? ` · ${formatBytes(operation.downloadedBytes)} / ${formatBytes(operation.totalBytes)}`
            : ''}
          {operation.error ? ` · ${operationError(operation.error)}` : ''}
        </p>
      )}
      {preview && (
        <>
          <p>
            {preview.currentVersion ?? t('newInstall')} → {preview.version} ·{' '}
            {preview.release?.channel ?? 'stable'} · {preview.release?.buildId ?? t('legacyBuild')}
          </p>
          <p>
            SHA-256: <code style={{ overflowWrap: 'anywhere' }}>{preview.sha256}</code>
          </p>
          <p>
            {preview.sessionChanges.length
              ? t('sessionChanged', { providers: preview.sessionChanges.join(', ') })
              : t('sessionKept')}
          </p>
          {!preview.enabled && <p>{t('staysDisabled')}</p>}
          <p>{t('playbackImpact')}</p>
          {preview.removedPermissions.length > 0 && (
            <p>
              {t('removed')}: {preview.removedPermissions.map(label).join(', ')}
            </p>
          )}
          {operation.phase === 'prepared' && (
            <>
              {preview.addedPermissions.length > 0 && (
                <fieldset>
                  <legend>{t('added')}</legend>
                  {preview.addedPermissions.map((permission) => (
                    <label key={permission} style={{ display: 'block' }}>
                      <input
                        type="checkbox"
                        checked={grants.includes(permission)}
                        onChange={(e) =>
                          setGrants((old) =>
                            e.target.checked
                              ? [...old, permission]
                              : old.filter((p) => p !== permission),
                          )
                        }
                      />
                      {label(permission)}
                    </label>
                  ))}
                  <button
                    className="button button--quiet"
                    onClick={() =>
                      setGrants(
                        preview.addedPermissions.every((p) => grants.includes(p))
                          ? preview.grantedPermissions.filter((p) =>
                              preview.permissions.includes(p),
                            )
                          : [...new Set([...grants, ...preview.addedPermissions])],
                      )
                    }
                  >
                    {t('togglePermissions')}
                  </button>
                </fieldset>
              )}
              {preview.confirmations.map((reason) => (
                <p key={reason}>
                  {t(`reason.${reason as keyof typeof enUS.reason}`, { defaultValue: reason })}
                </p>
              ))}
              {preview.confirmations.length > 0 && (
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  {t('confirmReview')}
                </label>
              )}
              <div className="plugin-review__actions">
                <button
                  className="button"
                  disabled={busy || !canApply}
                  onClick={() => void run(() => apply(false))}
                >
                  {t('applyIdle')}
                </button>
                <button
                  className="button button--quiet"
                  disabled={busy || !canApply}
                  onClick={() => void run(() => apply(true))}
                >
                  {t('stopApply')}
                </button>
              </div>
            </>
          )}
        </>
      )}
      {operation &&
        ['preparing', 'prepared', 'waiting-idle', 'checking'].includes(operation.phase) && (
          <button
            className="button button--quiet"
            disabled={busy}
            onClick={() => void run(() => client.plugins.cancelUpdate(operation.operationId))}
          >
            {t('cancel')}
          </button>
        )}
      {operation?.phase === 'waiting-idle' &&
        preview &&
        (preview.confirmations.length === 0 || confirmed) && (
          <button
            className="button button--quiet"
            disabled={busy}
            onClick={() => void run(() => apply(true))}
          >
            {t('stopApply')}
          </button>
        )}
      <button className="button button--quiet" onClick={onClose}>
        {t('close')}
      </button>
    </section>
  );
}
