import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { setPlayerCommandAdapter } from '../application/player-command-adapter';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import type { AccountSnapshot, FavoriteMutationResult } from '../domain/music';
import { allSongs } from '../providers/fake/fixtures';
import { qqMusicProvider } from '../providers/qqmusic/qq-music-provider';
import { PlayerBar } from './PlayerBar';

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
  beforeEach(() => {
    vi.restoreAllMocks();
    resetAccountRuntimeForTest();
    usePlayerStore.setState(initialPlayerState);
    setPlayerCommandAdapter(null);
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
    usePlayerStore.setState({ queue: [qqTrack()], currentIndex: 0 });
    render(<PlayerBar />);

    expect(screen.queryByRole('button', { name: 'Enter fullscreen lyrics' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open lyrics page' }));

    expect(usePlayerStore.getState()).toMatchObject({ lyricsOpen: true, queueOpen: false });
  });

  it('delegates an open Lyrics panel to safe close without changing visibility directly', () => {
    usePlayerStore.setState({ lyricsOpen: true });
    const onCloseLyrics = vi.fn();
    render(<PlayerBar onCloseLyrics={onCloseLyrics} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show lyrics' }));

    expect(onCloseLyrics).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().lyricsOpen).toBe(true);
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
});
