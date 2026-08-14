let lastKnownArtworkSource: string | null = null;
let lastKnownBlurredBackdrop: string | null = null;

export function lyricsArtworkFallback(): string | null {
  return lastKnownArtworkSource;
}

export function lyricsBlurredBackdropFallback(): string | null {
  return lastKnownBlurredBackdrop;
}

export function rememberLyricsArtwork(source: string | null): void {
  if (source) lastKnownArtworkSource = source;
}

export function rememberLyricsBlurredBackdrop(source: string | null): void {
  if (source) lastKnownBlurredBackdrop = source;
}

export function resetLyricsArtworkFallbackForTests(): void {
  lastKnownArtworkSource = null;
  lastKnownBlurredBackdrop = null;
}
