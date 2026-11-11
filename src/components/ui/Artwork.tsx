import { useContext, useState, type CSSProperties, type ReactNode } from 'react';
import type { Artwork as ArtworkModel } from '../../domain/music';
import { resolveArtworkSource, type ArtworkPurpose } from '../../application/artwork-resolver';
import { useSafeArtworkSource } from '../../application/artwork-source';
import { ProviderContext, type ActiveProviderSelection } from '../../application/provider-context';

interface ArtworkProps {
  artwork: ArtworkModel;
  className?: string;
  loading?: 'eager' | 'lazy';
  purpose?: ArtworkPurpose;
  fallback?: ReactNode;
  provider?: ActiveProviderSelection;
}

export function Artwork({
  artwork,
  className = '',
  loading = 'lazy',
  purpose = 'medium',
  fallback,
  provider,
}: ArtworkProps) {
  const active = useContext(ProviderContext);
  const requested = resolveArtworkSource(artwork, purpose);
  const source = useSafeArtworkSource(requested, {
    pendingRemote: 'hide',
    provider:
      provider ?? (active ? { providerId: active.id, profileId: active.profileId } : undefined),
  });
  const [failedSource, setFailedSource] = useState<string | null>(null);

  return (
    <span
      className={`artwork ${className}`.trim()}
      style={{ '--artwork-color': artwork.dominantColor } as CSSProperties}
    >
      {source && source !== failedSource ? (
        <img
          src={source}
          alt={artwork.alt}
          loading={loading}
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(source)}
        />
      ) : (
        fallback
      )}
    </span>
  );
}
