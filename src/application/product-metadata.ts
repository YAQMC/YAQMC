import packageMetadata from '../../package.json';
import type { PlatformDiagnostics } from './platform-integration';
import type { ProviderStatus } from './provider-settings';

export const productMetadata = {
  name: 'YAQMC',
  longName: 'Yet Another QMusicClient',
  version: packageMetadata.version,
  repository: 'https://github.com/YAQMC/YAQMC',
  links: {
    repository: 'https://github.com/YAQMC/YAQMC',
    releases: 'https://github.com/YAQMC/YAQMC/releases',
    issues: 'https://github.com/YAQMC/YAQMC/issues/new/choose',
    documentation: 'https://github.com/YAQMC/YAQMC/tree/main/docs',
    acknowledgements: 'https://github.com/YAQMC/YAQMC/blob/main/ACKNOWLEDGEMENTS.md',
    thirdPartyNotices: 'https://github.com/YAQMC/YAQMC/blob/main/THIRD_PARTY_NOTICES.md',
  },
} as const;

export type ProductLink = keyof typeof productMetadata.links;

const embeddedCommit = __YAQMC_BUILD_COMMIT__.toLowerCase();

export const buildMetadata = {
  commit: /^[0-9a-f]{7,40}$/u.test(embeddedCommit) ? embeddedCommit.slice(0, 12) : 'unknown',
  channel: __YAQMC_RELEASE_CHANNEL__,
  type: __YAQMC_BUILD_TYPE__,
} as const;

export interface SafeDiagnosticInput {
  platform: PlatformDiagnostics | null;
  provider: ProviderStatus | null;
  accountState: string;
}

function rendererFor(platform: PlatformDiagnostics | null): string {
  if (!platform) return 'browser preview';
  if (platform.os === 'windows') return 'WebView2 / Tauri';
  if (platform.os === 'linux') {
    return platform.linux?.webkitgtkVersion
      ? `WebKitGTK ${platform.linux.webkitgtkVersion} / Tauri`
      : 'WebKitGTK / Tauri';
  }
  if (platform.os === 'macos') return 'WKWebView / Tauri';
  return 'Tauri WebView';
}

export function formatSafeDiagnostics({
  platform,
  provider,
  accountState,
}: SafeDiagnosticInput): string {
  const version = platform?.appVersion ?? productMetadata.version;
  const os = platform?.os ?? 'browser';
  const architecture = platform?.architecture ?? 'unknown';
  const audioBackend = platform?.audio.implementation ?? 'unavailable';
  const outputSelection = platform?.audio.selectedOutputKind ?? 'unavailable';
  const resolvedAudioHost = platform?.audio.resolvedHost ?? 'unavailable';
  const providerMode = provider
    ? `${provider.providerId} / ${provider.connection} / ${accountState}`
    : `unavailable / ${accountState}`;

  return [
    `YAQMC version: ${version}`,
    `Commit: ${buildMetadata.commit}`,
    `Channel: ${buildMetadata.channel}`,
    `Build: ${buildMetadata.type}`,
    `OS: ${os}`,
    `Architecture: ${architecture}`,
    `Renderer: ${rendererFor(platform)}`,
    `Audio backend: ${audioBackend}`,
    `Output selection: ${outputSelection}`,
    `Resolved audio host: ${resolvedAudioHost}`,
    `QQ provider mode: ${providerMode}`,
  ].join('\n');
}
