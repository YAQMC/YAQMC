import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@yaqmc/client';
import { defaultPreferences, usePreferencesStore, type LyricSurfaceSettings } from '../application/preferences';
import type { LyricLine } from '../domain/music';
import {
  DesktopSurface,
  IslandSurface,
  LyricsSurfaceApp,
  LyricsUnlockControl,
  type SurfaceProps,
} from './LyricsSurfaceApp';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../application/yaqmc-runtime', async () => {
  const { YaqmcClient } = await import('@yaqmc/client');
  const bridge = {
    kind: 'tauri' as const,
    windowRole: 'lyrics-desktop' as const,
    window: {
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      close: async () => undefined,
      setFullscreen: async () => undefined,
    },
    shell: {
      openExternal: async () => undefined,
    },
    invoke: invokeMock,
    listen: () => () => undefined,
  };
  const client = new YaqmcClient(bridge as HostBridge);
  client.markReady();
  return {
    getHostBridge: () => bridge,
    getYaqmcClient: () => client,
  };
});

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
  usePreferencesStore.setState({
    ...defaultPreferences,
    surfaces: {
      desktop: { ...defaultPreferences.surfaces.desktop },
      island: { ...defaultPreferences.surfaces.island },
    },
  });
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
    expect(container.querySelector('.lyrics-surface__drag')).toHaveClass('yaqmc-drag');
    expect(container.querySelector('.lyrics-surface__drag')).toHaveAttribute('data-tauri-drag-region');
    expect(container.querySelector('.desktop-lyrics__content')).not.toHaveClass('yaqmc-drag');

    act(() => vi.advanceTimersByTime(121));
    fireEvent.pointerEnter(surface!);
    expect(surface).toHaveAttribute('data-interaction-state', 'visible-interactive-hover');
    fireEvent.pointerLeave(surface!, { clientX: 9_000, clientY: 9_000 });
    act(() => vi.advanceTimersByTime(90));
    expect(surface).toHaveAttribute('data-interaction-state', 'visible-interactive-idle');
  });

  it('routes hover chrome controls through player and host surface commands', async () => {
    invokeMock.mockImplementation(async (method: string, params?: { value?: string }) => {
      if (method === 'lyrics_surface_set_interaction') {
        return params?.value ?? '{"version":2}';
      }
      return undefined;
    });
    render(<DesktopSurface {...props('desktop')} />);

    expect(screen.getByRole('button', { name: 'Previous track' })).toHaveClass('yaqmc-no-drag');
    expect(screen.getByRole('button', { name: 'Play' })).toHaveClass('yaqmc-no-drag');
    expect(screen.getByRole('button', { name: 'Next track' })).toHaveClass('yaqmc-no-drag');
    expect(screen.getByRole('button', { name: 'Lock as passive overlay' })).toHaveClass(
      'yaqmc-no-drag',
    );
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveClass('yaqmc-no-drag');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('yaqmc-no-drag');

    fireEvent.click(screen.getByRole('button', { name: 'Previous track' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next track' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('player_previous');
      expect(invokeMock).toHaveBeenCalledWith('player_toggle');
      expect(invokeMock).toHaveBeenCalledWith('player_next');
      expect(invokeMock).toHaveBeenCalledWith('lyrics_surface_show_settings');
      expect(invokeMock).toHaveBeenCalledWith('lyrics_surface_close', { kind: 'desktop' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Lock as passive overlay' }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        'lyrics_surface_set_interaction',
        expect.objectContaining({ kind: 'desktop', interaction: 'passive-locked' }),
      ),
    );
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
    expect(container.querySelector('.yaqmc-drag')).toBeNull();
  });

  it('does not remount controls after a stale interactive hydrate while locked', () => {
    usePreferencesStore.setState({
      ...defaultPreferences,
      surfaces: {
        ...defaultPreferences.surfaces,
        desktop: {
          ...defaultPreferences.surfaces.desktop,
          enabled: true,
          interaction: 'passive-locked',
        },
      },
    });
    const { container } = render(<LyricsSurfaceApp kind="desktop" />);
    act(() => {
      usePreferencesStore.getState().hydrate({
        ...defaultPreferences,
        surfaces: {
          ...defaultPreferences.surfaces,
          desktop: {
            ...defaultPreferences.surfaces.desktop,
            enabled: true,
            interaction: 'interactive',
          },
        },
      });
    });
    const surface = container.querySelector('.lyrics-surface--desktop');
    fireEvent.pointerEnter(surface!);
    fireEvent.pointerMove(surface!, { clientX: 48, clientY: 36 });
    expect(surface).toHaveAttribute('data-interaction-state', 'visible-passive-locked');
    expect(surface).not.toHaveClass('lyrics-surface--interactive');
    expect(container.querySelector('.lyrics-surface__controls')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('Lyrics Island passive mode', () => {
  it('keeps Island hover after a leave that is still inside the expanded card', () => {
    vi.useFakeTimers();
    const { container } = render(<IslandSurface {...props('island')} />);
    const surface = container.querySelector('.lyrics-surface--island') as HTMLElement;
    surface.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 240,
        bottom: 140,
        width: 240,
        height: 140,
        toJSON: () => ({}),
      }) as DOMRect;

    act(() => vi.advanceTimersByTime(121));
    fireEvent.pointerEnter(surface, { clientX: 40, clientY: 50 });
    expect(surface).toHaveAttribute('data-interaction-state', 'visible-interactive-hover');
    expect(container.querySelector('.lyrics-surface__controls')).toBeInTheDocument();

    fireEvent.pointerLeave(surface, { clientX: 40, clientY: 50 });
    act(() => vi.advanceTimersByTime(90));
    expect(surface).toHaveAttribute('data-interaction-state', 'visible-interactive-hover');
  });

  it('keeps Island transport buttons out of the drag region and wired to Core/host', async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<IslandSurface {...props('island')} />);

    fireEvent.click(screen.getByRole('button', { name: 'Previous track' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next track' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('player_previous');
      expect(invokeMock).toHaveBeenCalledWith('player_toggle');
      expect(invokeMock).toHaveBeenCalledWith('player_next');
      expect(invokeMock).toHaveBeenCalledWith('lyrics_surface_show_settings');
      expect(invokeMock).toHaveBeenCalledWith('lyrics_surface_close', { kind: 'island' });
    });
    expect(screen.getByRole('button', { name: 'Lock as passive overlay' })).toHaveClass(
      'yaqmc-no-drag',
    );
  });
});
