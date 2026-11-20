import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProviderContext } from '../application/provider-context';
import type { MusicVideo } from '../domain/music';
import { FakeMusicProvider } from '../providers/fake/fake-music-provider';
import { MvPage } from './MvPage';

const video: MusicVideo = {
  id: 'mv-1',
  title: 'Night Flight',
  artist: 'Mira Vale',
  artwork: { src: '/cover.jpg', alt: 'Night Flight', dominantColor: '#123456' },
  durationMs: 245_000,
  description: 'A live performance filmed after sunset.',
  playCount: 12_345,
  streamUrl: 'http://127.0.0.1:49152/mv/opaque-token',
};

describe('MvPage', () => {
  it('uses the protected stream and presents MV metadata', () => {
    render(
      <ProviderContext.Provider value={new FakeMusicProvider()}>
        <MvPage video={video} />
      </ProviderContext.Provider>,
    );

    const player = screen.getByLabelText('Music video: Night Flight');
    expect(player.tagName).toBe('VIDEO');
    expect(player).toHaveAttribute('src', video.streamUrl);
    expect(player).toHaveAttribute('poster', video.artwork.src);
    expect(screen.getByRole('heading', { name: 'Night Flight' })).toBeInTheDocument();
    expect(screen.getByText('Mira Vale')).toBeInTheDocument();
    expect(screen.getByText('A live performance filmed after sunset.')).toBeInTheDocument();
    expect(screen.getByText(/12\.3K views/)).toBeInTheDocument();
  });
});
