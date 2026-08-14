import { useEffect, useState, type CSSProperties } from 'react';
import type { Artwork as ArtworkModel } from '../../domain/music';
import { cachedArtworkSource } from '../../application/artwork-cache';
import { resolveArtworkSource, type ArtworkPurpose } from '../../application/artwork-resolver';

interface ArtworkProps {
  artwork: ArtworkModel;
  className?: string;
  loading?: 'eager' | 'lazy';
  purpose?: ArtworkPurpose;
}

export function Artwork({
  artwork,
  className = '',
  loading = 'lazy',
  purpose = 'medium',
}: ArtworkProps) {
  const requested = resolveArtworkSource(artwork, purpose);
  const [cached, setCached] = useState<{ requested: string; source: string } | null>(null);
  const source = cached?.requested === requested ? cached.source : requested;

  useEffect(() => {
    let active = true;
    const cached = cachedArtworkSource(requested);
    if (cached) {
      void cached
        .then((value) => active && setCached({ requested, source: value }))
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [requested]);

  return (
    <span
      className={`artwork ${className}`.trim()}
      style={{ '--artwork-color': artwork.dominantColor } as CSSProperties}
    >
      <img src={source} alt={artwork.alt} loading={loading} draggable={false} />
    </span>
  );
}
