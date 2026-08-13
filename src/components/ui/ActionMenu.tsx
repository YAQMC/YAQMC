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
import { createPortal } from 'react-dom';
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
  const surface = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !surface.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !trigger.current) return;
    const updatePosition = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = 190;
      const estimatedHeight = Math.max(48, (surface.current?.offsetHeight ?? 0) || 150);
      const top =
        anchor.bottom + 6 + estimatedHeight <= window.innerHeight - 8
          ? anchor.bottom + 6
          : Math.max(8, anchor.top - estimatedHeight - 6);
      setPosition({
        top,
        left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
      });
    };
    updatePosition();
    requestAnimationFrame(() => {
      updatePosition();
      surface.current
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus({ preventScroll: true });
    });
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  return (
    <div className={`action-menu ${className}`.trim()} ref={root}>
      <IconButton
        ref={trigger}
        label={label}
        size={size}
        className="action-menu__trigger"
        active={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={size === 'small' ? 16 : 19} />
      </IconButton>
      {open &&
        createPortal(
          <div
            className="action-menu__surface"
            role="menu"
            aria-label={label}
            ref={surface}
            style={position}
            data-portal="true"
          >
            {Children.map(children, (child) =>
              isValidElement(child)
                ? cloneElement(child as ReactElement<{ onSelect?: () => void }>, {
                    onSelect: () => setOpen(false),
                  })
                : child,
            )}
          </div>,
          document.body,
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
