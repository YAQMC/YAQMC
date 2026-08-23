import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Song } from '../domain/music';
import { useEntityDetail } from './use-entity-detail';

const song = (id: string): Song => ({
  id,
  title: id,
  artists: [{ id: 'artist-1', name: 'Artist' }],
  album: { id: 'album-1', title: 'Album' },
  artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#111' },
  durationMs: 1000,
  trackNumber: 1,
  isFavorite: false,
  quality: 'standard',
  availability: { status: 'available' },
});

function Harness({
  id,
  load,
  preview,
}: {
  id: string;
  load: (id: string, signal: AbortSignal) => Promise<Song>;
  preview?: Song;
}) {
  const resource = useEntityDetail(id, load, preview);
  return (
    <output data-testid="resource">
      {resource.status}:{resource.data?.id ?? resource.error?.message ?? ''}
    </output>
  );
}

describe('useEntityDetail', () => {
  it('shows loading while the provider request is pending', () => {
    const load = vi.fn(() => new Promise<Song>(() => undefined));
    render(<Harness id="song-1" load={load} />);

    expect(screen.getByTestId('resource')).toHaveTextContent('loading:');
  });

  it('shows a provider error when loading fails', async () => {
    const load = vi.fn().mockRejectedValue(new Error('not found'));
    render(<Harness id="song-1" load={load} />);

    await waitFor(() =>
      expect(screen.getByTestId('resource')).toHaveTextContent('error:not found'),
    );
  });

  it('aborts the provider request when the route unmounts', () => {
    let signal: AbortSignal | undefined;
    const load = vi.fn((_id: string, requestSignal: AbortSignal) => {
      signal = requestSignal;
      return new Promise<Song>(() => undefined);
    });
    const view = render(<Harness id="song-1" load={load} />);

    view.unmount();

    expect(signal?.aborted).toBe(true);
  });

  it('always refreshes through the loader even when a preview is present', async () => {
    const load = vi.fn().mockResolvedValue(song('song-1'));
    render(<Harness id="song-1" load={load} preview={song('preview')} />);

    await waitFor(() => expect(screen.getByTestId('resource')).toHaveTextContent('ready:song-1'));
    expect(load).toHaveBeenCalledWith('song-1', expect.any(AbortSignal));
  });

  it('ignores a stale success after the route ID changes', async () => {
    let resolveFirst!: (value: Song) => void;
    const first = new Promise<Song>((resolve) => {
      resolveFirst = resolve;
    });
    const load = vi.fn((id: string) => (id === 'first' ? first : Promise.resolve(song('second'))));
    const view = render(<Harness id="first" load={load} />);

    view.rerender(<Harness id="second" load={load} />);
    await waitFor(() => expect(screen.getByTestId('resource')).toHaveTextContent('ready:second'));

    resolveFirst(song('first'));
    await Promise.resolve();
    expect(screen.getByTestId('resource')).toHaveTextContent('ready:second');
  });

  it('aborts the previous request when the route ID changes', () => {
    const signals: AbortSignal[] = [];
    const load = vi.fn((_id: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<Song>(() => undefined);
    });
    const view = render(<Harness id="first" load={load} />);

    view.rerender(<Harness id="second" load={load} />);

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('ignores a stale error after the route ID changes', async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<Song>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const load = vi.fn((id: string) => (id === 'first' ? first : Promise.resolve(song('second'))));
    const view = render(<Harness id="first" load={load} />);

    view.rerender(<Harness id="second" load={load} />);
    await waitFor(() => expect(screen.getByTestId('resource')).toHaveTextContent('ready:second'));

    rejectFirst(new Error('stale failure'));
    await Promise.resolve();
    expect(screen.getByTestId('resource')).toHaveTextContent('ready:second');
  });
});
