import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlayerCommandAdapter } from '../application/player-command-adapter';
import type { AppRoute } from '../application/navigation';
import { initialPlayerState, usePlayerStore, type QueueEntry } from '../application/player-store';
import type { Song } from '../domain/music';
import { NavigationProvider } from '../application/navigation-context';
import '../styles/components.css';
import { QueuePanel } from './QueuePanel';

const track = (
  id: string,
  artists: Song['artists'] = [{ id: 'artist', name: 'Artist' }],
): Song => ({
  id,
  title: id,
  artists,
  album: { id: 'album', title: 'Album' },
  artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000' },
  durationMs: 10_000,
  trackNumber: 1,
  isFavorite: false,
  quality: 'high',
  availability: { status: 'available' },
});

function openQueue(): QueueEntry[] {
  const entries = [
    { id: 'entry-current', track: track('current') },
    { id: 'entry-two', track: track('two') },
    { id: 'entry-three', track: track('three') },
    { id: 'entry-four', track: track('four') },
  ];
  usePlayerStore.setState({
    ...initialPlayerState,
    queue: entries.map((entry) => entry.track),
    queueEntries: entries,
    currentIndex: 0,
    currentQueueEntryId: entries[0]!.id,
    upcomingQueueEntryIds: entries.slice(1).map((entry) => entry.id),
    queueOpen: true,
  });
  return entries;
}

function renderWithNavigation(onNavigate: (target: AppRoute) => void) {
  return render(
    <NavigationProvider onNavigate={onNavigate}>
      <QueuePanel />
    </NavigationProvider>,
  );
}

describe('QueuePanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setPlayerCommandAdapter(null);
    openQueue();
  });

  afterEach(() => {
    setPlayerCommandAdapter(null);
    cleanup();
  });

  it('routes now-playing title and every artist without issuing a player command', () => {
    const nowPlaying = track('current-song', [
      { id: 'current-artist-a', name: 'Current Artist A' },
      { id: 'current-artist-b', name: 'Current Artist B' },
    ]);
    const entries = openQueue();
    usePlayerStore.setState({
      queue: [nowPlaying, ...entries.slice(1).map((entry) => entry.track)],
      queueEntries: [{ ...entries[0]!, track: nowPlaying }, ...entries.slice(1)],
    });
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });
    const onNavigate = vi.fn();
    renderWithNavigation(onNavigate);

    fireEvent.click(screen.getByRole('button', { name: 'current-song' }));
    fireEvent.click(screen.getByRole('button', { name: 'Current Artist A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Current Artist B' }));

    expect(onNavigate).toHaveBeenNthCalledWith(1, { page: 'song', id: 'current-song' });
    expect(onNavigate).toHaveBeenNthCalledWith(2, {
      page: 'artist',
      id: 'current-artist-a',
    });
    expect(onNavigate).toHaveBeenNthCalledWith(3, {
      page: 'artist',
      id: 'current-artist-b',
    });
    expect(commands).toEqual([]);
  });

  it('routes up-next title and every artist while play remains a durable entry action', () => {
    const upNext = track('up-next-song', [
      { id: 'up-next-artist-a', name: 'Up Next Artist A' },
      { id: 'up-next-artist-b', name: 'Up Next Artist B' },
    ]);
    const entries = openQueue();
    usePlayerStore.setState({
      queue: [entries[0]!.track, upNext, ...entries.slice(2).map((entry) => entry.track)],
      queueEntries: [entries[0]!, { ...entries[1]!, track: upNext }, ...entries.slice(2)],
    });
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });
    const onNavigate = vi.fn();
    renderWithNavigation(onNavigate);

    fireEvent.click(screen.getByRole('button', { name: 'up-next-song' }));
    fireEvent.click(screen.getByRole('button', { name: 'Up Next Artist A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Up Next Artist B' }));
    expect(onNavigate).toHaveBeenNthCalledWith(1, { page: 'song', id: 'up-next-song' });
    expect(onNavigate).toHaveBeenNthCalledWith(2, {
      page: 'artist',
      id: 'up-next-artist-a',
    });
    expect(onNavigate).toHaveBeenNthCalledWith(3, {
      page: 'artist',
      id: 'up-next-artist-b',
    });
    expect(commands).toEqual([]);

    const playButton = screen.getByRole('button', { name: 'Play now up-next-song' });
    expect(playButton).toBeVisible();
    expect(getComputedStyle(playButton).opacity).toBe('0.65');
    fireEvent.click(playButton);
    expect(commands).toEqual([{ type: 'playQueueEntry', entryId: 'entry-two' }]);
  });

  it('keeps blank entity IDs as text and never nests entity controls', () => {
    const blankIds = {
      ...track('', [
        { id: '', name: 'Blank ID Artist' },
        { id: '   ', name: 'Whitespace ID Artist' },
      ]),
      title: 'blank-song',
    };
    const entries = openQueue();
    usePlayerStore.setState({
      queue: [entries[0]!.track, blankIds, ...entries.slice(2).map((entry) => entry.track)],
      queueEntries: [entries[0]!, { ...entries[1]!, track: blankIds }, ...entries.slice(2)],
    });
    const onNavigate = vi.fn();
    const { container } = renderWithNavigation(onNavigate);

    expect(screen.queryByRole('button', { name: 'blank-song' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Blank ID Artist' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Whitespace ID Artist' })).not.toBeInTheDocument();
    expect(container.querySelector('.queue-row__title')).toHaveProperty('tagName', 'SPAN');
    expect(container.querySelector('.queue-row__artist')).toHaveProperty('tagName', 'SPAN');
    expect(container.querySelector('button button')).not.toBeInTheDocument();
    expect(container.querySelector('button a')).not.toBeInTheDocument();
  });

  it('opens a portalled menu above the panel and exposes capability-aware actions', () => {
    render(<QueuePanel />);

    fireEvent.click(screen.getByRole('button', { name: 'More queue actions for two' }));

    const menu = screen.getByRole('menu', { name: 'More queue actions for two' });
    expect(menu).toHaveAttribute('data-portal', 'true');
    expect(menu.parentElement).toBe(document.body);
    expect(within(menu).getByRole('menuitem', { name: 'Play now' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Play next' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Remove from queue' })).toBeEnabled();

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'More queue actions for current' }));
    expect(screen.getByRole('menuitem', { name: 'Currently playing' })).toBeDisabled();
    expect(screen.queryByRole('menuitem', { name: 'Remove from queue' })).not.toBeInTheDocument();
  });

  it('closes the menu with Escape and an outside pointer press', () => {
    const appEscape = vi.fn();
    window.addEventListener('keydown', appEscape);
    render(<QueuePanel />);
    const trigger = screen.getByRole('button', { name: 'More queue actions for two' });

    fireEvent.click(trigger);
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, escape);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(escape.defaultPrevented).toBe(true);
    expect(appEscape).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    window.removeEventListener('keydown', appEscape);
  });

  it.each([
    ['Play now', { type: 'playQueueEntry', entryId: 'entry-two' }],
    ['Play next', { type: 'playNextQueueEntry', entryId: 'entry-two' }],
    ['Remove from queue', { type: 'removeQueueEntry', entryId: 'entry-two' }],
  ] as const)('sends the %s action by QueueEntry identity', (label, expected) => {
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });
    render(<QueuePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'More queue actions for two' }));
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    expect(commands).toEqual([expected]);
  });

  it('supports keyboard queue reorder by durable entry identity', () => {
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });
    render(<QueuePanel />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Move three in queue' }), {
      key: 'ArrowUp',
    });

    expect(commands).toEqual([
      { type: 'reorderQueueEntry', entryId: 'entry-three', targetIndex: 1 },
    ]);
  });

  it('starts pointer drag only after a movement threshold and reorders the authoritative entry', () => {
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });
    render(<QueuePanel />);
    const grip = screen.getByRole('button', { name: 'Move two in queue' });
    const target = screen.getByText('four').closest<HTMLElement>('[data-queue-entry-id]')!;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });

    fireEvent.pointerDown(grip, { pointerId: 7, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 12, clientY: 12 });
    expect(commands).toEqual([]);
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 20, clientY: 20 });
    expect(grip.closest('[data-queue-entry-id]')).toHaveAttribute('data-dragging', 'true');
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 20, clientY: 20 });

    expect(commands).toEqual([{ type: 'reorderQueueEntry', entryId: 'entry-two', targetIndex: 3 }]);
  });

  it('renders actual shuffled upcoming traversal instead of canonical order', () => {
    usePlayerStore.setState({
      playbackOrder: 'shuffle',
      shuffle: true,
      shuffleTraversal: ['entry-current', 'entry-four', 'entry-two', 'entry-three'],
      upcomingQueueEntryIds: ['entry-four', 'entry-two', 'entry-three'],
    });
    render(<QueuePanel />);

    const rows = screen
      .getAllByRole('button', { name: /^More queue actions for/ })
      .slice(1)
      .map((button) => button.getAttribute('aria-label'));
    expect(rows).toEqual([
      'More queue actions for four',
      'More queue actions for two',
      'More queue actions for three',
    ]);
    expect(screen.getByText('Shuffle order')).toBeVisible();
  });

  it('shows a Repeat One indicator without duplicating the current track', () => {
    usePlayerStore.setState({
      repeat: 'one',
      upcomingQueueEntryIds: ['entry-two', 'entry-three', 'entry-four'],
    });
    render(<QueuePanel />);

    expect(screen.getByText('Repeating this track')).toBeVisible();
    expect(screen.getByText('Now playing').parentElement).toHaveTextContent('current');
    expect(screen.queryAllByText('current')).toHaveLength(1);
  });

  it('does not invent sequential entries after authoritative shuffle traversal is exhausted', () => {
    usePlayerStore.setState({
      currentIndex: 1,
      currentQueueEntryId: 'entry-two',
      playbackOrder: 'shuffle',
      shuffle: true,
      shuffleTraversal: ['entry-current', 'entry-three', 'entry-four', 'entry-two'],
      shuffleCursor: 3,
      upcomingQueueEntryIds: [],
    });
    render(<QueuePanel />);

    expect(screen.getByText('two')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /^More queue actions for (three|four)$/ }),
    ).not.toBeInTheDocument();
  });
});
