import { useEffect, useState, type CSSProperties } from 'react';
import type { Artwork as ArtworkModel } from '../../domain/music';
import { cachedArtworkSource } from '../../application/artwork-cache';

interface ArtworkProps {
  artwork: ArtworkModel;
  className?: string;
  loading?: 'eager' | 'lazy';
}

export function Artwork({ artwork, className = '', loading = 'lazy' }: ArtworkProps) {
  const [cached, setCached] = useState<{ requested: string; source: string } | null>(null);
  const source = cached?.requested === artwork.src ? cached.source : artwork.src;

  useEffect(() => {
    let active = true;
    const cached = cachedArtworkSource(artwork.src);
    if (cached) {
      void cached
        .then((value) => active && setCached({ requested: artwork.src, source: value }))
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [artwork.src]);

  return (
    <span
      className={`artwork ${className}`.trim()}
      style={{ '--artwork-color': artwork.dominantColor } as CSSProperties}
    >
      <img src={source} alt={artwork.alt} loading={loading} draggable={false} />
    </span>
  );
}
