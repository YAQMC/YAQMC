import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_SHORTCUTS,
  DEFAULT_GLOBAL_SHORTCUTS,
  SHORTCUT_ACTIONS,
  keyboardAccelerator,
  acceleratorIdentity,
  type ShortcutAction,
} from '@yaqmc/client';
import { usePreferencesStore } from '../application/preferences';
import {
  effectivePluginShortcut,
  shortcutConflict,
  usePluginShortcuts,
} from '../application/plugin-shortcuts';
import { hostCapabilities } from '../application/host-capabilities';

export function ShortcutSettings() {
  const { t } = useTranslation('settings', { keyPrefix: 'shortcuts' });
  const system = usePreferencesStore((s) => s.system);
  const update = usePreferencesStore((s) => s.updateSystem);
  const plugins = usePluginShortcuts();
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const rows = [
    ...SHORTCUT_ACTIONS.map((id) => ({
      key: id,
      label: t(`actions.${id}`),
      value: system.shortcutBindings[id],
      group: t('application'),
    })),
    ...(hostCapabilities().windowControls
      ? (['toggle', 'previous', 'next', 'volumeUp', 'volumeDown'] as ShortcutAction[]).map(
          (id) => ({
            key: `global:${id}`,
            label: t(`actions.${id}`),
            value: system.globalShortcutBindings[id],
            group: t('global'),
          }),
        )
      : []),
    ...plugins.map((c) => ({
      key: `${c.pluginId}/${c.id}`,
      label: `${c.pluginName}: ${c.label}`,
      value: effectivePluginShortcut(c),
      group: t('plugins'),
    })),
  ];
  const save = (key: string, value: string | null) => {
    if (shortcutConflict(value, key)) {
      setError(t('conflict'));
      return;
    }
    if (key.includes('/'))
      update({ pluginShortcutBindings: { ...system.pluginShortcutBindings, [key]: value } });
    else if (key.startsWith('global:'))
      update({
        globalShortcutBindings: { ...system.globalShortcutBindings, [key.slice(7)]: value },
      });
    else update({ shortcutBindings: { ...system.shortcutBindings, [key]: value } });
    setError('');
    setCapturing(null);
  };
  return (
    <section className="settings-section" aria-label={t('title')}>
      <h2>{t('title')}</h2>
      <p>{t('description')}</p>
      <div className="settings-card">
        {rows.map((row) => (
          <div className="settings-row" key={row.key}>
            <div>
              <strong>{row.label}</strong>
              <span>{row.group}</span>
            </div>
            <div className="shortcut-binding-controls">
              <button
                type="button"
                className="button"
                aria-label={`${t('edit')}: ${row.label} (${row.group})`}
                onClick={() => {
                  setCapturing(row.key);
                  setError('');
                }}
                onBlur={() => setCapturing(null)}
                onKeyDown={(event) => {
                  if (capturing !== row.key) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    setCapturing(null);
                    return;
                  }
                  const value = keyboardAccelerator(event.nativeEvent);
                  if (value) save(row.key, value);
                }}
              >
                {capturing === row.key ? t('press') : (row.value ?? t('unbound'))}
              </button>
              <button
                type="button"
                className="button button--ghost"
                aria-label={`${t('clear')}: ${row.label} (${row.group})`}
                onClick={() => save(row.key, null)}
              >
                {t('clear')}
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="button"
        onClick={() => {
          const used = new Set(
            [...Object.values(DEFAULT_SHORTCUTS), ...Object.values(DEFAULT_GLOBAL_SHORTCUTS)]
              .filter((v): v is string => v !== null)
              .map(acceleratorIdentity),
          );
          const overrides: Record<string, null> = {};
          for (const command of plugins) {
            const key = command.accelerator && acceleratorIdentity(command.accelerator);
            if (key && used.has(key)) overrides[`${command.pluginId}/${command.id}`] = null;
            else if (key) used.add(key);
          }
          update({
            shortcutBindings: DEFAULT_SHORTCUTS,
            globalShortcutBindings: DEFAULT_GLOBAL_SHORTCUTS,
            pluginShortcutBindings: overrides,
          });
          setError('');
          setCapturing(null);
        }}
      >
        {t('reset')}
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
