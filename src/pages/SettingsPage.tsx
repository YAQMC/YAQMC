import { getYaqmcClient } from '../application/yaqmc-runtime';
import {
  Bug,
  Check,
  Copy,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Folder,
  Globe2,
  Headphones,
  Image as ImageIcon,
  Languages,
  LockKeyhole,
  Keyboard,
  LogIn,
  LogOut,
  Monitor,
  Music2,
  Palette,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Type,
  Unlock,
  Download,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocalApiSettings } from '../application/local-api';
import { useAccountStore } from '../application/account-runtime';
import {
  resetLyricsSurfacePosition,
  setLyricsSurfaceInteraction,
  unlockAllLyricsSurfaces,
} from '../application/lyrics-surface-runtime';
import {
  defaultPreferences,
  finishAppearancePreview,
  pickManagedBackgroundImage,
  formatBackgroundPickerError,
  previewAppearance,
  restoreCommittedAppearance,
  usePreferencesStore,
  validatedColorPatch,
  type AppearanceSettings,
  type InterfaceFontFamily,
  type LyricFontWeight,
  type LyricSurfaceSettings,
  type SecondaryLyricVisibility,
  type SurfaceKind,
} from '../application/preferences';
import {
  applyOverride,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  lyricsPresetDiagnostics,
  resolveLyricsPreset,
  saveAsNewPreset,
} from '../application/lyrics-preset';
import { isNativeRuntime } from '../application/native-player-runtime';
import { useProviderSettings } from '../application/provider-settings';
import { usePlatformIntegration } from '../application/platform-integration';
import { openProductLink } from '../application/external-links';
import { uiDiagnosticsEnabled } from '../application/ui-diagnostics';
import { buildMetadata, productMetadata, type ProductLink } from '../application/product-metadata';
import {
  clearOldLogs,
  currentLogLevel,
  currentConsoleForwardMode,
  DiagnosticsExportAbortedError,
  exportDiagnosticsBundle,
  openLogFolder,
  revealDiagnosticBundle,
  setConsoleForwardPreference,
  setLogLevel,
  type BundleExportResult,
} from '../application/diagnostics-runtime';
import {
  isPackagedElectronMainRenderer,
  type ConsoleForwardMode,
  type LogLevel,
} from '../application/logger';
import { IssueReporterDialog } from '../components/IssueReporterDialog';
import { LyricsPresetPicker } from '../components/LyricsPresetEditor';
import { PluginManager } from '../components/PluginManager';
import { SettingsUpdateSection } from '../components/SettingsUpdateSection';
import {
  SurfaceCapabilityBanner,
  surfaceCapabilitiesFromDiagnostics,
} from '../components/SurfaceCapabilityBanner';
import { useMusicProvider } from '../application/provider-context';
import { palettePresets, type PaletteId } from '../application/theme-tokens';
import { Select, type SelectOption } from '../components/ui/Select';
import { isAccountMusicProvider } from '../providers/music-provider';
import type { AudioQuality, AudioQualityPreference } from '../domain/music';

interface SurfaceCapabilities {
  desktop: boolean;
  island: boolean;
  platform: string;
  backend: string;
  reliableAlwaysOnTop: boolean;
  reliableClickThrough: boolean;
  reliableGlobalPositioning: boolean;
  limitations: string[];
}

function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section__heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function SettingRow({
  title,
  description,
  control,
  className = '',
}: {
  title: string;
  description: string;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div className={`settings-row ${className}`.trim()}>
      <div>
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      {control}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className="toggle-switch"
      data-active={checked || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function RangeControl({
  value,
  min,
  max,
  step = 1,
  label,
  output,
  onChange,
  onPreview,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  output: string | ((value: number) => string);
  onChange: (value: number) => void;
  onPreview?: (value: number) => void;
}) {
  const dragging = useRef(false);
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const progress = ((shown - min) / Math.max(Number.EPSILON, max - min)) * 100;
  const outputLabel = typeof output === 'function' ? output(shown) : output;

  const preview = (next: number) => {
    setDraft(next);
    onPreview?.(next);
  };
  const commit = (next: number) => {
    setDraft(null);
    onChange(next);
  };

  return (
    <label className="settings-range">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        aria-label={label}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          commit(Number(event.currentTarget.value));
        }}
        onPointerCancel={(event) => {
          dragging.current = false;
          commit(Number(event.currentTarget.value));
        }}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (dragging.current) {
            preview(next);
            return;
          }
          commit(next);
        }}
        onInput={(event) => {
          if (!dragging.current) return;
          preview(Number(event.currentTarget.value));
        }}
        style={{ '--range-progress': `${progress}%` } as CSSProperties}
      />
      <output>{outputLabel}</output>
    </label>
  );
}

function ColorControl({
  name,
  value,
  fallback,
  onChange,
  previewPatch,
}: {
  name: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
  previewPatch?: (value: string) => Partial<AppearanceSettings>;
}) {
  const { t } = useTranslation('settings', { keyPrefix: 'appearance' });
  const { t: common } = useTranslation('common');
  const [draftState, setDraftState] = useState({ source: value, draft: value });
  const commitTimer = useRef<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const commitPickerValue = useRef<(next: string) => void>(() => undefined);
  const previewsAppearance = Boolean(previewPatch);
  const draft = draftState.source === value ? draftState.draft : value;
  const valid = validatedColorPatch(draft, fallback);

  const previewDraft = (next: string) => {
    setDraftState({ source: value, draft: next });
    const normalized = validatedColorPatch(next, fallback);
    if (normalized && previewPatch) previewAppearance(previewPatch(normalized));
  };
  const commitDraft = (next: string) => {
    const normalized = validatedColorPatch(next, fallback);
    if (!normalized) {
      if (previewsAppearance) restoreCommittedAppearance();
      return;
    }
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    commitTimer.current = null;
    if (previewPatch) finishAppearancePreview();
    setDraftState({ source: normalized, draft: normalized });
    onChange(normalized);
  };
  const scheduleTextCommit = (next: string) => {
    previewDraft(next);
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    if (!validatedColorPatch(next, fallback)) return;
    commitTimer.current = window.setTimeout(() => commitDraft(next), 240);
  };

  useEffect(
    () => () => {
      if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
      if (previewsAppearance) restoreCommittedAppearance();
    },
    [previewsAppearance],
  );

  useEffect(() => {
    commitPickerValue.current = (next: string) => {
      const normalized = validatedColorPatch(next, fallback);
      if (!normalized) {
        if (previewsAppearance) restoreCommittedAppearance();
        return;
      }
      if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
      commitTimer.current = null;
      if (previewsAppearance) finishAppearancePreview();
      setDraftState({ source: normalized, draft: normalized });
      onChange(normalized);
    };
  }, [fallback, onChange, previewsAppearance]);

  useEffect(() => {
    const input = picker.current;
    if (!input) return;
    const commit = () => commitPickerValue.current(input.value);
    input.addEventListener('change', commit);
    return () => input.removeEventListener('change', commit);
  }, []);

  return (
    <div className="color-control" data-invalid={!valid || undefined}>
      <label className="color-control__picker" title={t('pickerLabel', { name })}>
        <span style={{ background: valid ?? value }} />
        <input
          ref={picker}
          type="color"
          value={valid ?? value}
          aria-label={t('pickerLabel', { name })}
          onInput={(event) => previewDraft(event.currentTarget.value)}
        />
      </label>
      <label className="color-control__hex">
        <span>#</span>
        <input
          value={draft.replace(/^#/, '')}
          maxLength={6}
          spellCheck={false}
          aria-label={t('hexLabel', { name })}
          aria-invalid={!valid}
          onChange={(event) => scheduleTextCommit(`#${event.target.value}`)}
          onBlur={() => commitDraft(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitDraft(draft);
            if (event.key === 'Escape') {
              setDraftState({ source: value, draft: value });
              restoreCommittedAppearance();
            }
          }}
        />
      </label>
      <button
        type="button"
        className="settings-icon-button"
        aria-label={`${common('reset')} ${name}`}
        onClick={() => commitDraft(fallback)}
      >
        <RotateCcw size={14} />
      </button>
      {!valid && <span className="color-control__error">{t('invalidColor')}</span>}
    </div>
  );
}

function safeAccountAvatarUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['qpic.y.qq.com', 'q.qlogo.cn', 'thirdwx.qlogo.cn', 'thirdqq.qlogo.cn'].includes(
        url.hostname,
      ) &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
      ? value
      : null;
  } catch {
    return null;
  }
}

function SurfacePreview({ kind }: { kind: SurfaceKind }) {
  const { t } = useTranslation('lyrics');
  return (
    <div className="surface-preview" data-kind={kind} aria-hidden="true">
      <span className="surface-preview__art" />
      <span>
        <strong>{t('previewLine')}</strong>
        <small>{t('previewNext')}</small>
      </span>
      {kind === 'island' && <i />}
    </div>
  );
}

function SurfaceSettingsPanel({ kind, supported }: { kind: SurfaceKind; supported: boolean }) {
  const { t } = useTranslation('settings', { keyPrefix: 'surfaces' });
  const { t: lyrics } = useTranslation('lyrics');
  const settings = usePreferencesStore((state) => state.surfaces[kind]);
  const updateSurface = usePreferencesStore((state) => state.updateSurface);
  const [interactionPending, setInteractionPending] = useState(false);
  const [interactionError, setInteractionError] = useState(false);
  const update = (patch: Partial<LyricSurfaceSettings>) => updateSurface(kind, patch);
  const name = kind === 'desktop' ? t('desktop') : t('island');
  const description = kind === 'desktop' ? t('desktopDescription') : t('islandDescription');
  const locked = settings.interaction === 'passive-locked';
  const changeInteraction = async (nextLocked: boolean) => {
    setInteractionPending(true);
    setInteractionError(false);
    try {
      await setLyricsSurfaceInteraction(kind, nextLocked ? 'passive-locked' : 'interactive');
    } catch {
      setInteractionError(true);
    } finally {
      setInteractionPending(false);
    }
  };
  const lineOptions: readonly SelectOption<LyricSurfaceSettings['lineMode']>[] = [
    { value: 'single', label: t('lineModeSingle') },
    { value: 'double', label: t('lineModeDouble') },
  ];
  const fontOptions: readonly SelectOption<LyricSurfaceSettings['fontMode']>[] = [
    { value: 'system', label: t('systemFont') },
    { value: 'application', label: t('appFont') },
    { value: 'custom', label: t('customFont') },
  ];
  const alignmentOptions: readonly SelectOption<LyricSurfaceSettings['alignment']>[] = [
    { value: 'left', label: t('alignLeft') },
    { value: 'center', label: t('alignCenter') },
    { value: 'right', label: t('alignRight') },
  ];
  const widthOptions: readonly SelectOption<LyricSurfaceSettings['width']>[] = [
    { value: 'compact', label: t('widthCompact') },
    { value: 'regular', label: t('widthRegular') },
    { value: 'wide', label: t('widthWide') },
  ];

  return (
    <div className="settings-surface" data-enabled={settings.enabled || undefined}>
      <div className="settings-surface__header">
        <div>
          <strong>{name}</strong>
          <span>{description}</span>
        </div>
        <Toggle
          label={t('enable', { name })}
          checked={settings.enabled && supported}
          disabled={!supported}
          onChange={(enabled) => update({ enabled })}
        />
      </div>
      <SurfacePreview kind={kind} />
      {settings.enabled && supported && locked && (
        <div className="settings-surface__lock-recovery" role="status">
          <LockKeyhole size={18} />
          <span>
            <strong>{t('lockedState', { name })}</strong>
            <small>{t('unlockHint')}</small>
          </span>
          <button
            type="button"
            className="button button--secondary"
            disabled={interactionPending}
            onClick={() => void changeInteraction(false)}
          >
            <Unlock size={14} />
            {interactionPending ? t('unlocking') : t('unlock')}
          </button>
        </div>
      )}
      {settings.enabled && supported && (
        <div className="settings-surface__controls">
          <SettingRow
            title={t('lineMode')}
            description={lyrics('currentAndNext')}
            control={
              <Select
                value={settings.lineMode}
                options={lineOptions}
                onChange={(lineMode) => update({ lineMode })}
                ariaLabel={t('lineMode')}
              />
            }
          />
          <SettingRow
            title={t('alwaysOnTop')}
            description={t('alwaysOnTopDescription')}
            control={
              <Toggle
                checked={settings.alwaysOnTop}
                label={t('alwaysOnTop')}
                onChange={(alwaysOnTop) => update({ alwaysOnTop })}
              />
            }
          />
          <SettingRow
            title={t('locked')}
            description={t('lockedDescription')}
            control={
              <Toggle
                checked={locked}
                disabled={interactionPending}
                label={locked ? t('unlockSurface', { name }) : t('lockSurface', { name })}
                onChange={(nextLocked) => void changeInteraction(nextLocked)}
              />
            }
          />
          {interactionError && (
            <p className="settings-surface__interaction-error" role="alert">
              {t('interactionError', { name })}
            </p>
          )}
          <SettingRow
            title={t('hideFullscreen')}
            description={t('hideFullscreenDescription')}
            control={
              <Toggle
                checked={settings.hideInFullscreen}
                label={t('hideFullscreen')}
                onChange={(hideInFullscreen) => update({ hideInFullscreen })}
              />
            }
          />
          <SettingRow
            title={t('fontSize')}
            description={t('fontFamily')}
            control={
              <RangeControl
                value={settings.fontSize}
                min={12}
                max={kind === 'desktop' ? 64 : 34}
                label={t('fontSize')}
                output={(value) => t('fontSizeValue', { value })}
                onChange={(fontSize) => update({ fontSize })}
              />
            }
          />
          <SettingRow
            title={t('fontFamily')}
            description={t('systemFont')}
            control={
              <div className="settings-inline-control">
                <Select
                  value={settings.fontMode}
                  options={fontOptions}
                  onChange={(fontMode) => update({ fontMode })}
                  ariaLabel={t('fontFamily')}
                  icon={Type}
                />
                {settings.fontMode === 'custom' && (
                  <input
                    className="settings-text-input"
                    value={settings.customFontFamily}
                    placeholder={t('customFontPlaceholder')}
                    aria-label={t('customFont')}
                    onChange={(event) => update({ customFontFamily: event.target.value })}
                  />
                )}
              </div>
            }
          />
          <SettingRow
            title={t('alignment')}
            description={t('alignment')}
            control={
              <Select
                value={settings.alignment}
                options={alignmentOptions}
                onChange={(alignment) => update({ alignment })}
                ariaLabel={t('alignment')}
              />
            }
          />
          <SettingRow
            title={t('primaryColor')}
            description={t('secondaryColor')}
            control={
              <div className="surface-color-pair">
                <ColorControl
                  name={t('primaryColor')}
                  value={settings.primaryColor}
                  fallback="#FFFFFF"
                  onChange={(primaryColor) => update({ primaryColor })}
                />
                <ColorControl
                  name={t('secondaryColor')}
                  value={settings.secondaryColor}
                  fallback="#C7CBC2"
                  onChange={(secondaryColor) => update({ secondaryColor })}
                />
              </div>
            }
          />
          <SettingRow
            title={t('backgroundOpacity')}
            description={t('backgroundOpacity')}
            control={
              <RangeControl
                value={settings.backgroundOpacity}
                min={0}
                max={100}
                label={t('backgroundOpacity')}
                output={(value) => `${value}%`}
                onChange={(backgroundOpacity) => update({ backgroundOpacity })}
              />
            }
          />
          {kind !== 'desktop' && (
            <>
              <SettingRow
                title={t('width')}
                description={t('width')}
                control={
                  <Select
                    value={settings.width}
                    options={widthOptions}
                    onChange={(width) => update({ width })}
                    ariaLabel={t('width')}
                  />
                }
              />
              <SettingRow
                title={t('offsetX')}
                description={t('offsetY')}
                control={
                  <div className="settings-range-pair">
                    <RangeControl
                      value={settings.horizontalPosition}
                      min={-100}
                      max={100}
                      label={t('offsetX')}
                      output={(value) => `${value}`}
                      onChange={(horizontalPosition) => update({ horizontalPosition })}
                    />
                    <RangeControl
                      value={settings.verticalOffset}
                      min={0}
                      max={160}
                      label={t('offsetY')}
                      output={(value) => `${value}px`}
                      onChange={(verticalOffset) => update({ verticalOffset })}
                    />
                  </div>
                }
              />
            </>
          )}
          <div className="settings-surface__actions">
            <button
              type="button"
              className="button button--quiet"
              onClick={() => void resetLyricsSurfacePosition(kind)}
            >
              <RotateCcw size={14} /> {t('resetPosition')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { t, i18n } = useTranslation('settings');
  const { t: common } = useTranslation('common');
  const { t: errors } = useTranslation('errors');
  const api = useLocalApiSettings();
  const provider = useProviderSettings();
  const musicProvider = useMusicProvider();
  const accountProvider = isAccountMusicProvider(musicProvider) ? musicProvider : null;
  const accountSnapshot = useAccountStore((state) => state.snapshot);
  const accountBusy = useAccountStore((state) => state.busy);
  const accountError = useAccountStore((state) => state.error);
  const openAccountDialog = useAccountStore((state) => state.openDialog);
  const signOut = useAccountStore((state) => state.signOut);
  const platform = usePlatformIntegration();
  const preferences = usePreferencesStore();
  const uiDiagnostics = uiDiagnosticsEnabled();
  const [copied, setCopied] = useState<'endpoint' | 'token' | null>(null);
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenTouched, setTokenTouched] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<SurfaceCapabilities | null>(null);
  const [unlockingAll, setUnlockingAll] = useState(false);
  const [logLevel, setLogLevelState] = useState<LogLevel>('info');
  const packagedConsoleForward = isPackagedElectronMainRenderer();
  const [consoleForward, setConsoleForwardState] = useState<ConsoleForwardMode>('error');
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsMessage, setDiagnosticsMessage] = useState<string | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [lastBundle, setLastBundle] = useState<BundleExportResult | null>(null);
  const [issueReporterOpen, setIssueReporterOpen] = useState(false);
  const {
    available: apiAvailable,
    revealToken: revealApiToken,
    status: apiStatus,
    token: apiToken,
  } = api;
  const visibleTokenDraft = tokenTouched ? tokenDraft : (apiToken ?? '');

  useEffect(() => {
    if (!isNativeRuntime) return;
    void getYaqmcClient()
      .invoke('lyrics_surface_capabilities')
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
  }, []);

  useEffect(() => {
    if (!apiAvailable || !apiStatus || apiToken !== null) return;
    void revealApiToken();
  }, [apiAvailable, apiStatus, apiToken, revealApiToken]);

  useEffect(() => {
    if (!isNativeRuntime) return;
    void currentLogLevel()
      .then(setLogLevelState)
      .catch(() => setLogLevelState('info'));
  }, []);

  useEffect(() => {
    if (!isNativeRuntime || !packagedConsoleForward) return;
    void currentConsoleForwardMode()
      .then(setConsoleForwardState)
      .catch(() => setConsoleForwardState('error'));
  }, [packagedConsoleForward]);

  const changeLogLevel = async (next: LogLevel) => {
    setDiagnosticsBusy(true);
    setDiagnosticsError(null);
    try {
      const applied = await setLogLevel(next);
      setLogLevelState(applied);
      setDiagnosticsMessage(t('diagnostics.levelChangeHint'));
    } catch (caught) {
      setDiagnosticsError(String(caught));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const changeConsoleForward = async (next: ConsoleForwardMode) => {
    setDiagnosticsBusy(true);
    setDiagnosticsError(null);
    try {
      const applied = await setConsoleForwardPreference(next);
      setConsoleForwardState(applied);
    } catch (caught) {
      setDiagnosticsError(String(caught));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const handleOpenLogFolder = async () => {
    setDiagnosticsBusy(true);
    setDiagnosticsError(null);
    setDiagnosticsMessage(null);
    try {
      await openLogFolder();
    } catch (caught) {
      setDiagnosticsError(String(caught));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const handleClearLogs = async () => {
    setDiagnosticsBusy(true);
    setDiagnosticsError(null);
    setDiagnosticsMessage(null);
    try {
      const removed = await clearOldLogs();
      setDiagnosticsMessage(t('diagnostics.clearLogsResult', { count: removed }));
    } catch (caught) {
      setDiagnosticsError(String(caught));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const handleExportBundle = async () => {
    setDiagnosticsBusy(true);
    setDiagnosticsError(null);
    setDiagnosticsMessage(null);
    try {
      const bundle = await exportDiagnosticsBundle({
        accountState: accountSnapshot.state,
        lyricsPreset: lyricsPresetDiagnostics(preferences.lyricsPresets),
        includeLogs: true,
        overrideUnresolved: false,
      });
      setLastBundle(bundle);
      setDiagnosticsMessage(t('diagnostics.bundleExported', { path: bundle.path }));
    } catch (caught) {
      if (caught instanceof DiagnosticsExportAbortedError) {
        return;
      }
      setDiagnosticsError(t('diagnostics.bundleFailed', { error: String(caught) }));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const handleRevealBundle = async () => {
    if (!lastBundle) return;
    try {
      await revealDiagnosticBundle(lastBundle.path);
    } catch (caught) {
      setDiagnosticsError(String(caught));
    }
  };

  const languageOptions: readonly SelectOption<typeof preferences.locale>[] = [
    { value: 'system', label: t('general.localeSystem') },
    { value: 'zh-CN', label: t('general.localeChinese') },
    { value: 'en-US', label: t('general.localeEnglish') },
  ];
  const modeOptions: readonly SelectOption<typeof preferences.appearance.colorMode>[] = [
    { value: 'system', label: t('appearance.modeSystem') },
    { value: 'light', label: t('appearance.modeLight') },
    { value: 'dark', label: t('appearance.modeDark') },
  ];
  const interfaceFontOptions: readonly SelectOption<InterfaceFontFamily>[] = [
    { value: 'application', label: t('appearance.interfaceFontApplication') },
    { value: 'system', label: t('appearance.interfaceFontSystem') },
    { value: 'serif', label: t('appearance.interfaceFontSerif') },
    { value: 'monospace', label: t('appearance.interfaceFontMonospace') },
  ];
  const paletteName = (id: PaletteId): string =>
    ({
      default: t('appearance.paletteDefault'),
      ember: t('appearance.paletteEmber'),
      ocean: t('appearance.paletteOcean'),
      violet: t('appearance.paletteViolet'),
      sakura: t('appearance.paletteSakura'),
      mint: t('appearance.paletteMint'),
      mono: t('appearance.paletteMono'),
      custom: t('appearance.paletteCustom'),
    })[id];
  const paletteOptions: readonly SelectOption<PaletteId>[] = [
    ...palettePresets.map((preset) => ({ value: preset.id, label: paletteName(preset.id) })),
    { value: 'custom', label: paletteName('custom') },
  ];
  const backgroundOptions: readonly SelectOption<typeof preferences.appearance.backgroundMode>[] = [
    { value: 'default', label: t('appearance.backgroundDefault') },
    { value: 'artwork', label: t('appearance.backgroundArtwork') },
    { value: 'color', label: t('appearance.backgroundColor') },
    { value: 'image', label: t('appearance.backgroundImage'), disabled: !isNativeRuntime },
  ];
  const fitOptions: readonly SelectOption<typeof preferences.appearance.backgroundFit>[] = [
    { value: 'cover', label: t('appearance.fitCover') },
    { value: 'contain', label: t('appearance.fitContain') },
  ];
  const materialOptions: readonly SelectOption<typeof preferences.appearance.material>[] = [
    { value: 'opaque', label: t('appearance.materialOpaque') },
    { value: 'translucent', label: t('appearance.materialTranslucent') },
  ];
  const lyricVisibilityOptions: readonly SelectOption<SecondaryLyricVisibility>[] = [
    { value: 'auto', label: t('lyrics.auto') },
    { value: 'show', label: t('lyrics.show') },
    { value: 'hide', label: t('lyrics.hide') },
  ];
  const lyricFontWeightOptions: readonly SelectOption<LyricFontWeight>[] = [
    { value: '400', label: t('lyrics.fontWeightRegular') },
    { value: '500', label: t('lyrics.fontWeightMedium') },
    { value: '600', label: t('lyrics.fontWeightSemibold') },
    { value: '700', label: t('lyrics.fontWeightBold') },
    { value: '800', label: t('lyrics.fontWeightExtrabold') },
    { value: '900', label: t('lyrics.fontWeightBlack') },
  ];
  const selectedLyricsPreset = resolveLyricsPreset(preferences.lyricsPresets);
  const updateSelectedLyricsTypography = (patch: { fontScale?: number; lineHeight?: number }) => {
    preferences.updateLyricsPresets((current) => {
      const selected = resolveLyricsPreset(current);
      if (selected.source === 'plugin') {
        const fork = saveAsNewPreset(current, selected.id);
        return applyOverride(fork.state, fork.id, { typography: patch });
      }
      return applyOverride(current, selected.id, { typography: patch });
    });
  };
  const qualityOptions: readonly SelectOption<AudioQualityPreference>[] = [
    { value: 'automatic', label: t('playback.qualityAutomatic') },
    { value: 'standard', label: t('playback.qualityStandard') },
    { value: 'high', label: t('playback.qualityHigh') },
    { value: 'lossless', label: t('playback.qualityLossless') },
    { value: 'master', label: t('playback.qualityMaster') },
  ];
  const closeBehaviorOptions: readonly SelectOption<typeof preferences.system.closeBehavior>[] = [
    { value: 'hide-to-tray', label: t('systemIntegration.closeToTray') },
    { value: 'quit', label: t('systemIntegration.closeToQuit') },
  ];
  const selectedOutput =
    provider.devices.find((device) => device.isSelected)?.id ?? 'system:default';
  const resolvedOutput = provider.devices.find((device) => device.isSelected)?.resolvedOutput;
  const outputOptions = useMemo(
    () =>
      provider.devices.length > 0
        ? provider.devices.map((device) => ({
            value: device.id,
            label:
              device.selectionKind === 'system-default' ? t('playback.systemOutput') : device.label,
          }))
        : [{ value: 'system:default', label: t('playback.systemOutput') }],
    [provider.devices, t],
  );
  const observedMaximumQuality =
    accountSnapshot.state === 'authenticated'
      ? accountSnapshot.entitlement.observedMaximumQuality
      : null;
  const qualityLabel = (quality: AudioQuality | null): string => {
    if (quality === 'master') return t('playback.qualityMaster');
    if (quality === 'lossless') return t('playback.qualityLossless');
    if (quality === 'high') return t('playback.qualityHigh');
    if (quality === 'standard') return t('playback.qualityStandard');
    return t('playback.qualityUnknown');
  };
  const lockedSurfaceKinds = (['desktop', 'island'] as const).filter(
    (kind) =>
      preferences.surfaces[kind].enabled &&
      preferences.surfaces[kind].interaction === 'passive-locked',
  );
  const unlockAllSurfaces = async () => {
    if (lockedSurfaceKinds.length === 0) return;
    setUnlockingAll(true);
    try {
      await unlockAllLyricsSurfaces();
    } finally {
      setUnlockingAll(false);
    }
  };

  const submitPort = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = Number(new FormData(event.currentTarget as HTMLFormElement).get('port'));
    if (Number.isInteger(parsed) && parsed >= 1_024 && parsed <= 65_535) void api.setPort(parsed);
  };
  const saveToken = async () => {
    if (await api.setToken(visibleTokenDraft)) {
      setTokenDraft('');
      setTokenTouched(false);
    }
  };
  const submitToken = (event: React.FormEvent) => {
    event.preventDefault();
    void saveToken();
  };
  const copyToken = async () => {
    if (!visibleTokenDraft) return;
    await navigator.clipboard.writeText(visibleTokenDraft);
    setCopied('token');
    window.setTimeout(() => setCopied(null), 1_500);
  };
  const copyEndpoint = async () => {
    if (!api.status) return;
    const port = api.status.boundPort ?? api.status.configuredPort;
    await navigator.clipboard.writeText(`http://${api.status.host}:${port}`);
    setCopied('endpoint');
    window.setTimeout(() => setCopied(null), 1_500);
  };
  const chooseImage = async () => {
    setImageError(null);
    try {
      const image = await pickManagedBackgroundImage();
      if (image) preferences.setManagedBackground(image.reference, image.dataUri);
    } catch (error) {
      setImageError(formatBackgroundPickerError(error, errors('imageFailed')));
    }
  };
  const regenerate = async () => {
    if (window.confirm(t('api.regenerateConfirm')) && (await api.regenerateToken())) {
      setTokenDraft('');
      setTokenTouched(false);
    }
  };
  const changeGlobalShortcuts = async (enabled: boolean) => {
    if (await platform.setGlobalShortcuts(enabled)) {
      preferences.updateSystem({ globalShortcutsEnabled: enabled });
    }
  };
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const number = new Intl.NumberFormat(locale);
  const connectionLabel = provider.status
    ? t(
        `account.${provider.status.connection}` as
          'account.online' | 'account.cached' | 'account.offline',
      )
    : null;
  const accountProfile = accountSnapshot.profile;
  const accountEntitlement = accountSnapshot.entitlement;
  const accountAvatarUrl = safeAccountAvatarUrl(accountProfile?.avatarUrl);
  const accountStateLabel = (() => {
    switch (accountSnapshot.state) {
      case 'guest':
      case 'cancelled':
        return t('account.stateGuest');
      case 'restoring-session':
        return t('account.stateRestoring');
      case 'starting-login':
      case 'waiting-for-scan':
      case 'waiting-for-confirmation':
        return t('account.stateAuthorizing');
      case 'authenticated':
        return t('account.stateAuthenticated');
      case 'expired':
      case 'rejected':
      case 'session-expired':
      case 'reauthentication-required':
        return t('account.stateAuthorizationRequired');
      case 'network-error':
        return t('account.stateOffline');
      case 'protocol-error':
      case 'secure-store-unavailable':
        return t('account.stateUnavailable');
    }
  })();
  const accountMessage = (() => {
    if (accountError) {
      switch (accountError) {
        case 'network':
          return t('account.networkMessage');
        case 'authorization':
          return t('account.reauthMessage');
        case 'secure-store':
          return t('account.secureStoreMessage');
        case 'protocol':
          return t('account.protocolMessage');
        case 'unknown':
          return t('account.unknownMessage');
      }
    }
    switch (accountSnapshot.state) {
      case 'guest':
      case 'cancelled':
        return provider.status ? t('account.guestMessage') : t('account.statusUnavailable');
      case 'restoring-session':
        return t('account.restoringMessage');
      case 'starting-login':
      case 'waiting-for-scan':
      case 'waiting-for-confirmation':
        return t('account.authorizingMessage');
      case 'authenticated':
        return t('account.authenticatedMessage');
      case 'expired':
        return t('account.expiredMessage');
      case 'rejected':
        return t('account.rejectedMessage');
      case 'network-error':
        return t('account.networkMessage');
      case 'protocol-error':
        return t('account.protocolMessage');
      case 'session-expired':
      case 'reauthentication-required':
        return t('account.reauthMessage');
      case 'secure-store-unavailable':
        return t('account.secureStoreMessage');
    }
  })();
  const accountTierLabel = accountEntitlement
    ? {
        free: t('account.tierFree'),
        'green-diamond': t('account.tierGreenDiamond'),
        'super-vip': t('account.tierSuperVip'),
        unknown: t('account.tierUnknown'),
      }[accountEntitlement.tier]
    : null;
  const accountMembershipLabel = accountEntitlement
    ? {
        active: t('account.membershipActive'),
        expired: t('account.membershipExpired'),
        inactive: t('account.membershipInactive'),
        unknown: t('account.membershipUnknown'),
      }[accountEntitlement.membership]
    : null;
  const accountSecondaryEntitlements = accountEntitlement
    ? (accountEntitlement.secondaryEntitlements ?? []).map((entitlement) =>
        t(`account.secondary.${entitlement}`),
      )
    : [];
  const accountExpiryLabel = (() => {
    if (!accountEntitlement) return null;
    if (accountEntitlement.expiresAtMs === null) return t('account.noExpiry');
    const expiry = new Date(accountEntitlement.expiresAtMs);
    return Number.isFinite(expiry.getTime())
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(expiry)
      : t('account.expiryUnknown');
  })();
  const accountNeedsReauthentication =
    accountSnapshot.state === 'session-expired' ||
    accountSnapshot.state === 'reauthentication-required';
  const rendererLabel = platform.diagnostics ? 'Electron / Chromium' : t('about.browserPreview');
  const aboutLinks: Array<{ id: ProductLink; label: string }> = [
    { id: 'repository', label: t('about.repository') },
    { id: 'releases', label: t('about.releases') },
    { id: 'documentation', label: t('about.documentation') },
    { id: 'acknowledgements', label: t('about.acknowledgements') },
    { id: 'thirdPartyNotices', label: t('about.thirdPartyNotices') },
  ];

  return (
    <section className="page standard-page settings-page">
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
      </header>

      <SettingsSection title={t('general.title')} description={t('general.description')}>
        <div className="settings-card">
          <SettingRow
            title={t('general.language')}
            description={t('general.languageDescription')}
            control={
              <Select
                value={preferences.locale}
                options={languageOptions}
                onChange={preferences.setLocale}
                ariaLabel={t('general.languageLabel')}
                icon={Globe2}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('appearance.title')}
        description={t('appearance.description')}
        action={
          <button
            type="button"
            className="button button--quiet"
            onClick={preferences.resetAppearance}
          >
            <RotateCcw size={14} /> {t('appearance.reset')}
          </button>
        }
      >
        <div className="settings-card">
          <SettingRow
            title={t('appearance.colorMode')}
            description={t('appearance.colorModeDescription')}
            control={
              <Select
                value={preferences.appearance.colorMode}
                options={modeOptions}
                onChange={(colorMode) => preferences.updateAppearance({ colorMode })}
                ariaLabel={t('appearance.colorMode')}
                icon={Sparkles}
              />
            }
          />
          <SettingRow
            title={t('appearance.interfaceFontScale')}
            description={t('appearance.interfaceFontScaleDescription')}
            control={
              <RangeControl
                value={preferences.appearance.interfaceFontScale}
                min={80}
                max={130}
                step={5}
                label={t('appearance.interfaceFontScale')}
                output={(value) => t('appearance.interfaceFontScaleValue', { value })}
                onPreview={(interfaceFontScale) => previewAppearance({ interfaceFontScale })}
                onChange={(interfaceFontScale) => {
                  finishAppearancePreview();
                  preferences.updateAppearance({ interfaceFontScale });
                }}
              />
            }
          />
          <SettingRow
            title={t('appearance.interfaceFontFamily')}
            description={t('appearance.interfaceFontFamilyDescription')}
            control={
              <Select
                value={preferences.appearance.interfaceFontFamily}
                options={interfaceFontOptions}
                onChange={(interfaceFontFamily) =>
                  preferences.updateAppearance({ interfaceFontFamily })
                }
                ariaLabel={t('appearance.interfaceFontFamily')}
                icon={Type}
              />
            }
          />
          <SettingRow
            title={t('appearance.palette')}
            description={t('appearance.paletteDescription')}
            control={
              <Select
                value={preferences.appearance.palette}
                options={paletteOptions}
                onChange={preferences.selectPalette}
                ariaLabel={t('appearance.palette')}
                icon={Palette}
              />
            }
          />
          <SettingRow
            title={t('appearance.primary')}
            description={t('appearance.primaryDescription')}
            control={
              <ColorControl
                name={t('appearance.primary')}
                value={preferences.appearance.primaryColor}
                fallback={defaultPreferences.appearance.primaryColor}
                onChange={(primaryColor) =>
                  preferences.updateAppearance({ primaryColor, palette: 'custom' })
                }
                previewPatch={(primaryColor) => ({ primaryColor, palette: 'custom' })}
              />
            }
          />
          <SettingRow
            title={t('appearance.secondary')}
            description={t('appearance.secondaryDescription')}
            control={
              <ColorControl
                name={t('appearance.secondary')}
                value={preferences.appearance.secondaryColor}
                fallback={defaultPreferences.appearance.secondaryColor}
                onChange={(secondaryColor) =>
                  preferences.updateAppearance({ secondaryColor, palette: 'custom' })
                }
                previewPatch={(secondaryColor) => ({ secondaryColor, palette: 'custom' })}
              />
            }
          />
          <div className="appearance-preview" aria-label={t('appearance.preview')}>
            <span className="appearance-preview__primary">
              <Check size={14} />
            </span>
            <span className="appearance-preview__copy">
              <strong>{t('appearance.previewTitle')}</strong>
              <small>{t('appearance.previewBody')}</small>
            </span>
            <button type="button">{common('play')}</button>
          </div>
          <SettingRow
            title={t('appearance.background')}
            description={t('appearance.backgroundDescription')}
            control={
              <Select
                value={preferences.appearance.backgroundMode}
                options={backgroundOptions}
                onChange={(backgroundMode) => preferences.updateAppearance({ backgroundMode })}
                ariaLabel={t('appearance.backgroundModeLabel')}
                icon={ImageIcon}
              />
            }
          />
          {preferences.appearance.backgroundMode === 'color' && (
            <SettingRow
              title={t('appearance.backgroundColor')}
              description={t('appearance.backgroundDescription')}
              control={
                <ColorControl
                  name={t('appearance.backgroundColor')}
                  value={preferences.appearance.backgroundColor}
                  fallback={defaultPreferences.appearance.backgroundColor}
                  onChange={(backgroundColor) => preferences.updateAppearance({ backgroundColor })}
                  previewPatch={(backgroundColor) => ({ backgroundColor })}
                />
              }
            />
          )}
          {preferences.appearance.backgroundMode === 'image' && (
            <SettingRow
              title={t('appearance.backgroundImage')}
              description={
                preferences.backgroundImageMissing
                  ? t('appearance.imageUnavailable')
                  : preferences.appearance.backgroundImageReference
                    ? t('appearance.imageReady')
                    : t('appearance.backgroundDescription')
              }
              control={
                <div className="settings-inline-control">
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => void chooseImage()}
                  >
                    <ImageIcon size={14} />
                    {preferences.appearance.backgroundImageReference
                      ? t('appearance.replaceImage')
                      : t('appearance.chooseImage')}
                  </button>
                  <Select
                    value={preferences.appearance.backgroundFit}
                    options={fitOptions}
                    onChange={(backgroundFit) => preferences.updateAppearance({ backgroundFit })}
                    ariaLabel={t('appearance.fit')}
                  />
                </div>
              }
            />
          )}
          {preferences.appearance.backgroundMode === 'image' && (
            <p className="settings-capability-note">{t('appearance.fitHint')}</p>
          )}
          {(preferences.appearance.backgroundMode === 'artwork' ||
            preferences.appearance.backgroundMode === 'image') && (
            <SettingRow
              title={t('appearance.artworkInfluence')}
              description={t('appearance.artworkInfluenceDescription')}
              control={
                <RangeControl
                  value={preferences.appearance.artworkInfluence}
                  min={0}
                  max={100}
                  label={t('appearance.artworkInfluence')}
                  output={(value) => `${value}%`}
                  onPreview={(artworkInfluence) => previewAppearance({ artworkInfluence })}
                  onChange={(artworkInfluence) => {
                    finishAppearancePreview();
                    preferences.updateAppearance({ artworkInfluence });
                  }}
                />
              }
            />
          )}
          <SettingRow
            title={t('appearance.interfaceOpacity')}
            description={t('appearance.interfaceOpacityDescription')}
            control={
              <RangeControl
                value={preferences.appearance.surfaceOpacity}
                min={85}
                max={100}
                label={t('appearance.interfaceOpacity')}
                output={(value) => `${value}%`}
                onPreview={(surfaceOpacity) => previewAppearance({ surfaceOpacity })}
                onChange={(surfaceOpacity) => {
                  finishAppearancePreview();
                  preferences.updateAppearance({ surfaceOpacity });
                }}
              />
            }
          />
          <SettingRow
            title={t('appearance.material')}
            description={t('appearance.materialDescription')}
            control={
              <Select
                value={preferences.appearance.material}
                options={materialOptions}
                onChange={(material) => preferences.updateAppearance({ material })}
                ariaLabel={t('appearance.material')}
                icon={SlidersHorizontal}
              />
            }
          />
        </div>
        {imageError && <p className="settings-error">{imageError}</p>}
      </SettingsSection>

      <SettingsSection title={t('lyrics.title')} description={t('lyrics.description')}>
        <div className="settings-card">
          <SettingRow
            className="settings-row--presets"
            title={t('lyricsPresets.title')}
            description={t('lyricsPresets.description')}
            control={<LyricsPresetPicker />}
          />
          <SettingRow
            title={t('lyrics.translation')}
            description={t('lyrics.translationDescription')}
            control={
              <Select
                value={preferences.lyrics.translation}
                options={lyricVisibilityOptions}
                onChange={(translation) => preferences.updateLyrics({ translation })}
                ariaLabel={t('lyrics.visibilityLabel', { name: t('lyrics.translation') })}
                icon={Languages}
              />
            }
          />
          <SettingRow
            title={t('lyrics.romanization')}
            description={t('lyrics.romanizationDescription')}
            control={
              <Select
                value={preferences.lyrics.romanization}
                options={lyricVisibilityOptions}
                onChange={(romanization) => preferences.updateLyrics({ romanization })}
                ariaLabel={t('lyrics.visibilityLabel', { name: t('lyrics.romanization') })}
                icon={Languages}
              />
            }
          />
          <SettingRow
            title={t('lyrics.wordJump')}
            description={t('lyrics.wordJumpDescription')}
            control={
              <Toggle
                checked={preferences.lyrics.wordEffect === 'jump'}
                onChange={(enabled) =>
                  preferences.updateLyrics({ wordEffect: enabled ? 'jump' : 'fill' })
                }
                label={t('lyrics.wordJump')}
              />
            }
          />
          <SettingRow
            title={t('lyrics.fontSize')}
            description={t('lyrics.fontSizeDescription')}
            control={
              <RangeControl
                value={selectedLyricsPreset.typography.fontScale}
                min={FONT_SCALE_MIN}
                max={FONT_SCALE_MAX}
                step={0.01}
                label={t('lyrics.fontSize')}
                output={(value) => t('lyrics.fontSizeValue', { value: Math.round(value * 100) })}
                onChange={(fontScale) => updateSelectedLyricsTypography({ fontScale })}
              />
            }
          />
          <SettingRow
            title={t('lyrics.lineSpacing')}
            description={t('lyrics.lineSpacingDescription')}
            control={
              <RangeControl
                value={selectedLyricsPreset.typography.lineHeight}
                min={LINE_HEIGHT_MIN}
                max={LINE_HEIGHT_MAX}
                step={0.01}
                label={t('lyrics.lineSpacing')}
                output={(value) => t('lyrics.lineSpacingValue', { value: value.toFixed(2) })}
                onChange={(lineHeight) => updateSelectedLyricsTypography({ lineHeight })}
              />
            }
          />
          <SettingRow
            title={t('lyrics.fontWeight')}
            description={t('lyrics.fontWeightDescription')}
            control={
              <Select
                value={preferences.lyrics.fontWeight}
                options={lyricFontWeightOptions}
                onChange={(fontWeight) => preferences.updateLyrics({ fontWeight })}
                ariaLabel={t('lyrics.fontWeight')}
                icon={Type}
              />
            }
          />
          <SettingRow
            title={t('lyrics.amllSpring')}
            description={t('lyrics.amllSpringDescription')}
            control={
              <Toggle
                checked={preferences.amll.enableSpring}
                onChange={(enableSpring) => preferences.updateAmll({ enableSpring })}
                label={t('lyrics.amllSpring')}
              />
            }
          />
          <SettingRow
            title={t('lyrics.amllScale')}
            description={t('lyrics.amllScaleDescription')}
            control={
              <Toggle
                checked={preferences.amll.enableScale}
                onChange={(enableScale) => preferences.updateAmll({ enableScale })}
                label={t('lyrics.amllScale')}
              />
            }
          />
          <SettingRow
            title={t('lyrics.amllBlur')}
            description={t('lyrics.amllBlurDescription')}
            control={
              <Toggle
                checked={preferences.amll.enableBlur}
                onChange={(enableBlur) => preferences.updateAmll({ enableBlur })}
                label={t('lyrics.amllBlur')}
              />
            }
          />
          <SettingRow
            title={t('lyrics.amllHidePassedLines')}
            description={t('lyrics.amllHidePassedLinesDescription')}
            control={
              <Toggle
                checked={preferences.amll.hidePassedLines}
                onChange={(hidePassedLines) => preferences.updateAmll({ hidePassedLines })}
                label={t('lyrics.amllHidePassedLines')}
              />
            }
          />
          <SettingRow
            title={t('lyrics.amllWordFadeWidth')}
            description={t('lyrics.amllWordFadeWidthDescription')}
            control={
              <RangeControl
                value={preferences.amll.wordFadeWidth}
                min={0.05}
                max={1}
                step={0.05}
                label={t('lyrics.amllWordFadeWidth')}
                output={(value) => t('lyrics.amllWordFadeWidthValue', { value: value.toFixed(2) })}
                onChange={(wordFadeWidth) => preferences.updateAmll({ wordFadeWidth })}
              />
            }
          />
          <SettingRow
            title={t('lyrics.timing')}
            description={t('lyrics.timingDescription')}
            control={
              <RangeControl
                value={preferences.lyrics.timingOffsetMs}
                min={-2_000}
                max={2_000}
                step={50}
                label={t('lyrics.timing')}
                output={(value) => t('lyrics.timingValue', { value })}
                onChange={(timingOffsetMs) => preferences.updateLyrics({ timingOffsetMs })}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('surfaces.title')}
        description={t('surfaces.description')}
        action={
          lockedSurfaceKinds.length > 0 ? (
            <button
              type="button"
              className="button button--secondary"
              disabled={unlockingAll}
              onClick={() => void unlockAllSurfaces()}
            >
              <Unlock size={14} />
              {unlockingAll ? t('surfaces.unlockingAll') : t('surfaces.unlockAll')}
            </button>
          ) : undefined
        }
      >
        <SurfaceCapabilityBanner
          capabilities={surfaceCapabilitiesFromDiagnostics(platform.diagnostics) ?? capabilities}
        />
        <div className="settings-card settings-card--surfaces">
          <SurfaceSettingsPanel
            kind="desktop"
            supported={capabilities?.desktop ?? isNativeRuntime}
          />
          <SurfaceSettingsPanel kind="island" supported={capabilities?.island ?? isNativeRuntime} />
        </div>
      </SettingsSection>

      <SettingsSection title={t('playback.title')} description={t('playback.description')}>
        <div className="settings-card">
          <SettingRow
            title={t('playback.audioOutput')}
            description={
              resolvedOutput
                ? `${t('playback.audioOutputDescription')} ${t('playback.resolvedOutput', {
                    device: resolvedOutput.name,
                    rate: resolvedOutput.sampleRate,
                    channels: resolvedOutput.channels,
                  })}`
                : t('playback.audioOutputDescription')
            }
            control={
              <Select
                value={selectedOutput}
                options={outputOptions}
                onChange={(deviceId) => void provider.setOutputDevice(deviceId)}
                ariaLabel={t('playback.outputLabel')}
                icon={Headphones}
                disabled={!provider.available || provider.busy || provider.devices.length === 0}
              />
            }
          />
          <SettingRow
            title={t('playback.quality')}
            description={t('playback.qualityDescription')}
            control={
              <Select
                value={provider.status?.preferredQuality ?? 'automatic'}
                options={qualityOptions}
                onChange={(quality) => void provider.setQuality(quality)}
                ariaLabel={t('playback.qualityLabel')}
                icon={Music2}
                disabled={!provider.available || provider.busy}
              />
            }
          />
          <SettingRow
            title={t('playback.observedQuality')}
            description={t('playback.observedQualityDescription')}
            control={
              <output aria-label={t('playback.observedQualityLabel')}>
                {qualityLabel(observedMaximumQuality)}
              </output>
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('systemIntegration.title')}
        description={t('systemIntegration.description')}
      >
        <div className="settings-card">
          <SettingRow
            title={t('systemIntegration.closeBehavior')}
            description={t('systemIntegration.closeBehaviorDescription')}
            control={
              <Select
                value={preferences.system.closeBehavior}
                options={closeBehaviorOptions}
                onChange={(closeBehavior) => preferences.updateSystem({ closeBehavior })}
                ariaLabel={t('systemIntegration.closeBehavior')}
                icon={Monitor}
                disabled={!isNativeRuntime}
              />
            }
          />
          <SettingRow
            title={t('systemIntegration.globalShortcuts')}
            description={
              platform.diagnostics?.desktopIntegration.globalShortcutsSupported === false
                ? t('systemIntegration.shortcutsUnsupported')
                : t('systemIntegration.shortcutsDescription')
            }
            control={
              <Toggle
                checked={preferences.system.globalShortcutsEnabled}
                label={t('systemIntegration.globalShortcuts')}
                disabled={
                  !isNativeRuntime ||
                  platform.busy ||
                  (platform.diagnostics?.desktopIntegration.globalShortcutsSupported === false &&
                    !preferences.system.globalShortcutsEnabled)
                }
                onChange={(enabled) => void changeGlobalShortcuts(enabled)}
              />
            }
          />
          <SettingRow
            title={t('systemIntegration.platformBackend')}
            description={t('systemIntegration.platformBackendDescription')}
            control={
              <span className="settings-runtime-value">
                <Keyboard size={14} />
                {platform.diagnostics
                  ? [
                      platform.diagnostics.linux?.displayBackend ?? platform.diagnostics.os,
                      platform.diagnostics.systemMedia.specification,
                      platform.diagnostics.desktopIntegration.trayAvailable
                        ? t('systemIntegration.trayReady')
                        : t('systemIntegration.trayUnavailable'),
                    ].join(' · ')
                  : t('systemIntegration.detecting')}
              </span>
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('plugins.title')} description={t('plugins.description')}>
        <div className="settings-card">
          <PluginManager />
        </div>
      </SettingsSection>

      <SettingsSection title={t('diagnostics.title')} description={t('diagnostics.description')}>
        <div className="settings-card">
          <SettingRow
            title={t('diagnostics.logLevel')}
            description={t('diagnostics.logLevelDescription')}
            control={
              <Select<LogLevel>
                value={logLevel === 'error' || logLevel === 'warn' ? 'info' : logLevel}
                options={[
                  { value: 'info', label: t('diagnostics.logLevelInfo') },
                  { value: 'debug', label: t('diagnostics.logLevelDebug') },
                  { value: 'trace', label: t('diagnostics.logLevelTrace') },
                ]}
                onChange={(value) => void changeLogLevel(value)}
                disabled={!isNativeRuntime || diagnosticsBusy}
                ariaLabel={t('diagnostics.logLevel')}
              />
            }
          />
          {packagedConsoleForward ? (
            <SettingRow
              title={t('diagnostics.consoleForward')}
              description={t('diagnostics.consoleForwardDescription')}
              control={
                <Select<ConsoleForwardMode>
                  value={consoleForward}
                  options={[
                    { value: 'error', label: t('diagnostics.consoleForwardError') },
                    { value: 'warn', label: t('diagnostics.consoleForwardWarn') },
                    { value: 'off', label: t('diagnostics.consoleForwardOff') },
                  ]}
                  onChange={(value) => void changeConsoleForward(value)}
                  disabled={!isNativeRuntime || diagnosticsBusy}
                  ariaLabel={t('diagnostics.consoleForward')}
                />
              }
            />
          ) : null}
          <SettingRow
            title={t('diagnostics.openFolder')}
            description={t('diagnostics.openFolderDescription')}
            control={
              <button
                type="button"
                className="button button--secondary"
                disabled={!isNativeRuntime || diagnosticsBusy}
                onClick={() => void handleOpenLogFolder()}
              >
                <Folder size={14} /> {t('diagnostics.openFolderAction')}
              </button>
            }
          />
          <SettingRow
            title={t('diagnostics.exportBundle')}
            description={t('diagnostics.exportBundleDescription')}
            control={
              <div className="settings-inline-actions">
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={!isNativeRuntime || diagnosticsBusy}
                  onClick={() => void handleExportBundle()}
                >
                  <FileText size={14} /> {t('diagnostics.exportBundleAction')}
                </button>
                {lastBundle && (
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={diagnosticsBusy}
                    onClick={() => void handleRevealBundle()}
                  >
                    <Folder size={14} /> {t('issueReporter.revealBundle')}
                  </button>
                )}
              </div>
            }
          />
          <SettingRow
            title={t('diagnostics.clearLogs')}
            description={t('diagnostics.clearLogsDescription')}
            control={
              <button
                type="button"
                className="button button--quiet"
                disabled={!isNativeRuntime || diagnosticsBusy}
                onClick={() => void handleClearLogs()}
              >
                <Trash2 size={14} /> {t('diagnostics.clearLogsAction')}
              </button>
            }
          />
          <SettingRow
            title={t('diagnostics.reportProblem')}
            description={t('diagnostics.reportProblemDescription')}
            control={
              <button
                type="button"
                className="button button--primary"
                onClick={() => setIssueReporterOpen(true)}
              >
                <Bug size={14} /> {t('diagnostics.reportProblemAction')}
              </button>
            }
          />
          {uiDiagnostics && (
            <SettingRow
              title={t('debug.fpsCounter')}
              description={t('debug.fpsCounterDescription')}
              control={
                <Toggle
                  checked={preferences.debug.showFpsCounter}
                  label={t('debug.fpsCounter')}
                  onChange={(showFpsCounter) => preferences.updateDebug({ showFpsCounter })}
                />
              }
            />
          )}
          <SettingRow
            title={t('diagnostics.platformExport')}
            description={t('diagnostics.platformExportDescription')}
            control={
              <button
                type="button"
                className="button button--secondary"
                disabled={!platform.available || platform.busy}
                onClick={() => void platform.exportDiagnostics()}
              >
                <Download size={14} /> {t('diagnostics.platformExportAction')}
              </button>
            }
          />
        </div>
        {platform.exportPath && (
          <p className="settings-export-path">
            {t('systemIntegration.exported', { path: platform.exportPath })}
          </p>
        )}
        {platform.error && (
          <p className="settings-error" title={platform.error}>
            {errors('settingsFailed')}
          </p>
        )}
        {diagnosticsMessage && !diagnosticsError && (
          <p className="settings-export-path" role="status">
            {diagnosticsMessage}
          </p>
        )}
        {diagnosticsError && (
          <p className="settings-error" title={diagnosticsError} role="alert">
            {diagnosticsError}
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('account.title')}
        description={t('account.description')}
        action={
          connectionLabel && (
            <span className="api-status" data-state={provider.status?.connection}>
              <i /> {connectionLabel}
            </span>
          )
        }
      >
        <div className="settings-card">
          <div className="settings-account-profile">
            {accountAvatarUrl ? (
              <img
                className="settings-account-profile__avatar"
                src={accountAvatarUrl}
                alt={t('account.avatarAlt', { nickname: accountProfile?.nickname ?? '' })}
              />
            ) : (
              <span className="settings-provider-mark" aria-hidden="true">
                <ShieldCheck size={16} />
              </span>
            )}
            <div className="settings-account-profile__identity">
              <strong>{accountProfile?.nickname ?? t('account.guest')}</strong>
              <span>{accountProfile?.maskedIdentity ?? accountStateLabel}</span>
            </div>
            {accountProvider ? (
              accountSnapshot.state === 'authenticated' ? (
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={accountBusy}
                  onClick={() => void signOut(accountProvider)}
                >
                  <LogOut size={14} />
                  {accountBusy ? t('account.signingOut') : t('account.signOut')}
                </button>
              ) : (
                <button
                  type="button"
                  className="button button--primary"
                  disabled={accountBusy}
                  onClick={openAccountDialog}
                >
                  <LogIn size={14} />
                  {accountNeedsReauthentication ? t('account.reauthenticate') : t('account.signIn')}
                </button>
              )
            ) : null}
          </div>
          <p className="settings-account-message">{accountMessage}</p>
          <dl className="settings-account-metadata">
            <div>
              <dt>{t('account.state')}</dt>
              <dd>{accountStateLabel}</dd>
            </div>
            {accountEntitlement && (
              <>
                <div>
                  <dt>{t('account.tier')}</dt>
                  <dd>{accountTierLabel}</dd>
                </div>
                <div>
                  <dt>{t('account.membership')}</dt>
                  <dd>{accountMembershipLabel}</dd>
                </div>
                <div>
                  <dt>{t('account.expires')}</dt>
                  <dd>{accountExpiryLabel}</dd>
                </div>
                {accountSecondaryEntitlements.length > 0 && (
                  <div>
                    <dt>{t('account.secondaryEntitlements')}</dt>
                    <dd>{accountSecondaryEntitlements.join(' · ')}</dd>
                  </div>
                )}
              </>
            )}
          </dl>
          <div className="settings-security-note">
            <ShieldCheck size={17} />
            <p>{t('account.security')}</p>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t('storage.title')} description={t('storage.description')}>
        <div className="settings-card">
          <SettingRow
            title={t('storage.usage')}
            description={
              provider.cache
                ? t('storage.summary', {
                    size: formatBytes(provider.cache.totalBytes, locale),
                    files: number.format(
                      provider.cache.mediaEntries + provider.cache.artworkEntries,
                    ),
                    metadata: number.format(provider.cache.metadataEntries),
                    lyrics: number.format(provider.cache.lyricEntries),
                  })
                : t('storage.unavailable')
            }
            control={
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void provider.clearCache()}
                disabled={!provider.available || provider.busy}
              >
                <Database size={14} /> {t('storage.clear')}
              </button>
            }
          />
        </div>
        {provider.error && (
          <p className="settings-error" title={provider.error}>
            {errors('settingsFailed')}
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('api.title')}
        description={t('api.description')}
        action={
          api.status && (
            <span className="api-status" data-state={api.status.state}>
              <i />
              {api.status.state === 'running'
                ? t('api.statusRunning')
                : api.status.state === 'starting'
                  ? t('api.statusStarting')
                  : api.status.state === 'error'
                    ? t('api.statusError')
                    : t('api.statusDisabled')}
            </span>
          )
        }
      >
        {!api.available ? (
          <div className="settings-notice">
            <Server size={20} />
            <div>
              <strong>{t('api.desktopRequired')}</strong>
              <p>{t('api.browserUnavailable')}</p>
            </div>
          </div>
        ) : (
          <div className="settings-card">
            <SettingRow
              title={t('api.enable')}
              description={t('api.enableDescription')}
              control={
                <Toggle
                  checked={api.status?.enabled ?? false}
                  label={t('api.enableLabel')}
                  disabled={api.busy || !api.status}
                  onChange={(enabled) => void api.setEnabled(enabled)}
                />
              }
            />
            <SettingRow
              title={t('api.endpoint')}
              description={
                api.status?.state === 'running'
                  ? t('api.listening', {
                      endpoint: `http://${api.status.host}:${api.status.boundPort}`,
                    })
                  : t('api.notListening')
              }
              control={
                <form className="port-form" onSubmit={submitPort}>
                  <span>127.0.0.1:</span>
                  <input
                    key={api.status?.configuredPort ?? 19_532}
                    name="port"
                    type="number"
                    min={1_024}
                    max={65_535}
                    defaultValue={api.status?.configuredPort ?? 19_532}
                    disabled={api.busy || !api.status}
                    aria-label={t('api.portLabel')}
                  />
                  <button className="button button--secondary" type="submit" disabled={api.busy}>
                    {common('apply')}
                  </button>
                  <button
                    type="button"
                    className="settings-icon-button"
                    onClick={() => void copyEndpoint()}
                    aria-label={t('api.copyAddress')}
                  >
                    <Copy size={16} />
                  </button>
                  <span className="port-form__copied" aria-live="polite">
                    {copied === 'endpoint' ? common('copied') : ''}
                  </span>
                </form>
              }
            />
            <div className="settings-row settings-row--token">
              <div>
                <strong>{t('api.token')}</strong>
                <span>{t('api.tokenDescription')}</span>
              </div>
              <form className="token-control" onSubmit={submitToken}>
                <input
                  type={tokenVisible ? 'text' : 'password'}
                  value={visibleTokenDraft}
                  onChange={(event) => {
                    setTokenTouched(true);
                    setTokenDraft(event.target.value);
                  }}
                  placeholder={t('api.token')}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={api.busy}
                  aria-label={t('api.token')}
                />
                {api.status?.tokenConfigured && (
                  <button
                    type="button"
                    className="settings-icon-button"
                    onClick={() => setTokenVisible((visible) => !visible)}
                    disabled={api.busy}
                    aria-label={tokenVisible ? t('api.hideToken') : t('api.revealToken')}
                  >
                    {tokenVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                )}
                <button
                  type="button"
                  className="settings-icon-button"
                  onClick={() => void copyToken()}
                  disabled={api.busy || !visibleTokenDraft}
                  aria-label={t('api.copyToken')}
                >
                  <Copy size={16} />
                </button>
                <span className="token-control__copied" aria-live="polite">
                  {copied === 'token' ? common('copied') : ''}
                </span>
              </form>
              <div className="token-actions">
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => void saveToken()}
                  disabled={api.busy || (!tokenTouched && api.status?.tokenConfigured)}
                >
                  {t('api.saveToken')}
                </button>
                <button
                  type="button"
                  className="button button--quiet token-regenerate"
                  onClick={regenerate}
                  disabled={api.busy}
                >
                  <RotateCcw size={14} /> {t('api.regenerate')}
                </button>
              </div>
            </div>
            {!api.status?.tokenConfigured && (
              <p className="settings-token-recommendation">{t('api.tokenRecommendation')}</p>
            )}
            <div className="settings-security-note">
              <ShieldCheck size={17} />
              <p>{t('api.security')}</p>
            </div>
          </div>
        )}
        {api.error && (
          <p className="settings-error" title={api.error}>
            {errors('settingsFailed')}
          </p>
        )}
        {api.available && (
          <button
            type="button"
            className="settings-refresh"
            onClick={() => void api.refresh()}
            disabled={api.busy}
          >
            <RefreshCw size={13} /> {t('api.refresh')}
          </button>
        )}
      </SettingsSection>

      <SettingsUpdateSection />

      <SettingsSection title={t('about.title')} description={t('about.description')}>
        <div className="settings-about">
          <div className="settings-about__identity">
            <span className="settings-about__logo" aria-hidden="true" />
            <div>
              <strong>{productMetadata.name}</strong>
              <span>{productMetadata.longName}</span>
              <small>
                {t('about.version', { version: productMetadata.version })} · {buildMetadata.channel}{' '}
                · {buildMetadata.type}
              </small>
              <p className="settings-about__disclaimer">{t('about.unofficial')}</p>
            </div>
          </div>
          <dl className="settings-about__runtime">
            <div>
              <dt>{t('about.commit')}</dt>
              <dd>{buildMetadata.commit}</dd>
            </div>
            <div>
              <dt>{t('about.platform')}</dt>
              <dd>
                {platform.diagnostics
                  ? `${platform.diagnostics.os} / ${platform.diagnostics.architecture}`
                  : t('about.browserPreview')}
              </dd>
            </div>
            <div>
              <dt>{t('about.renderer')}</dt>
              <dd>{rendererLabel}</dd>
            </div>
            <div>
              <dt>{t('about.audioBackend')}</dt>
              <dd>{platform.diagnostics?.audio.implementation ?? common('unavailable')}</dd>
            </div>
          </dl>
          <div className="settings-about__links" aria-label={t('about.links')}>
            {aboutLinks.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className="button button--quiet"
                onClick={() => void openProductLink(id)}
              >
                {label} <ExternalLink size={13} />
              </button>
            ))}
          </div>
        </div>
      </SettingsSection>

      <IssueReporterDialog
        open={issueReporterOpen}
        onClose={() => setIssueReporterOpen(false)}
        diagnosticsRequest={{
          accountState: accountSnapshot.state,
          lyricsPreset: lyricsPresetDiagnostics(preferences.lyricsPresets),
        }}
      />
    </section>
  );
}

function formatBytes(value: number, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (value < 1_024) return `${formatter.format(value)} B`;
  if (value < 1_048_576) return `${formatter.format(value / 1_024)} KiB`;
  return `${formatter.format(value / 1_048_576)} MiB`;
}
