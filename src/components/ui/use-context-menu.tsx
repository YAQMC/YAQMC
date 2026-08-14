import {
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { ContextMenuSurface, type ContextMenuItem } from './ContextMenu';

export function useContextMenu(label: string, items: readonly ContextMenuItem[]) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const close = () => setPosition(null);
  const openAt = (x: number, y: number) => setPosition({ x, y });
  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openAt(event.clientX, event.clientY);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    openAt(bounds.left + Math.min(24, bounds.width / 2), bounds.top + Math.min(24, bounds.height));
  };

  return {
    triggerProps: { onContextMenu, onKeyDown },
    menu: position ? (
      <ContextMenuSurface label={label} position={position} items={items} onClose={close} />
    ) : null,
  };
}
