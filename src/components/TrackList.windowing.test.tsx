import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../domain/music';
import { allSongs } from '../providers/fake/fixtures';
import { TrackList } from './TrackList';

const ROW = 58;
const HEADER = 34;
const VIEW = 600;
let scrollTop = 0;

function box(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
  } as DOMRect;
}

const tracks = (count: number): Song[] =>
  Array.from({ length: count }, (_, index) => ({ ...allSongs[0]!, id: `song-${index}` }));

describe('TrackList windowing', () => {
  beforeEach(() => {
    scrollTop = 0;
    // jsdom has no layout: give the scroll parent a 600 px viewport and rows a fixed height.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const element = this as HTMLElement;
      if (element.style.overflowY === 'auto') return box(0, VIEW);
      const index = element.dataset.rowIndex;
      return index === undefined ? box(0, 0) : box(HEADER + Number(index) * ROW - scrollTop, ROW);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('mounts only rows near the viewport and follows scrolling', () => {
    render(
      <div style={{ overflowY: 'auto' }} data-testid="scroller">
        <TrackList tracks={tracks(300)} />
      </div>,
    );
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '301');
    const mounted = () => screen.getAllByRole('row').slice(1);
    expect(mounted().length).toBeLessThan(60);
    expect(mounted()[0]).toHaveAttribute('aria-rowindex', '2');

    scrollTop = 150 * ROW;
    act(() => {
      fireEvent.scroll(screen.getByTestId('scroller'));
    });
    const first = mounted()[0]!;
    expect(first).toHaveAttribute('data-row-index', '135');
    expect(first).toHaveAttribute('aria-rowindex', '137');
    expect(first.previousElementSibling).toHaveStyle({ height: `${135 * ROW}px` });
    expect(mounted().at(-1)).toHaveAttribute('data-row-index', String(mounted().length + 134));
  });

  it('renders short lists in full', () => {
    render(
      <div style={{ overflowY: 'auto' }}>
        <TrackList tracks={tracks(200)} />
      </div>,
    );
    expect(screen.getAllByRole('row')).toHaveLength(201);
  });
});
