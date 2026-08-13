import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  id: string;
  label: string;
  action: () => void | Promise<void>;
  disabled?: boolean;
}

interface ContextMenuPosition {
  x: number;
  y: number;
}

interface ContextMenuSurfaceProps {
  label: string;
  position: ContextMenuPosition;
  items: readonly ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenuSurface({
  label,
  position,
  items,
  onClose,
}: ContextMenuSurfaceProps): ReactNode {
  const surface = useRef<HTMLDivElement>(null);
  const estimatedHeight = items.length * 40 + 12;
  const left = Math.max(8, Math.min(position.x, window.innerWidth - 228));
  const top = Math.max(8, Math.min(position.y, window.innerHeight - estimatedHeight - 8));

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!surface.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    const frame = window.requestAnimationFrame(() => {
      surface.current
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus({ preventScroll: true });
    });
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(
      surface.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowDown'
            ? (activeIndex + 1 + buttons.length) % buttons.length
            : (activeIndex - 1 + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  };

  return createPortal(
    <div
      ref={surface}
      className="context-menu__surface"
      role="menu"
      aria-label={label}
      style={{ top, left }}
      onKeyDown={moveFocus}
      data-portal="true"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            onClose();
            void item.action();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
