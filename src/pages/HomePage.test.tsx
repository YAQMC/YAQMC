import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { homeFeed } from '../providers/fake/fixtures';
import { applyPluginPageCall, clearPluginPageContributions } from '../application/plugin-pages';
import { HomePage } from './HomePage';

describe('HomePage', () => {
  beforeEach(() => {
    usePlayerStore.setState(initialPlayerState);
    clearPluginPageContributions();
  });

  it('applies a plugin Home layout and attributes it', () => {
    applyPluginPageCall('dev.example.layout', 'Layout plugin', 'ui.layout.set', {
      target: 'home',
      order: ['recommended-playlists'],
      hidden: ['radar'],
    });
    const { container } = render(
      <HomePage feed={structuredClone(homeFeed)} onNavigate={vi.fn()} />,
    );

    const headings = [...container.querySelectorAll('.content-section h2')].map(
      (heading) => heading.textContent,
    );
    expect(headings[0]).toBe('Recommended playlists');
    expect(headings).toHaveLength(2);
    expect(container.querySelector('.track-list')).toBeNull();
    expect(screen.getByText('Layout customized by Layout plugin')).toBeVisible();

    clearPluginPageContributions('dev.example.layout');
  });

  it('renders the provider daily title and the actual returned track count', () => {
    const onNavigate = vi.fn();
    const feed = structuredClone(homeFeed);
    const daily = feed.dailySonglist!;
    daily.title = 'Provider supplied daily title';
    daily.tracks = daily.tracks.slice(0, 3);

    render(<HomePage feed={feed} onNavigate={onNavigate} />);

    expect(screen.getByText('Provider supplied daily title')).toBeVisible();
    expect(screen.getByText('3 tracks')).toBeVisible();
    expect(screen.queryByText('Daily 30')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Provider supplied daily title' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'playlist', id: daily.id });
  });

  it('uses the first daily track artwork for the middle recommendation card', () => {
    const feed = structuredClone(homeFeed);
    const daily = feed.dailySonglist!;
    const expectedSource = daily.tracks[0]!.artwork.src;

    render(<HomePage feed={feed} onNavigate={vi.fn()} />);

    const open = screen.getByRole('button', { name: `Open ${daily.title}` });
    expect(open.querySelector('img')).toHaveAttribute('src', expectedSource);
  });

  it('renders a stable English date cover when daily tracks have no artwork', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 1, 12, 0, 0));
    try {
      const feed = structuredClone(homeFeed);
      const daily = feed.dailySonglist!;
      daily.tracks = daily.tracks.map((track) => ({
        ...track,
        artwork: { ...track.artwork, src: '', variants: [] },
      }));

      render(<HomePage feed={feed} onNavigate={vi.fn()} />);

      const open = screen.getByRole('button', { name: `Open ${daily.title}` });
      expect(open.querySelector('img')).toBeNull();
      expect(open).toHaveTextContent('SEP');
      expect(open).toHaveTextContent('01');
      expect(open).toHaveTextContent('DAILY MIX');
    } finally {
      vi.useRealTimers();
    }
  });
});
