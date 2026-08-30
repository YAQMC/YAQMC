import {
  createMusicProviderCapabilityFacade,
  type MusicProvider,
  type MusicProviderCapabilityFacade,
} from './music-provider';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

declare const providerIdBrand: unique symbol;
export type ProviderId = string & { readonly [providerIdBrand]: true };

export function parseProviderId(value: string): ProviderId {
  if (!PROVIDER_ID_PATTERN.test(value)) {
    throw new Error(
      'Provider ID must be 1-64 lowercase ASCII letters, digits, dots, underscores, or hyphens.',
    );
  }
  return value as ProviderId;
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_ID_PATTERN.test(value);
}

/**
 * Read-only compatibility registry for the current renderer provider surface.
 * Runtime registration/lifecycle is introduced with Provider plugins; P0 only
 * removes the singleton/static-ID assumption without changing active-provider UX.
 */
export class MusicProviderRegistry {
  readonly #providers = new Map<ProviderId, MusicProviderCapabilityFacade>();
  readonly #activeId: ProviderId;

  constructor(activeId: string, providers: Iterable<MusicProvider>) {
    this.#activeId = parseProviderId(activeId);
    for (const provider of providers) {
      const id = parseProviderId(provider.id);
      if (this.#providers.has(id)) {
        throw new Error(`Duplicate music provider ID: ${id}`);
      }
      this.#providers.set(id, createMusicProviderCapabilityFacade(provider));
    }
    if (this.#providers.size === 0) {
      throw new Error('At least one music provider is required.');
    }
    if (!this.#providers.has(this.#activeId)) {
      throw new Error(`Active music provider is missing: ${this.#activeId}`);
    }
  }

  get activeId(): ProviderId {
    return this.#activeId;
  }

  get active(): MusicProviderCapabilityFacade {
    return this.#providers.get(this.#activeId)!;
  }

  get(id: string): MusicProviderCapabilityFacade | null {
    return isProviderId(id) ? (this.#providers.get(id) ?? null) : null;
  }

  ids(): readonly ProviderId[] {
    return Object.freeze([...this.#providers.keys()]);
  }
}
