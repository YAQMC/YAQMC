import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LyricsWindowControls } from './LyricsWindowControls';

const host = vi.hoisted(() => ({
  supported: true,
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../application/host-capabilities', () => ({
  supportsWindowControls: () => host.supported,
}));
vi.mock('../application/yaqmc-runtime', () => ({
  getYaqmcClient: () => ({ host: { window: host } }),
}));
vi.mock('../application/logger', () => ({ logger: { error: vi.fn() } }));

afterEach(() => {
  host.supported = true;
  vi.clearAllMocks();
});

describe('native lyrics window controls', () => {
  it('offers window commands without a plugin and invokes them only on user input', () => {
    const { container } = render(<LyricsWindowControls />);
    expect(container.firstChild).toHaveClass('yaqmc-no-drag');
    expect(host.minimize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize / Restore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(host.minimize).toHaveBeenCalledTimes(1);
    expect(host.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it('does not show desktop commands on unsupported hosts', () => {
    host.supported = false;
    render(<LyricsWindowControls />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
