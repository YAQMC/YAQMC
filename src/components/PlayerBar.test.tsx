import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
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
  });

  it('enables the Lyrics-specific fullscreen action only when a callback is available', () => {
    const onEnterLyricsFullscreen = vi.fn();
    const { rerender } = render(<PlayerBar onEnterLyricsFullscreen={onEnterLyricsFullscreen} />);

    const enabledEntry = screen.getByRole('button', { name: 'Enter fullscreen lyrics' });
    expect(enabledEntry).toBeEnabled();
    fireEvent.click(enabledEntry);
    expect(onEnterLyricsFullscreen).toHaveBeenCalledOnce();

    rerender(
      <PlayerBar onEnterLyricsFullscreen={onEnterLyricsFullscreen} lyricsFullscreenPending />,
    );
    expect(screen.getByRole('button', { name: 'Enter fullscreen lyrics' })).toBeDisabled();

    rerender(<PlayerBar />);
    expect(screen.getByRole('button', { name: 'Enter fullscreen lyrics' })).toBeDisabled();
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

  it.each([
    ['account-rights', 'Using the best quality available to this account'],
    ['source-unavailable', 'Requested quality is unavailable; using the next available source'],
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

      expect(screen.getByText(copy)).toHaveAttribute('data-fallback-reason', reason);
    },
  );

  it('shows preview progress relative to the clip and seeks on the absolute lyric timeline', () => {
    const track = {
      ...qqTrack(),
      durationMs: 249_000,
      playbackCapability: { status: 'preview', startMs: 200_000, endMs: 249_000 } as const,
    };
    usePlayerStore.setState({
      queue: [track],
      currentIndex: 0,
      positionMs: 220_000,
      playbackDurationMs: 249_000,
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
    fireEvent.change(slider, { target: { value: '30000' } });
    expect(usePlayerStore.getState().positionMs).toBe(230_000);
  });
});
