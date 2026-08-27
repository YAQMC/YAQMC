import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { setPlayerCommandAdapter } from '../application/player-command-adapter';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { defaultPreferences, usePreferencesStore } from '../application/preferences';
import { ProviderContext } from '../application/provider-context';
import { NavigationProvider } from '../application/navigation-context';
import type { AccountSnapshot, FavoriteMutationResult } from '../domain/music';
import { allSongs } from '../providers/fake/fixtures';
import { qqMusicProvider } from '../providers/qqmusic/qq-music-provider';
import i18n from '../i18n';
import { PlayerBar } from './PlayerBar';

const nativeRuntime = vi.hoisted(() => ({ value: true }));

vi.mock('../application/native-player-runtime', () => ({
  get isNativeRuntime() {
    return nativeRuntime.value;
  },
}));

function qqTrack() {
  return {
    ...allSongs[0]!,
    id: 'qqmusic:track:SANITIZED_TRACK_A',
    provider: {
      providerId: 'qqmusic',
      trackId: 'SANITIZED_TRACK_A',
      numericId: 1001,
    },
  };
}

function authenticatedSnapshot(): AccountSnapshot {
  return {
    state: 'authenticated',
    profile: { avatarUrl: null, nickname: 'Listener', maskedIdentity: '10******01' },
    entitlement: {
      tier: 'free',
      membership: 'active',
      expiresAtMs: null,
      permittedQualities: ['standard'],
      observedMaximumQuality: 'standard',
      restrictions: [],
    },
    revision: 3,
    capabilities: {
      qrLogin: true,
      favoriteRead: true,
      favoriteWrite: true,
      playlistRead: true,
      playlistWrite: false,
      recentHistoryRead: true,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('PlayerBar lyrics presentation entry', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    nativeRuntime.value = true;
    resetAccountRuntimeForTest();
    usePlayerStore.setState(initialPlayerState);
    usePreferencesStore.setState(defaultPreferences);
    setPlayerCommandAdapter(null);
    await i18n.changeLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
    setPlayerCommandAdapter(null);
  });

  it('changes QQ Music quality from the player bar through the native command adapter', () => {
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });
    usePlayerStore.setState({ queue: [qqTrack()], currentIndex: 0 });
    render(<PlayerBar />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Audio quality for the current track' }));
    fireEvent.click(screen.getByRole('option', { name: 'Master quality' }));

    expect(commands).toEqual([{ type: 'setQuality', quality: 'master' }]);
  });

  it('maps the three quality capability axes and prevents unsupported selection', () => {
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });
    usePlayerStore.setState({
      queue: [qqTrack()],
      currentIndex: 0,
      sourceSelection: {
        requestedQuality: 'automatic',
        resolvedQuality: 'lossless',
        preview: false,
        qualityCapabilities: [
          {
            quality: 'standard',
            entitlement: 'allowed',
            resource: 'available',
            client: 'supported',
            playable: true,
          },
          {
            quality: 'master',
            entitlement: 'allowed',
            resource: 'available',
            client: 'unsupported',
            playable: false,
          },
        ],
      },
    });
    render(<PlayerBar />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Audio quality for the current track' }));
    expect(screen.getByText('Automatic selection: currently Lossless')).toBeVisible();
    const standard = screen.getByRole('option', { name: /Standard/ });
    expect(standard).toHaveTextContent(
      'Account: allowed · Resource: available · Client: supported',
    );
    const master = screen.getByRole('option', { name: /Master quality/ });
    expect(master).toHaveAttribute('aria-disabled', 'true');
    expect(master).toHaveTextContent(
      'Account: allowed · Resource: available · Client: unsupported',
    );
    fireEvent.click(master);
    expect(commands).toEqual([]);
  });

  it('allows an unprobed higher quality to trigger on-demand source resolution', () => {
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });
    usePlayerStore.setState({
      queue: [qqTrack()],
      currentIndex: 0,
      sourceSelection: {
        requestedQuality: 'lossless',
        resolvedQuality: 'lossless',
        preview: false,
        qualityCapabilities: [
          {
            quality: 'master',
            entitlement: 'allowed',
            resource: 'unknown',
            client: 'supported',
            playable: false,
          },
        ],
      },
    });
    render(<PlayerBar />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Audio quality for the current track' }));
    const master = screen.getByRole('option', { name: /Master quality/ });
    expect(master).not.toHaveAttribute('aria-disabled', 'true');
    expect(master).toHaveTextContent('Account: allowed · Resource: unknown · Client: supported');
    fireEvent.click(master);

    expect(commands).toEqual([{ type: 'setQuality', quality: 'master' }]);
  });

  it('exposes authoritative shuffle as a reversible pressed toggle', () => {
    usePlayerStore.getState().playTracks([qqTrack(), { ...qqTrack(), id: 'second' }]);
    render(<PlayerBar />);

    const trigger = screen.getByRole('button', { name: 'Playback mode: Sequential' });
    expect(trigger).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shuffle' }));

    const shuffle = screen.getByRole('button', { name: 'Playback mode: Shuffle' });
    expect(shuffle).toHaveAttribute('aria-pressed', 'true');
    expect(usePlayerStore.getState().playbackOrder).toBe('shuffle');
    fireEvent.click(shuffle);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sequential' }));

    expect(screen.getByRole('button', { name: 'Playback mode: Sequential' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(usePlayerStore.getState().playbackOrder).toBe('sequential');
  });

  it('opens the lyrics page from the artwork without requesting fullscreen', () => {
    usePreferencesStore.setState({
      ...defaultPreferences,
      surfaces: {
        ...defaultPreferences.surfaces,
        desktop: { ...defaultPreferences.surfaces.desktop, enabled: false },
      },
    });
    usePlayerStore.setState({ queue: [qqTrack()], currentIndex: 0 });
    render(<PlayerBar />);

    expect(screen.queryByRole('button', { name: 'Enter fullscreen lyrics' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open lyrics page' }));

    expect(usePlayerStore.getState()).toMatchObject({ lyricsOpen: true, queueOpen: false });
    expect(usePreferencesStore.getState().surfaces.desktop.enabled).toBe(false);
  });

  it('routes the current title and artists while artwork still opens normal lyrics', () => {
    const track = {
      ...qqTrack(),
      title: 'Linked Current Song',
      artists: [
        { id: 'artist-one', name: 'Artist One' },
        { id: 'artist-two', name: 'Artist Two' },
      ],
    };
    const onNavigate = vi.fn();
    usePlayerStore.setState({ queue: [track], currentIndex: 0 });
    render(
      <NavigationProvider onNavigate={onNavigate}>
        <PlayerBar />
      </NavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Linked Current Song' }));
    fireEvent.click(screen.getByRole('button', { name: 'Artist One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Artist Two' }));
    expect(onNavigate.mock.calls).toEqual([
      [{ page: 'song', id: track.id }],
      [{ page: 'artist', id: 'artist-one' }],
      [{ page: 'artist', id: 'artist-two' }],
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Open lyrics page' }));
    expect(onNavigate).toHaveBeenCalledTimes(3);
    expect(usePlayerStore.getState()).toMatchObject({ lyricsOpen: true, queueOpen: false });
  });

  it('renders blank entity IDs as plain text in the player bar', () => {
    const track = {
      ...qqTrack(),
      id: ' ',
      title: 'Plain Current Song',
      artists: [{ id: ' ', name: 'Plain Artist' }],
    };
    usePlayerStore.setState({ queue: [track], currentIndex: 0 });
    const { container } = render(
      <NavigationProvider onNavigate={vi.fn()}>
        <PlayerBar />
      </NavigationProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Plain Current Song' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Plain Artist' })).toBeNull();
    expect(screen.getByText('Plain Current Song')).toBeInTheDocument();
    expect(screen.getByText('Plain Artist')).toBeInTheDocument();
    expect(container.querySelector('button button')).toBeNull();
  });

  it('toggles desktop lyrics without changing normal lyrics visibility', () => {
    const toggleLyrics = vi.fn();
    usePlayerStore.setState({ lyricsOpen: true, toggleLyrics });
    render(<PlayerBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Enable desktop lyrics' }));

    expect(toggleLyrics).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().lyricsOpen).toBe(true);
    expect(usePreferencesStore.getState().surfaces.desktop.enabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Disable desktop lyrics' })).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('localizes the next-action label in both maintained locales', async () => {
    render(<PlayerBar />);
    expect(screen.getByRole('button', { name: 'Enable desktop lyrics' })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    expect(screen.getByRole('button', { name: '启用桌面歌词' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '启用桌面歌词' }));
    expect(screen.getByRole('button', { name: '停用桌面歌词' })).toBeInTheDocument();
  });

  it('preserves every desktop surface setting while toggling only enabled', () => {
    const desktop = {
      ...defaultPreferences.surfaces.desktop,
      enabled: false,
      interaction: 'passive-locked' as const,
      alwaysOnTop: false,
      hideInFullscreen: false,
      lineMode: 'single' as const,
      fontSize: 44,
      fontMode: 'custom' as const,
      customFontFamily: 'Test Sans',
      alignment: 'left' as const,
      primaryColor: '#102030',
      secondaryColor: '#405060',
      backgroundOpacity: 63,
      horizontalPosition: 42,
      verticalOffset: 119,
      width: 'compact' as const,
    };
    usePreferencesStore.setState({
      ...defaultPreferences,
      surfaces: { ...defaultPreferences.surfaces, desktop },
    });
    render(<PlayerBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Enable desktop lyrics' }));
    expect(usePreferencesStore.getState().surfaces.desktop).toEqual({ ...desktop, enabled: true });

    fireEvent.click(screen.getByRole('button', { name: 'Disable desktop lyrics' }));
    expect(usePreferencesStore.getState().surfaces.desktop).toEqual({ ...desktop, enabled: false });
  });

  it('disables the microphone outside the native runtime but not when there is no song', () => {
    const { unmount } = render(<PlayerBar />);
    expect(screen.getByRole('button', { name: 'Enable desktop lyrics' })).toBeEnabled();

    unmount();
    nativeRuntime.value = false;
    render(<PlayerBar />);
    expect(screen.getByRole('button', { name: 'Enable desktop lyrics' })).toBeDisabled();
  });

  it('delegates Queue entry without changing panel state directly', () => {
    const onToggleQueue = vi.fn();
    render(<PlayerBar onToggleQueue={onToggleQueue} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show queue' }));

    expect(onToggleQueue).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState()).toMatchObject({ queueOpen: false, lyricsOpen: false });
  });

  it('uses the shared favorite projection and exposes pending state', async () => {
    const track = qqTrack();
    const originalFavorite = track.isFavorite;
    const pending = deferred<FavoriteMutationResult>();
    const setFavorite = vi
      .spyOn(qqMusicProvider, 'setFavorite')
      .mockImplementation(() => pending.promise);
    usePlayerStore.setState({ queue: [track], currentIndex: 0 });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(),
      favoriteByTrackId: { [track.id]: false },
    });
    render(
      <ProviderContext.Provider value={qqMusicProvider}>
        <PlayerBar />
      </ProviderContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: `Add ${track.title} to Favorites` }));
    const request = setFavorite.mock.calls[0]![0];
    expect(
      screen.getByRole('button', { name: `Updating favorite for ${track.title}` }),
    ).toBeDisabled();

    await act(async () => {
      pending.resolve({
        clientOperationId: request.clientOperationId,
        status: 'applied',
        trackId: track.id,
        favorite: true,
        errorCode: null,
        authRevision: 3,
      });
      await pending.promise;
    });

    expect(
      screen.getByRole('button', { name: `Remove ${track.title} from Favorites` }),
    ).toBeEnabled();
    expect(usePlayerStore.getState().queue[0]).toBe(track);
    expect(track.isFavorite).toBe(originalFavorite);
  });

  it('keeps restored QQ tracks writable when their stable songmid survives without a numeric id', () => {
    const track = {
      ...qqTrack(),
      provider: {
        providerId: 'qqmusic' as const,
        trackId: 'SANITIZED_TRACK_A',
      },
    };
    usePlayerStore.setState({ queue: [track], currentIndex: 0 });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(),
      favoriteByTrackId: { [track.id]: false },
    });

    render(
      <ProviderContext.Provider value={qqMusicProvider}>
        <PlayerBar />
      </ProviderContext.Provider>,
    );

    expect(screen.getByRole('button', { name: `Add ${track.title} to Favorites` })).toBeEnabled();
  });

  it.each([
    ['account-rights', 'Using the best quality available to this account'],
    ['source-unavailable', 'Requested quality is unavailable; using the next available source'],
    ['entitlement-unknown', 'Premium entitlement could not be confirmed'],
    ['client-unsupported', 'A higher-quality source exists but this client cannot decode it'],
    ['preview-only', 'Playing the official preview'],
  ] as const)(
    'renders the localized %s fallback without parsing provider labels',
    (reason, copy) => {
      const track = qqTrack();
      usePlayerStore.setState({
        queue: [track],
        currentIndex: 0,
        playbackState: 'playing',
        isPlaying: true,
        sourceSelection: {
          requestedQuality: 'lossless',
          resolvedQuality: 'standard',
          fallbackReason: reason,
          preview: reason === 'preview-only',
        },
      } as never);

      render(<PlayerBar />);

      expect(screen.getByText((content) => content.startsWith(copy))).toHaveAttribute(
        'data-fallback-reason',
        reason,
      );
    },
  );

  it('shows preview progress from Core playback duration, not the full-song catalog length', () => {
    const track = {
      ...qqTrack(),
      durationMs: 249_000,
      playbackCapability: { status: 'preview', startMs: 200_000, endMs: 249_000 } as const,
    };
    usePlayerStore.setState({
      queue: [track],
      currentIndex: 0,
      positionMs: 20_000,
      playbackDurationMs: 49_000,
      sourceSelection: {
        requestedQuality: 'automatic',
        resolvedQuality: 'standard',
        fallbackReason: 'preview-only',
        preview: true,
      },
    });

    render(<PlayerBar />);

    expect(screen.getByText('0:20')).toBeVisible();
    expect(screen.getByText('0:49')).toBeVisible();
    const slider = screen.getByRole('slider', { name: 'Playback position' });
    expect(slider).toHaveValue('20000');
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '30000' } });
    fireEvent.pointerUp(slider);
    expect(usePlayerStore.getState().positionMs).toBe(30_000);
  });

  it('keeps the PlayerBar progress control as a native range with shared track geometry', () => {
    usePlayerStore.setState({
      queue: [qqTrack()],
      currentIndex: 0,
      positionMs: 20_000,
      playbackDurationMs: 80_000,
    });
    const { container } = render(<PlayerBar />);
    const row = container.querySelector('.player-progress');
    const slider = screen.getByRole('slider', { name: 'Playback position' });
    expect(row).not.toBeNull();
    expect(row?.children).toHaveLength(3);
    expect(row?.children[0]?.tagName).toBe('SPAN');
    expect(row?.children[1]).toBe(slider);
    expect(row?.children[2]?.tagName).toBe('SPAN');
    expect(slider.tagName).toBe('INPUT');
    expect(slider).toHaveAttribute('type', 'range');
    expect(row?.querySelector('.player-progress__track')).toBeNull();
    expect(row?.querySelector('.player-progress__fill')).toBeNull();
    expect(slider.style.getPropertyValue('--range-progress')).toBe('25%');
  });

  it('does not seek when Chromium echoes a controlled position update', () => {
    const track = {
      ...qqTrack(),
      durationMs: 249_000,
      playbackCapability: { status: 'preview', startMs: 200_000, endMs: 249_000 } as const,
    };
    usePlayerStore.setState({
      queue: [track],
      currentIndex: 0,
      positionMs: 20_000,
      playbackDurationMs: 49_000,
      sourceSelection: {
        requestedQuality: 'automatic',
        resolvedQuality: 'standard',
        fallbackReason: 'preview-only',
        preview: true,
      },
    });

    render(<PlayerBar />);
    fireEvent.change(screen.getByRole('slider', { name: 'Playback position' }), {
      target: { value: '30000' },
    });
    expect(usePlayerStore.getState().positionMs).toBe(20_000);
  });

  it('updates volume immediately while dragging', () => {
    render(<PlayerBar />);
    const slider = screen.getByRole('slider', { name: 'Volume' });
    expect(slider).toHaveValue('0.72');
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '0.2' } });
    expect(slider).toHaveValue('0.2');
    expect(usePlayerStore.getState().volume).toBe(0.2);
    fireEvent.pointerUp(slider);
  });

  it('does not set volume when Chromium echoes a controlled volume update', () => {
    render(<PlayerBar />);
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), {
      target: { value: '0.2' },
    });
    expect(usePlayerStore.getState().volume).toBe(0.72);
  });

  it('keeps the play control node across position ticks', async () => {
    usePlayerStore.setState({
      queue: [qqTrack()],
      currentIndex: 0,
      isPlaying: true,
      playbackState: 'playing',
      positionMs: 1_000,
    });
    const { container } = render(<PlayerBar />);
    const play = container.querySelector('.player-controls__play');
    expect(play).not.toBeNull();
    await act(async () => {
      usePlayerStore.setState({ positionMs: 12_000 });
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(undefined));
      });
    });
    expect(container.querySelector('.player-controls__play')).toBe(play);
  });

  it('keeps progress and volume drafts while playback snapshots arrive', () => {
    const track = {
      ...qqTrack(),
      durationMs: 249_000,
    };
    usePlayerStore.setState({
      queue: [track],
      currentIndex: 0,
      isPlaying: true,
      playbackState: 'playing',
      positionMs: 20_000,
      playbackDurationMs: 49_000,
      volume: 0.72,
    });
    render(<PlayerBar />);
    const progress = screen.getByRole('slider', { name: 'Playback position' });
    const volume = screen.getByRole('slider', { name: 'Volume' });
    fireEvent.pointerDown(progress);
    fireEvent.change(progress, { target: { value: '30000' } });
    fireEvent.pointerDown(volume);
    fireEvent.change(volume, { target: { value: '0.2' } });
    act(() => {
      usePlayerStore.getState().applyExternalSnapshot({
        queue: [track],
        currentIndex: 0,
        positionMs: 12_000,
        isPlaying: true,
        volume: 0.72,
        isMuted: false,
        repeat: 'off',
        shuffle: false,
        playbackState: 'playing',
        playbackDurationMs: 49_000,
        playbackError: null,
        sessionId: 0,
        snapshotRevision: 8,
      });
    });
    expect(progress).toHaveValue('30000');
    expect(volume).toHaveValue('0.2');
    fireEvent.pointerUp(progress);
    fireEvent.pointerUp(volume);
    expect(usePlayerStore.getState().positionMs).toBe(30_000);
    expect(usePlayerStore.getState().volume).toBe(0.2);
  });
});
