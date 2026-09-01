import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { homeFeed } from '../providers/fake/fixtures';
import { HomePage } from './HomePage';

describe('HomePage', () => {
  beforeEach(() => usePlayerStore.setState(initialPlayerState));

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
});
