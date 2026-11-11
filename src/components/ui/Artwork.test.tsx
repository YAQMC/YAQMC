import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Artwork } from './Artwork';

vi.mock('../../application/artwork-source', () => ({
  useSafeArtworkSource: (source: string) => source || null,
}));

const cover = (src: string) => ({ src, alt: 'Playlist cover', dominantColor: '#102030' });

describe('Artwork image failures', () => {
  it('uses the fallback after a decode/load failure and recovers when the cover changes', () => {
    const { rerender } = render(
      <Artwork artwork={cover('/missing-cover.svg')} fallback={<span>Unavailable</span>} />,
    );
    fireEvent.error(screen.getByRole('img', { name: 'Playlist cover' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeVisible();
    rerender(
      <Artwork
        artwork={cover('https://music-file.y.qq.com/songlist/custom.jpg')}
        fallback={<span>Unavailable</span>}
      />,
    );
    expect(screen.getByRole('img', { name: 'Playlist cover' })).toHaveAttribute(
      'src',
      'https://music-file.y.qq.com/songlist/custom.jpg',
    );
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
  });

  it('keeps missing artwork as a host placeholder without requesting an absent fixture asset', () => {
    const { container } = render(<Artwork artwork={cover('')} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('.artwork')).toBeInTheDocument();
  });
});
