import type { ReactNode } from 'react';
import { useNavigate } from '../application/navigation-context';

type EntityKind = 'song' | 'artist' | 'album';

interface EntityLinkProps {
  entity: EntityKind;
  id: string | null | undefined;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  dataYaqmc?: string;
}

export function EntityLink({
  entity,
  id,
  children,
  className,
  ariaLabel,
  dataYaqmc,
}: EntityLinkProps) {
  const navigate = useNavigate();
  const normalizedId = id?.trim() ?? '';

  if (!normalizedId || !navigate) {
    return (
      <span className={className} data-yaqmc={dataYaqmc}>
        {children}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={['entity-link', className].filter(Boolean).join(' ')}
      aria-label={ariaLabel}
      data-yaqmc={dataYaqmc}
      onClick={(event) => {
        event.stopPropagation();
        navigate({ page: entity, id: normalizedId });
      }}
    >
      {children}
    </button>
  );
}
