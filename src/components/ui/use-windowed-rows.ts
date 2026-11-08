import { useLayoutEffect, useState } from 'react';

/** Lists up to this many rows render in full, exactly as before windowing existed. */
export const WINDOWING_MIN_ROWS = 200;
const INITIAL_ROWS = 60;
const OVERSCAN_PX = 800;

export interface RowWindow {
  start: number;
  end: number;
  /** Spacer heights (px) standing in for the unmounted rows above and below. */
  before: number;
  after: number;
  /** Pass as the `ref` of the element whose direct children are the rows. */
  setContainer: (node: HTMLElement | null) => void;
}

function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/**
 * Mounts only the rows near the visible part of the row container's scroll parent. Rows must be
 * direct children of the container carrying `data-row-index`; their height is measured.
 * Without layout (hidden panel, jsdom) the window stays at its initial size.
 */
export function useWindowedRows(count: number): RowWindow {
  const windowed = count > WINDOWING_MIN_ROWS;
  const [list, setContainer] = useState<HTMLElement | null>(null);
  const [state, setState] = useState({ start: 0, end: INITIAL_ROWS, rowHeight: 0 });

  useLayoutEffect(() => {
    if (!windowed || !list) return;
    const scroller = scrollParent(list);
    const update = () => {
      const rows = list.querySelectorAll<HTMLElement>(':scope > [data-row-index]');
      const first = rows[0];
      if (!first) return;
      const firstBox = first.getBoundingClientRect();
      const rowHeight =
        rows.length > 1 ? rows[1]!.getBoundingClientRect().top - firstBox.top : firstBox.height;
      if (!(rowHeight > 0)) return;
      const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const top = firstBox.top - Number(first.dataset.rowIndex) * rowHeight;
      // Keep two measurement anchors even while the list is outside the viewport.
      const start = Math.min(
        count - 2,
        Math.max(0, Math.floor((view.top - OVERSCAN_PX - top) / rowHeight)),
      );
      const end = Math.min(
        count,
        Math.max(start + 2, Math.ceil((view.bottom + OVERSCAN_PX - top) / rowHeight)),
      );
      setState((current) =>
        current.start === start && current.end === end && current.rowHeight === rowHeight
          ? current
          : { start, end: Math.max(start, end), rowHeight },
      );
    };
    update();
    const target = scroller ?? window;
    target.addEventListener('scroll', update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(scroller ?? document.documentElement);
    return () => {
      target.removeEventListener('scroll', update);
      resize.disconnect();
    };
  }, [list, count, windowed]);

  if (!windowed) return { start: 0, end: count, before: 0, after: 0, setContainer };
  const start = Math.min(state.start, count - 2);
  const end = Math.min(Math.max(state.end, start + 2), count);
  return {
    start,
    end,
    before: start * state.rowHeight,
    after: (count - end) * state.rowHeight,
    setContainer,
  };
}
