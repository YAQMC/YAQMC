import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { MoreHorizontal } from 'lucide-react';
import { IconButton } from './IconButton';

interface ActionMenuProps {
  label: string;
  children: ReactNode;
  className?: string;
  size?: 'small' | 'medium' | 'large';
}

export function ActionMenu({ label, children, className = '', size = 'medium' }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className={`action-menu ${className}`.trim()} ref={root}>
      <IconButton
        label={label}
        size={size}
        className="action-menu__trigger"
        active={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={size === 'small' ? 16 : 19} />
      </IconButton>
      {open && (
        <div className="action-menu__surface" role="menu" aria-label={label}>
          {Children.map(children, (child) =>
            isValidElement(child)
              ? cloneElement(child as ReactElement<{ onSelect?: () => void }>, {
                  onSelect: () => setOpen(false),
                })
              : child,
          )}
        </div>
      )}
    </div>
  );
}

interface ActionMenuItemProps {
  children: ReactNode;
  onClick: () => void | Promise<void>;
  onSelect?: () => void;
  disabled?: boolean;
}

export function ActionMenuItem({
  children,
  onClick,
  onSelect,
  disabled = false,
}: ActionMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onSelect?.();
        void onClick();
      }}
    >
      {children}
    </button>
  );
}
