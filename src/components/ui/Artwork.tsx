import type { CSSProperties } from 'react';
import type { Artwork as ArtworkModel } from '../../domain/music';
import { resolveArtworkSource, type ArtworkPurpose } from '../../application/artwork-resolver';
import { useSafeArtworkSource } from '../../application/artwork-source';

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
  const source = useSafeArtworkSource(requested, { pendingRemote: 'hide' });

  return (
    <span
      className={`artwork ${className}`.trim()}
      style={{ '--artwork-color': artwork.dominantColor } as CSSProperties}
    >
      {source && (
        <img
          src={source}
          alt={artwork.alt}
          loading={loading}
          draggable={false}
          referrerPolicy="no-referrer"
        />
      )}
    </span>
  );
}
