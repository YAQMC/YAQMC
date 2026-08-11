import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TauriCore from '@tauri-apps/api/core';
import { defaultPreferences, type LyricSurfaceSettings } from '../application/preferences';
import type { LyricLine } from '../domain/music';
import {
  DesktopSurface,
  IslandSurface,
  LyricsUnlockControl,
  type SurfaceProps,
} from './LyricsSurfaceApp';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  invoke: invokeMock,
}));

const line = (text: string): LyricLine => ({
  id: text,
  text,
  startMs: 0,
  endMs: 1_000,
  words: [],
});

function props(
  kind: 'desktop' | 'island',
  settings: Partial<LyricSurfaceSettings> = {},
  current: LyricLine | null = line('Current lyric'),
): SurfaceProps {
  return {
    kind,
    settings: { ...defaultPreferences.surfaces[kind], enabled: true, ...settings },
    projection: null,
    document: null,
    current,
    next: line('Next lyric'),
    wordIndex: -1,
  };
}

afterEach(() => {
  vi.useRealTimers();
  invokeMock.mockReset();
});

describe('Passive Lyrics unlock control', () => {
  it('uses the single-purpose native unlock command for the matching surface', async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<LyricsUnlockControl kind="desktop" />);

    const button = screen.getByRole('button', { name: 'Unlock Desktop Lyrics' });
    fireEvent.click(button);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('lyrics_surface_unlock', { kind: 'desktop' }),
    );
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
  });
});

describe('Desktop Lyrics interaction presentation', () => {
  it('shows editing chrome state on hover and hides it after pointer leave', () => {
    vi.useFakeTimers();
    const { container } = render(<DesktopSurface {...props('desktop')} />);
    const surface = container.querySelector('.lyrics-surface--desktop');
    expect(surface).toHaveAttribute('data-interaction-state', 'visible-interactive-idle');
    expect(container.querySelector('.lyrics-surface__controls')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(121));
    fireEvent.pointerEnter(surface!);
    expect(surface).toHaveAttribute('data-interaction-state', 'visible-interactive-hover');
    fireEvent.pointerLeave(surface!);
    act(() => vi.advanceTimersByTime(90));
    expect(surface).toHaveAttribute('data-interaction-state', 'visible-interactive-idle');
  });

  it('renders no controls or drag region in passive locked mode', () => {
    const { container } = render(
      <DesktopSurface {...props('desktop', { interaction: 'passive-locked' })} />,
    );
    const surface = container.querySelector('.lyrics-surface--desktop');
    fireEvent.pointerEnter(surface!);
    expect(surface).toHaveAttribute('data-interaction-state', 'visible-passive-locked');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.querySelector('[data-tauri-drag-region="true"]')).toBeNull();
  });
});

describe('Lyrics Island passive mode', () => {
  it('never hover-expands while locked and continues rendering lyric updates', () => {
    const initial = props('island', { interaction: 'passive-locked' }, line('First line'));
    const { container, rerender } = render(<IslandSurface {...initial} />);
    const surface = container.querySelector('.lyrics-surface--island');
    fireEvent.pointerEnter(surface!);
    expect(surface).toHaveAttribute('data-interaction-state', 'visible-passive-locked');
    expect(screen.getByText('First line')).toBeInTheDocument();

    rerender(
      <IslandSurface
        {...props('island', { interaction: 'passive-locked' }, line('Updated line'))}
      />,
    );
    expect(screen.getByText('Updated line')).toBeInTheDocument();
    expect(surface).toHaveAttribute('data-interaction-state', 'visible-passive-locked');
  });
});
