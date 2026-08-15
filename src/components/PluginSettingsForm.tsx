import { useEffect, useState } from 'react';
import { pluginSettingsGet, pluginSettingsSet } from '../application/plugin-runtime';

interface SettingsField {
  id: string;
  type?: string;
  label?: string;
  description?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<string | { value: string; label?: string }>;
}

export function PluginSettingsForm({ pluginId, schema }: { pluginId: string; schema: unknown }) {
  const fields = Array.isArray((schema as { fields?: SettingsField[] } | null)?.fields)
    ? ((schema as { fields: SettingsField[] }).fields ?? [])
    : [];
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void pluginSettingsGet(pluginId)
      .then((next) => {
        if (active) setValues(next);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [pluginId]);

  if (fields.length === 0) return null;

  const commit = async (id: string, value: unknown) => {
    setError(null);
    try {
      const next = await pluginSettingsSet(pluginId, { [id]: value });
      setValues(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="plugin-settings">
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {fields.map((field) => {
        const value = values[field.id] ?? field.default;
        const label = field.label ?? field.id;
        if (field.type === 'boolean') {
          return (
            <label key={field.id} className="settings-row">
              <span>{label}</span>
              <input
                type="checkbox"
                checked={value === true}
                onChange={(event) => void commit(field.id, event.target.checked)}
              />
            </label>
          );
        }
        if (field.type === 'color') {
          return (
            <label key={field.id} className="settings-row">
              <span>{label}</span>
              <input
                type="color"
                value={typeof value === 'string' ? value : '#ffffff'}
                onChange={(event) => void commit(field.id, event.target.value.toUpperCase())}
              />
            </label>
          );
        }
        if (field.type === 'select') {
          const options = field.options ?? [];
          return (
            <label key={field.id} className="settings-row">
              <span>{label}</span>
              <select
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => void commit(field.id, event.target.value)}
              >
                {options.map((option) => {
                  const optionValue = typeof option === 'string' ? option : option.value;
                  const optionLabel =
                    typeof option === 'string' ? option : (option.label ?? option.value);
                  return (
                    <option key={optionValue} value={optionValue}>
                      {optionLabel}
                    </option>
                  );
                })}
              </select>
            </label>
          );
        }
        if (field.type === 'multiselect') {
          const selected = Array.isArray(value) ? value.map(String) : [];
          const options = field.options ?? [];
          return (
            <fieldset key={field.id} className="plugin-settings">
              <legend>{label}</legend>
              {options.map((option) => {
                const optionValue = typeof option === 'string' ? option : option.value;
                return (
                  <label key={optionValue}>
                    <input
                      type="checkbox"
                      checked={selected.includes(optionValue)}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...selected, optionValue]
                          : selected.filter((item) => item !== optionValue);
                        void commit(field.id, next);
                      }}
                    />
                    {typeof option === 'string' ? option : (option.label ?? option.value)}
                  </label>
                );
              })}
            </fieldset>
          );
        }
        if (field.type === 'slider' || field.type === 'number') {
          return (
            <label key={field.id} className="settings-row">
              <span>{label}</span>
              <input
                type={field.type === 'slider' ? 'range' : 'number'}
                min={field.min}
                max={field.max}
                step={field.step ?? 1}
                value={typeof value === 'number' ? value : Number(value ?? 0)}
                onChange={(event) => void commit(field.id, Number(event.target.value))}
              />
            </label>
          );
        }
        return (
          <label key={field.id} className="settings-row">
            <span>{label}</span>
            <input
              type={field.type === 'password' ? 'password' : 'text'}
              value={typeof value === 'string' ? value : ''}
              autoComplete="off"
              onBlur={(event) => void commit(field.id, event.target.value)}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.id]: event.target.value }))
              }
            />
          </label>
        );
      })}
    </div>
  );
}
