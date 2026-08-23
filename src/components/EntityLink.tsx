import type { ReactNode } from 'react';
import { useNavigate } from '../application/navigation-context';

type EntityKind = 'song' | 'artist' | 'album';

interface EntityLinkProps {
  entity: EntityKind;
  id: string | null | undefined;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}

export function EntityLink({ entity, id, children, className, ariaLabel }: EntityLinkProps) {
  const navigate = useNavigate();
  const normalizedId = id?.trim() ?? '';

  if (!normalizedId || !navigate) {
    return <span className={className}>{children}</span>;
  }

  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        navigate({ page: entity, id: normalizedId });
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </button>
  );
}
