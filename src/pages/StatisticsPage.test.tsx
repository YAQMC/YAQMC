import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatisticsSnapshot } from '@yaqmc/client';
import { NavigationProvider } from '../application/navigation-context';
import i18n from '../i18n';

const statisticsMocks = vi.hoisted(() => ({
  useRuntime: vi.fn(),
  refresh: vi.fn(),
  exportData: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('../application/statistics-runtime', () => ({
  useStatisticsRuntime: statisticsMocks.useRuntime,
}));

import { StatisticsPage } from './StatisticsPage';

const populated: StatisticsSnapshot = {
  range: '30-days',
  fromMs: 0,
  toMs: 1,
  qualifiedListeningMs: 7_200_000,
  qualifiedPlayCount: 12,
  completedCount: 8,
  skippedCount: 3,
  skipRate: 0.2,
  recordCount: 15,
  databaseBytes: 2_048,
  topSongs: [
    {
      providerId: 'qqmusic',
      id: 'song-1',
      title: 'Signal',
      subtitle: 'Album A',
      listenedMs: 3_600_000,
      playCount: 4,
    },
  ],
  topArtists: [],
  topAlbums: [],
  daily: [{ dayStartMs: 1_700_000_000_000, listenedMs: 3_600_000, playCount: 4 }],
  qualities: [{ key: 'lossless', listenedMs: 3_600_000, playCount: 4 }],
  providers: [{ key: 'qqmusic', listenedMs: 3_600_000, playCount: 4 }],
};

function renderPage(onNavigate = vi.fn()) {
  return {
    onNavigate,
    ...render(
      <NavigationProvider onNavigate={onNavigate}>
        <StatisticsPage />
      </NavigationProvider>,
    ),
  };
}

describe('StatisticsPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    statisticsMocks.refresh.mockReset().mockResolvedValue(populated);
    statisticsMocks.exportData.mockReset().mockResolvedValue(null);
    statisticsMocks.clear.mockReset().mockResolvedValue({ deletedSessions: 2, revision: 3 });
    statisticsMocks.useRuntime.mockReset().mockImplementation(() => ({
      resource: { status: 'ready', data: populated, error: null },
      refresh: statisticsMocks.refresh,
      exportData: statisticsMocks.exportData,
      clear: statisticsMocks.clear,
    }));
  });

  it('renders metrics and accessible range tabs with keyboard activation', () => {
    const { onNavigate } = renderPage();
    expect(screen.getByRole('tablist', { name: 'Statistics range' })).toBeInTheDocument();
    const thirtyDays = screen.getByRole('tab', { name: '30 days' });
    expect(thirtyDays).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Signal/ }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'song', id: 'song-1' });

    thirtyDays.focus();
    fireEvent.keyDown(thirtyDays, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '1 year' })).toHaveFocus();
    expect(statisticsMocks.useRuntime).toHaveBeenLastCalledWith('365-days');
  });

  it('exports through the runtime and requires a second action before clearing', async () => {
    statisticsMocks.exportData.mockResolvedValue({
      path: 'D:\\YAQMC-statistics.json',
      bytes: 120,
      sessionCount: 5,
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(statisticsMocks.exportData).toHaveBeenCalledWith('json'));
    expect(await screen.findByRole('status')).toHaveTextContent('Exported 5 listening sessions.');

    fireEvent.click(screen.getByRole('button', { name: 'Clear statistics' }));
    expect(statisticsMocks.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm clear' }));
    await waitFor(() => expect(statisticsMocks.clear).toHaveBeenCalledOnce());
    expect(await screen.findByRole('status')).toHaveTextContent('Cleared 2 listening sessions.');
  });

  it('shows a stable empty state without ranking placeholders', () => {
    statisticsMocks.useRuntime.mockReturnValue({
      resource: {
        status: 'ready',
        data: { ...populated, recordCount: 0, topSongs: [], daily: [] },
        error: null,
      },
      refresh: statisticsMocks.refresh,
      exportData: statisticsMocks.exportData,
      clear: statisticsMocks.clear,
    });
    renderPage();
    expect(screen.getByRole('heading', { name: 'No listening statistics yet' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Top songs' })).not.toBeInTheDocument();
  });
});
