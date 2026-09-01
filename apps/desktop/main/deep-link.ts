export const YAQMC_DEEP_LINK_SCHEME = 'yaqmc';

const MAX_URI_BYTES = 2_048;
const MAX_ENTITY_ID_BYTES = 256;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const INVALID_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/iu;

export interface CatalogSongDeepLink {
  providerId: string;
  entityId: string;
}

export interface ProtocolClientApp {
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
  isDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
}

export interface DeepLinkRegistrationStatus {
  supported: boolean;
  registered: boolean;
  error: string | null;
}

export class DeepLinkInbox {
  #pending: CatalogSongDeepLink | null;

  constructor(initial: CatalogSongDeepLink | null = null) {
    this.#pending = initial;
  }

  offer(target: CatalogSongDeepLink): void {
    this.#pending = target;
  }

  take(enabled: boolean): CatalogSongDeepLink | null {
    const target = this.#pending;
    this.#pending = null;
    return enabled ? target : null;
  }
}

export function parseYaqmcDeepLink(value: string): CatalogSongDeepLink | null {
  if (
    !value ||
    hasControlCharacters(value) ||
    INVALID_PERCENT_ESCAPE.test(value) ||
    byteLength(value) > MAX_URI_BYTES
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== `${YAQMC_DEEP_LINK_SCHEME}:` ||
    url.hostname !== 'catalog' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }

  const pathSegments = url.pathname.split('/');
  if (pathSegments.length !== 3 || pathSegments[0] !== '' || pathSegments[2] !== 'song') {
    return null;
  }
  const providerId = pathSegments[1] ?? '';
  if (!PROVIDER_ID_PATTERN.test(providerId)) return null;

  const queryEntries = [...url.searchParams.entries()];
  if (queryEntries.length !== 1 || queryEntries[0]?.[0] !== 'id') return null;
  const entityId = queryEntries[0][1];
  if (
    !entityId ||
    entityId !== entityId.trim() ||
    hasControlCharacters(entityId) ||
    byteLength(entityId) > MAX_ENTITY_ID_BYTES
  ) {
    return null;
  }

  return { providerId, entityId };
}

export function deepLinkFromArgv(argv: readonly string[]): CatalogSongDeepLink | null {
  const candidates = argv.filter((argument) =>
    argument.toLowerCase().startsWith(`${YAQMC_DEEP_LINK_SCHEME}:`),
  );
  if (candidates.length !== 1) return null;
  return parseYaqmcDeepLink(candidates[0]!);
}

export function registerYaqmcDeepLinkProtocol(
  electronApp: ProtocolClientApp,
  options: { packaged: boolean } = { packaged: true },
): DeepLinkRegistrationStatus {
  if (!options.packaged) {
    return { supported: false, registered: false, error: null };
  }
  try {
    const accepted = electronApp.setAsDefaultProtocolClient(YAQMC_DEEP_LINK_SCHEME);
    const registered = electronApp.isDefaultProtocolClient(YAQMC_DEEP_LINK_SCHEME);
    return {
      supported: true,
      registered,
      error: accepted || registered ? null : 'The operating system rejected protocol registration.',
    };
  } catch (error) {
    return {
      supported: true,
      registered: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function deepLinksEnabledFromPreferences(raw: unknown): boolean {
  const document = preferencesDocument(raw);
  const system = document?.system;
  if (!system || typeof system !== 'object') return true;
  const enabled = (system as { deepLinksEnabled?: unknown }).deepLinksEnabled;
  return typeof enabled === 'boolean' ? enabled : true;
}

export function clipboardDeepLinksEnabledFromPreferences(raw: unknown): boolean {
  const document = preferencesDocument(raw);
  const system = document?.system;
  if (!system || typeof system !== 'object') return false;
  const enabled = (system as { clipboardDeepLinksEnabled?: unknown }).clipboardDeepLinksEnabled;
  return typeof enabled === 'boolean' ? enabled : false;
}

function preferencesDocument(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
