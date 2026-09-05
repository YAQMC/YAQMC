import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HostCapabilities from '../application/host-capabilities';
import { AndroidBottomNav, Sidebar } from './Sidebar';

const androidRuntime = vi.hoisted(() => ({ value: true }));

vi.mock('../application/host-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof HostCapabilities>()),
  isAndroidRuntime: () => androidRuntime.value,
}));

describe('Android Sidebar', () => {
  beforeEach(() => {
    androidRuntime.value = true;
  });

  it('keeps icon-only rail destinations named when their visible text is compacted', () => {
    render(<Sidebar route={{ page: 'search' }} onNavigate={vi.fn()} />);
    const navigation = screen.getByRole('navigation');
    expect(navigation.querySelectorAll('button')).toHaveLength(4);
    for (const label of ['Home', 'Explore', 'Library', 'Search']) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-label', label);
    }
  });

  it('keeps the guest avatar as the sole Android rail settings entry', () => {
    const onNavigate = vi.fn();
    render(<Sidebar route={{ page: 'home' }} onNavigate={onNavigate} />);
    const account = screen.getByRole('button', { name: 'Open application settings' });
    expect(account).toHaveAttribute('type', 'button');
    expect(account).toHaveAttribute('data-yaqmc', 'account-avatar');
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    account.focus();
    expect(account).toHaveFocus();
    fireEvent.click(account);
    expect(onNavigate).toHaveBeenCalledWith({ page: 'settings' });
  });

  it('retains the existing desktop navigation rather than using the compact Android branch', () => {
    androidRuntime.value = false;
    render(<Sidebar route={{ page: 'home' }} onNavigate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Favorites' })).toBeInTheDocument();
  });
});

describe('AndroidBottomNav', () => {
  it('renders the four Android destinations and navigates by route', () => {
    const onNavigate = vi.fn();
    render(<AndroidBottomNav route={{ page: 'home' }} onNavigate={onNavigate} />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Library' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Playlists' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'explore' });
  });

  it('keeps Library selected on every nested library destination', () => {
    render(<AndroidBottomNav route={{ page: 'statistics' }} onNavigate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Library' })).toHaveAttribute('data-active', 'true');
  });
});
