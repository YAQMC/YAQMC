export interface ArtworkPalette {
  primary: string;
  secondary: string;
  identity: string;
  revision: number;
}

const cache = new Map<string, ArtworkPalette>();
const inflight = new Map<string, Promise<ArtworkPalette>>();
let revision = 0;
const MAX_CACHE = 24;

function hexFromRgb(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`.toUpperCase();
}

function fallbackPalette(identity: string, fallback: string): ArtworkPalette {
  return {
    primary: fallback,
    secondary: fallback,
    identity,
    revision,
  };
}

export function cachedArtworkPalette(identity: string | null): ArtworkPalette | null {
  if (!identity) return null;
  return cache.get(identity) ?? null;
}

export function rememberArtworkPalette(palette: ArtworkPalette): ArtworkPalette {
  cache.set(palette.identity, palette);
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return palette;
}

export async function resolveArtworkPalette(
  identity: string | null,
  source: string | null,
  fallback: string,
  generation: number,
): Promise<ArtworkPalette> {
  revision = generation;
  if (!identity) return fallbackPalette('none', fallback);
  const hit = cache.get(identity);
  if (hit) return hit;
  const pending = inflight.get(identity);
  if (pending) return pending;
  const task = extractPalette(identity, source, fallback, generation);
  inflight.set(identity, task);
  try {
    return await task;
  } finally {
    inflight.delete(identity);
  }
}

async function extractPalette(
  identity: string,
  source: string | null,
  fallback: string,
  generation: number,
): Promise<ArtworkPalette> {
  if (!source || typeof Image === 'undefined' || typeof document === 'undefined') {
    return rememberArtworkPalette(fallbackPalette(identity, fallback));
  }
  try {
    const image = await loadImage(source);
    if (generation !== revision) return fallbackPalette(identity, fallback);
    const sample = sampleImage(image, fallback);
    if (generation !== revision) return fallbackPalette(identity, fallback);
    return rememberArtworkPalette({ ...sample, identity, revision: generation });
  } catch {
    return rememberArtworkPalette(fallbackPalette(identity, fallback));
  }
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('artwork decode failed'));
    image.src = source;
  });
}

function sampleImage(
  image: HTMLImageElement,
  fallback: string,
): Omit<ArtworkPalette, 'identity' | 'revision'> {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { primary: fallback, secondary: fallback };
  context.drawImage(image, 0, 0, 16, 16);
  const { data } = context.getImageData(0, 0, 16, 16);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  let accent = { r: 0, g: 0, b: 0, score: -1 };
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    if (alpha < 32) continue;
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    r += red;
    g += green;
    b += blue;
    count += 1;
    const saturation = Math.max(red, green, blue) - Math.min(red, green, blue);
    if (saturation > accent.score) accent = { r: red, g: green, b: blue, score: saturation };
  }
  if (count === 0) return { primary: fallback, secondary: fallback };
  return {
    primary: hexFromRgb(r / count, g / count, b / count),
    secondary: hexFromRgb(accent.r, accent.g, accent.b),
  };
}

export function colorFieldEmitterColor(
  emitter: { color: string; bind?: 'artworkPrimary' | 'artworkSecondary' | null },
  palette: ArtworkPalette | null,
): string {
  if (emitter.bind === 'artworkPrimary') return palette?.primary ?? emitter.color;
  if (emitter.bind === 'artworkSecondary') return palette?.secondary ?? emitter.color;
  return emitter.color;
}
