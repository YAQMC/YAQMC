import type { ShareTarget, Song } from '../domain/music';
import type { ShareMusicProvider } from '../providers/music-provider';
import { isProviderId } from '../providers/provider-registry';

export type SongShareKind = 'public-link' | 'yaqmc-link' | 'text';

const MAX_ENTITY_ID_BYTES = 256;

export class SongShareUnavailableError extends Error {
  constructor(
    readonly reason: 'provider' | 'target' | 'public-link',
    message: string,
  ) {
    super(message);
    this.name = 'SongShareUnavailableError';
  }
}

export function buildYaqmcSongLink(target: ShareTarget): string {
  assertShareTarget(target);
  return `yaqmc://catalog/${target.providerId}/song?id=${encodeURIComponent(target.entityId)}`;
}

export function formatSongShareText(target: ShareTarget): string {
  assertShareTarget(target);
  const artists = target.artists
    .map((artist) => artist.trim())
    .filter(Boolean)
    .join(', ');
  return artists ? `${target.title.trim()} — ${artists}` : target.title.trim();
}

export async function resolveSongShareValue(
  provider: ShareMusicProvider,
  providerId: string,
  song: Song,
  kind: SongShareKind,
  signal?: AbortSignal,
): Promise<string> {
  const songId = song.id.trim();
  const referencedProviderId = song.provider?.providerId.trim();
  if (
    !songId ||
    !isProviderId(providerId) ||
    (referencedProviderId && referencedProviderId !== providerId)
  ) {
    throw new SongShareUnavailableError('provider', 'The song does not belong to this provider.');
  }

  if (kind !== 'public-link') {
    const localTarget: ShareTarget = {
      providerId,
      entityKind: 'song',
      entityId: songId,
      title: song.title,
      artists: song.artists.map((artist) => artist.name),
      album: song.album.title,
    };
    return kind === 'yaqmc-link'
      ? buildYaqmcSongLink(localTarget)
      : formatSongShareText(localTarget);
  }

  const target = await provider.getSongShareTarget(songId, signal);
  assertShareTarget(target);
  if (
    target.providerId !== providerId ||
    target.entityId !== songId ||
    target.entityKind !== 'song'
  ) {
    throw new SongShareUnavailableError(
      'target',
      'The provider returned a mismatched share target.',
    );
  }

  const publicUrl = parsePublicHttpsUrl(target.canonicalHttpsUrl);
  if (!publicUrl) {
    throw new SongShareUnavailableError(
      'public-link',
      'This provider did not return a public HTTPS link for the song.',
    );
  }
  return publicUrl;
}

export async function copyTextToClipboard(
  value: string,
  nativeWriteText?: (text: string) => Promise<void>,
): Promise<void> {
  if (nativeWriteText) {
    await nativeWriteText(value);
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard copy was rejected.');
  } finally {
    textarea.remove();
  }
}

function assertShareTarget(target: ShareTarget): void {
  const entityId = target.entityId.trim();
  if (
    target.entityKind !== 'song' ||
    !isProviderId(target.providerId) ||
    !entityId ||
    new TextEncoder().encode(entityId).length > MAX_ENTITY_ID_BYTES ||
    hasControlCharacters(entityId) ||
    !target.title.trim() ||
    hasControlCharacters(target.title)
  ) {
    throw new SongShareUnavailableError('target', 'The provider returned an invalid share target.');
  }
}

function parsePublicHttpsUrl(value: string | undefined): string | null {
  if (!value || hasControlCharacters(value)) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !url.hostname
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
