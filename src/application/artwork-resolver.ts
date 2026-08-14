import type { Artwork, ArtworkVariant } from '../domain/music';

export type ArtworkPurpose = 'small' | 'medium' | 'large' | 'fullscreen';

const targetPixels: Record<ArtworkPurpose, number> = {
  small: 150,
  medium: 300,
  large: 500,
  fullscreen: 800,
};

function usableVariant(variant: ArtworkVariant): boolean {
  return (
    variant.src.trim().length > 0 &&
    Number.isFinite(variant.width) &&
    Number.isFinite(variant.height) &&
    variant.width > 0 &&
    variant.height > 0
  );
}

export function resolveArtworkSource(artwork: Artwork, purpose: ArtworkPurpose = 'medium'): string {
  const variants = (artwork.variants ?? []).filter(usableVariant).slice();
  variants.sort(
    (left, right) => Math.min(left.width, left.height) - Math.min(right.width, right.height),
  );
  if (variants.length === 0) return artwork.src;

  const target = targetPixels[purpose];
  return (
    variants.find((variant) => Math.min(variant.width, variant.height) >= target) ??
    variants.at(-1)!
  ).src;
}
