import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPluginUi,
  registerPluginLyricsAction,
  unregisterPluginLyricsAction,
} from '../application/plugin-ui';
import { PluginLyricsActions } from './PluginLyricsActions';

const host = vi.hoisted(() => ({
  supported: true,
  minimize: vi.fn().mockResolvedValue(undefined),
  dispatch: vi.fn(),
}));
vi.mock('../application/host-capabilities', () => ({
  supportsWindowControls: () => host.supported,
}));
vi.mock('../application/plugin-runtime', () => ({ dispatchPluginUiAction: host.dispatch }));
vi.mock('../application/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('../application/yaqmc-runtime', () => ({
  getYaqmcClient: () => ({ host: { window: { minimize: host.minimize } } }),
}));

afterEach(() => {
  cleanup();
  clearPluginUi();
  host.supported = true;
  vi.clearAllMocks();
});

const base = { pluginId: 'dev.test', pluginName: 'Test', id: 'minimize', label: 'Minimize' };

describe('lyrics toolbar plugin actions', () => {
  it('performs a window command only after a click, then removes retired controls', () => {
    registerPluginLyricsAction({ ...base, windowAction: 'minimize' });
    render(<PluginLyricsActions />);
    expect(host.minimize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(host.minimize).toHaveBeenCalledTimes(1);
    expect(host.dispatch).not.toHaveBeenCalled();
    act(() => clearPluginUi('dev.test'));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps ordinary actions on hosts without window controls and addresses the owner only', () => {
    host.supported = false;
    registerPluginLyricsAction({ ...base, windowAction: 'minimize' });
    registerPluginLyricsAction({ ...base, id: 'info', label: 'Info' });
    render(<PluginLyricsActions />);
    expect(screen.queryByRole('button', { name: 'Minimize' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Info' }));
    expect(host.dispatch).toHaveBeenCalledExactlyOnceWith('dev.test', 'info', 'lyrics');
    act(() => unregisterPluginLyricsAction('another.plugin', 'info'));
    expect(screen.getByRole('button', { name: 'Info' })).toBeInTheDocument();
    act(() => unregisterPluginLyricsAction('dev.test', 'info'));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
