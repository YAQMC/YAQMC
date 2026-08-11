import { invoke } from '@tauri-apps/api/core';
import {
  Check,
  Copy,
  Database,
  Eye,
  EyeOff,
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
  Type,
  Unlock,
  Download,
} from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
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
  pickManagedBackgroundImage,
  usePreferencesStore,
  validatedColorPatch,
  type LyricSurfaceSettings,
  type SecondaryLyricVisibility,
  type SurfaceKind,
} from '../application/preferences';
import { isNativeRuntime } from '../application/native-player-runtime';
import { useProviderSettings } from '../application/provider-settings';
import { usePlatformIntegration } from '../application/platform-integration';
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
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  output: string;
  onChange: (value: number) => void;
}) {
  const progress = ((value - min) / Math.max(1, max - min)) * 100;
  return (
    <label className="settings-range">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ '--range-progress': `${progress}%` } as CSSProperties}
      />
      <output>{output}</output>
    </label>
  );
}

function ColorControl({
  name,
  value,
  fallback,
  onChange,
}: {
  name: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings', { keyPrefix: 'appearance' });
  const { t: common } = useTranslation('common');
  const [draftState, setDraftState] = useState({ source: value, draft: value });
  const draft = draftState.source === value ? draftState.draft : value;
  const valid = validatedColorPatch(draft, fallback);

  const updateDraft = (next: string) => {
    setDraftState({ source: value, draft: next });
    const normalized = validatedColorPatch(next, fallback);
    if (normalized) onChange(normalized);
  };

  return (
    <div className="color-control" data-invalid={!valid || undefined}>
      <label className="color-control__picker" title={t('pickerLabel', { name })}>
        <span style={{ background: value }} />
        <input
          type="color"
          value={value}
          aria-label={t('pickerLabel', { name })}
          onChange={(event) => updateDraft(event.target.value)}
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
          onChange={(event) => updateDraft(`#${event.target.value}`)}
        />
      </label>
      <button
        type="button"
        className="settings-icon-button"
        aria-label={`${common('reset')} ${name}`}
        onClick={() => onChange(fallback)}
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
      url.hostname === 'qpic.y.qq.com' &&
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
                output={t('fontSizeValue', { value: settings.fontSize })}
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
                output={`${settings.backgroundOpacity}%`}
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
                      output={`${settings.horizontalPosition}`}
                      onChange={(horizontalPosition) => update({ horizontalPosition })}
                    />
                    <RangeControl
                      value={settings.verticalOffset}
                      min={0}
                      max={160}
                      label={t('offsetY')}
                      output={`${settings.verticalOffset}px`}
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
  const [copied, setCopied] = useState<'endpoint' | 'token' | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<SurfaceCapabilities | null>(null);
  const [unlockingAll, setUnlockingAll] = useState(false);

  useEffect(() => {
    if (!isNativeRuntime) return;
    void invoke<SurfaceCapabilities>('lyrics_surface_capabilities')
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
  }, []);

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
  const qualityOptions: readonly SelectOption<AudioQualityPreference>[] = [
    { value: 'automatic', label: t('playback.qualityAutomatic') },
    { value: 'standard', label: t('playback.qualityStandard') },
    { value: 'high', label: t('playback.qualityHigh') },
    { value: 'lossless', label: t('playback.qualityLossless') },
  ];
  const closeBehaviorOptions: readonly SelectOption<typeof preferences.system.closeBehavior>[] = [
    { value: 'hide-to-tray', label: t('systemIntegration.closeToTray') },
    { value: 'quit', label: t('systemIntegration.closeToQuit') },
  ];
  const selectedOutput =
    provider.devices.find((device) => device.isSelected)?.id ?? 'system:default';
  const outputOptions = useMemo(
    () =>
      provider.devices.length > 0
        ? provider.devices.map((device) => ({ value: device.id, label: device.label }))
        : [{ value: 'system:default', label: t('playback.systemOutput') }],
    [provider.devices, t],
  );
  const observedMaximumQuality =
    accountSnapshot.state === 'authenticated'
      ? accountSnapshot.entitlement.observedMaximumQuality
      : null;
  const qualityLabel = (quality: AudioQuality | null): string => {
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
  const copyToken = async () => {
    if (!api.token) return;
    await navigator.clipboard.writeText(api.token);
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
    } catch {
      setImageError(errors('imageFailed'));
    }
  };
  const regenerate = () => {
    if (window.confirm(t('api.regenerateConfirm'))) void api.regenerateToken();
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
        'music-vip': t('account.tierMusicVip'),
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
                  output={`${preferences.appearance.artworkInfluence}%`}
                  onChange={(artworkInfluence) =>
                    preferences.updateAppearance({ artworkInfluence })
                  }
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
                output={`${preferences.appearance.surfaceOpacity}%`}
                onChange={(surfaceOpacity) => preferences.updateAppearance({ surfaceOpacity })}
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
            title={t('lyrics.timing')}
            description={t('lyrics.timingDescription')}
            control={
              <RangeControl
                value={preferences.lyrics.timingOffsetMs}
                min={-2_000}
                max={2_000}
                step={50}
                label={t('lyrics.timing')}
                output={t('lyrics.timingValue', { value: preferences.lyrics.timingOffsetMs })}
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
        {capabilities?.limitations.map((limitation) => (
          <p className="settings-capability-note" key={limitation}>
            {limitation}
          </p>
        ))}
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
            description={t('playback.audioOutputDescription')}
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
          <SettingRow
            title={t('systemIntegration.diagnostics')}
            description={t('systemIntegration.diagnosticsDescription')}
            control={
              <button
                type="button"
                className="button button--secondary"
                disabled={!platform.available || platform.busy}
                onClick={() => void platform.exportDiagnostics()}
              >
                <Download size={14} /> {t('systemIntegration.export')}
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
                    disabled={api.busy || !api.status?.tokenConfigured}
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
              <div className="token-control">
                <code>{api.token ?? '••••••••••••••••••••••••••••••••'}</code>
                <button
                  type="button"
                  className="settings-icon-button"
                  onClick={() => void (api.token ? api.hideToken() : api.revealToken())}
                  disabled={api.busy}
                  aria-label={api.token ? t('api.hideToken') : t('api.revealToken')}
                >
                  {api.token ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
                <button
                  type="button"
                  className="settings-icon-button"
                  onClick={() => void copyToken()}
                  disabled={!api.token}
                  aria-label={t('api.copyToken')}
                >
                  <Copy size={16} />
                </button>
                <span className="token-control__copied" aria-live="polite">
                  {copied === 'token' ? common('copied') : ''}
                </span>
              </div>
              <button
                type="button"
                className="button button--quiet token-regenerate"
                onClick={regenerate}
                disabled={api.busy}
              >
                <RotateCcw size={14} /> {t('api.regenerate')}
              </button>
            </div>
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
    </section>
  );
}

function formatBytes(value: number, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (value < 1_024) return `${formatter.format(value)} B`;
  if (value < 1_048_576) return `${formatter.format(value / 1_024)} KiB`;
  return `${formatter.format(value / 1_048_576)} MiB`;
}
