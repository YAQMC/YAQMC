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

export function hexFromRgb(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`.toUpperCase();
}

export function rgbToHsl(r: number, g: number, b: number): [h: number, s: number, l: number] {
  const normR = r / 255;
  const normG = g / 255;
  const normB = b / 255;
  const max = Math.max(normR, normG, normB);
  const min = Math.min(normR, normG, normB);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case normR:
        h = (normG - normB) / d + (normG < normB ? 6 : 0);
        break;
      case normG:
        h = (normB - normR) / d + 2;
        break;
      case normB:
        h = (normR - normG) / d + 4;
        break;
    }
    h *= 60;
  }
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [r: number, g: number, b: number] {
  const normH = ((h % 360) + 360) % 360;
  const normS = Math.max(0, Math.min(1, s));
  const normL = Math.max(0, Math.min(1, l));

  const c = (1 - Math.abs(2 * normL - 1)) * normS;
  const x = c * (1 - Math.abs(((normH / 60) % 2) - 1));
  const m = normL - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (normH < 60) {
    r = c;
    g = x;
  } else if (normH < 120) {
    r = x;
    g = c;
  } else if (normH < 180) {
    g = c;
    b = x;
  } else if (normH < 240) {
    g = x;
    b = c;
  } else if (normH < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
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

export function clearArtworkPaletteCacheForTests(): void {
  cache.clear();
  inflight.clear();
  revision = 0;
}

export async function resolveArtworkPalette(
  identity: string | null,
  source: string | null,
  fallback: string,
  generation: number,
): Promise<ArtworkPalette> {
  revision = generation;
  if (!identity) return fallbackPalette('none', fallback);
  // Never cache a missing source: return fallback placeholder immediately,
  // leaving the cache unpoisoned so async base64/remote image triggers real extraction.
  if (!source) return fallbackPalette(identity, fallback);

  const hit = cache.get(identity);
  if (hit) return hit;

  const inflightKey = `${identity}::${source}`;
  const pending = inflight.get(inflightKey);
  if (pending) return pending;

  const task = extractPalette(identity, source, fallback, generation);
  inflight.set(inflightKey, task);
  try {
    return await task;
  } finally {
    inflight.delete(inflightKey);
  }
}

async function extractPalette(
  identity: string,
  source: string,
  fallback: string,
  generation: number,
): Promise<ArtworkPalette> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') {
    return fallbackPalette(identity, fallback);
  }
  try {
    const image = await loadImage(source);
    if (generation !== revision) return fallbackPalette(identity, fallback);
    const sample = sampleImage(image, fallback);
    if (generation !== revision) return fallbackPalette(identity, fallback);
    return rememberArtworkPalette({ ...sample, identity, revision: generation });
  } catch {
    return fallbackPalette(identity, fallback);
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

interface ColorBucket {
  isNeutral: boolean;
  count: number;
  sumR: number;
  sumG: number;
  sumB: number;
  sumS: number;
  sumL: number;
}

export function sampleImage(
  image: CanvasImageSource,
  fallback: string,
): Omit<ArtworkPalette, 'identity' | 'revision'> {
  const SAMPLE_SIZE = 48;
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { primary: fallback, secondary: fallback };
  context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

  // 16 chromatic hue buckets (22.5 deg each) + 3 neutral buckets (dark, mid, light)
  const buckets: ColorBucket[] = Array.from({ length: 19 }, (_, idx) => ({
    isNeutral: idx >= 16,
    count: 0,
    sumR: 0,
    sumG: 0,
    sumB: 0,
    sumS: 0,
    sumL: 0,
  }));

  let totalValidPixels = 0;
  let allPixelsCount = 0;
  let allR = 0;
  let allG = 0;
  let allB = 0;

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    if (alpha < 64) continue;
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;

    allR += red;
    allG += green;
    allB += blue;
    allPixelsCount += 1;

    const [h, s, l] = rgbToHsl(red, green, blue);

    // Skip extreme letterbox blacks and paper whites to prevent border pollution
    if (l < 0.06 || l > 0.94) continue;

    let bucketIndex: number;
    if (s < 0.14) {
      // Neutral bucket
      bucketIndex = l < 0.35 ? 16 : l < 0.7 ? 17 : 18;
    } else {
      bucketIndex = Math.floor(h / 22.5) % 16;
    }

    const bucket = buckets[bucketIndex]!;
    bucket.count += 1;
    bucket.sumR += red;
    bucket.sumG += green;
    bucket.sumB += blue;
    bucket.sumS += s;
    bucket.sumL += l;
    totalValidPixels += 1;
  }

  if (allPixelsCount === 0) return { primary: fallback, secondary: fallback };

  // If all pixels were extreme black/white borders, fall back to global average
  if (totalValidPixels === 0) {
    const avg = hexFromRgb(allR / allPixelsCount, allG / allPixelsCount, allB / allPixelsCount);
    return { primary: avg, secondary: fallback };
  }

  // 1. Primary: select dominant atmospheric tone (weighted by saturation to favor color presence)
  let bestPrimaryBucket: ColorBucket | null = null;
  let bestPrimaryScore = -1;

  for (const bucket of buckets) {
    if (bucket.count === 0) continue;
    const avgS = bucket.sumS / bucket.count;
    // Chromatic clusters receive saturation weighting; neutrals stay at base count
    const weight = bucket.isNeutral ? bucket.count * 0.65 : bucket.count * (1 + avgS * 1.5);
    if (weight > bestPrimaryScore) {
      bestPrimaryScore = weight;
      bestPrimaryBucket = bucket;
    }
  }

  const primaryBucket = bestPrimaryBucket ?? buckets[16]!;
  const primaryR = Math.round(primaryBucket.sumR / primaryBucket.count);
  const primaryG = Math.round(primaryBucket.sumG / primaryBucket.count);
  const primaryB = Math.round(primaryBucket.sumB / primaryBucket.count);
  const primaryHex = hexFromRgb(primaryR, primaryG, primaryB);
  const [primaryH] = rgbToHsl(primaryR, primaryG, primaryB);

  // 2. Secondary: select vibrant lyric accent / glow color
  let bestAccentBucket: ColorBucket | null = null;
  let bestAccentScore = -1;
  const minAccentPixels = Math.max(12, Math.round(totalValidPixels * 0.012));

  for (let idx = 0; idx < 16; idx++) {
    const bucket = buckets[idx]!;
    if (bucket.count < minAccentPixels) continue;

    const avgS = bucket.sumS / bucket.count;
    const avgL = bucket.sumL / bucket.count;
    if (avgS < 0.22) continue;

    // Prefer balanced lightness suitable for glowing lyrics (0.4 ~ 0.7)
    const lightnessScore = 1 - Math.min(1, Math.abs(avgL - 0.55) * 1.8);
    // Contrast bonus when bucket hue differs from primary
    const hueCenter = idx * 22.5 + 11.25;
    const hueDiff = Math.abs(hueCenter - primaryH);
    const circularHueDiff = Math.min(hueDiff, 360 - hueDiff);
    const contrastBonus = circularHueDiff > 35 ? 1.35 : 1.0;

    const score = Math.sqrt(bucket.count) * (avgS * avgS) * lightnessScore * contrastBonus;
    if (score > bestAccentScore) {
      bestAccentScore = score;
      bestAccentBucket = bucket;
    }
  }

  let secondaryHex: string;
  if (bestAccentBucket) {
    const r = Math.round(bestAccentBucket.sumR / bestAccentBucket.count);
    const g = Math.round(bestAccentBucket.sumG / bestAccentBucket.count);
    const b = Math.round(bestAccentBucket.sumB / bestAccentBucket.count);
    const [h, s, l] = rgbToHsl(r, g, b);
    // Lift dark accent luminance so the lyric active glow is luminous rather than murky black
    const luminousL = l < 0.42 ? Math.min(0.62, Math.max(0.46, l * 1.45)) : l;
    const [finalR, finalG, finalB] = hslToRgb(h, Math.max(s, 0.45), luminousL);
    secondaryHex = hexFromRgb(finalR, finalG, finalB);
  } else {
    // Monochrome / desaturated fallback: derive a clean high-contrast tone from primary
    const [, , primaryL] = rgbToHsl(primaryR, primaryG, primaryB);
    const fallbackL = primaryL < 0.5 ? 0.78 : 0.22;
    const [r, g, b] = hslToRgb(primaryH, 0.15, fallbackL);
    secondaryHex = hexFromRgb(r, g, b);
  }

  return {
    primary: primaryHex,
    secondary: secondaryHex,
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
