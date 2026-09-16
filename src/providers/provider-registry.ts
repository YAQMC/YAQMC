import {
  createMusicProviderCapabilityFacade,
  type MusicProvider,
  type MusicProviderCapabilityFacade,
} from './music-provider';
import { DEFAULT_PROFILE_ID } from '../domain/music';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

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

export function parseProfileId(value: string): string {
  if (typeof value !== 'string' || !PROFILE_ID_PATTERN.test(value)) {
    throw new Error(
      'Profile ID must be 1-64 lowercase ASCII letters, digits, dots, underscores, or hyphens.',
    );
  }
  return value;
}

export function isProfileId(value: string): boolean {
  return typeof value === 'string' && PROFILE_ID_PATTERN.test(value);
}

export interface MusicProviderSelection {
  readonly providerId: ProviderId | string;
  readonly profileId: string;
}

/**
 * Read-only compatibility registry for the current renderer provider surface.
 * Runtime registration/lifecycle is introduced with Provider plugins; P0 only
 * removes the singleton/static-ID assumption without changing active-provider UX.
 */
export class MusicProviderRegistry {
  readonly #providers = new Map<string, MusicProviderCapabilityFacade>();
  readonly #activeSelection: MusicProviderSelection;

  constructor(active: MusicProviderSelection | string, providers: Iterable<MusicProvider>) {
    const activeSelection =
      typeof active === 'string' ? { providerId: active, profileId: DEFAULT_PROFILE_ID } : active;
    this.#activeSelection = {
      providerId: parseProviderId(activeSelection.providerId),
      profileId: parseProfileId(activeSelection.profileId),
    };
    for (const provider of providers) {
      const id = parseProviderId(provider.id);
      const profileId = parseProfileId(provider.profileId);
      const key = providerKey(id, profileId);
      if (this.#providers.has(key)) {
        throw new Error(`Duplicate music provider ID/profile identity: ${id}/${profileId}`);
      }
      this.#providers.set(key, createMusicProviderCapabilityFacade(provider));
    }
    if (this.#providers.size === 0) {
      throw new Error('At least one music provider is required.');
    }
    if (
      !this.#providers.has(
        providerKey(this.#activeSelection.providerId, this.#activeSelection.profileId),
      )
    ) {
      throw new Error(
        `Active music provider is missing: ${this.#activeSelection.providerId}/${this.#activeSelection.profileId}`,
      );
    }
  }

  get activeId(): ProviderId {
    return this.#activeSelection.providerId as ProviderId;
  }

  get activeProfileId(): string {
    return this.#activeSelection.profileId;
  }

  get activeSelection(): MusicProviderSelection {
    return this.#activeSelection;
  }

  get active(): MusicProviderCapabilityFacade {
    return this.#providers.get(
      providerKey(this.#activeSelection.providerId, this.#activeSelection.profileId),
    )!;
  }

  get(id: string, profileId = DEFAULT_PROFILE_ID): MusicProviderCapabilityFacade | null {
    return isProviderId(id) && isProfileId(profileId)
      ? (this.#providers.get(providerKey(id, profileId)) ?? null)
      : null;
  }

  ids(): readonly ProviderId[] {
    return Object.freeze(
      [...new Set([...this.#providers.values()].map((provider) => provider.id))].map((id) =>
        parseProviderId(id),
      ),
    );
  }
}

function providerKey(providerId: ProviderId | string, profileId: string): string {
  return `${providerId}\0${profileId}`;
}
