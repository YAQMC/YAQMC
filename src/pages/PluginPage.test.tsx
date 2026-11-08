import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPluginPageCall, clearPluginPageContributions } from '../application/plugin-pages';
import { PluginPage } from './PluginPage';

const runtime = vi.hoisted(() => ({
  visibility: vi.fn(),
  action: vi.fn(),
}));

vi.mock('../application/plugin-runtime', () => ({
  notifyPluginPageVisibility: runtime.visibility,
  dispatchPluginPageAction: runtime.action,
}));

const PLUGIN = 'dev.example.pages';

function registerPage(blocks: unknown[] = []) {
  applyPluginPageCall(PLUGIN, 'Listening log', 'ui.pages.register', { id: 'log', title: 'Log' });
  if (blocks.length > 0) {
    applyPluginPageCall(PLUGIN, 'Listening log', 'ui.pages.render', { pageId: 'log', blocks });
  }
}

describe('PluginPage', () => {
  beforeEach(() => {
    runtime.visibility.mockReset();
    runtime.action.mockReset();
  });
  afterEach(() => clearPluginPageContributions());

  it('renders host components for the plugin document with attribution', () => {
    registerPage([
      { type: 'heading', text: 'Recent' },
      { type: 'stats', items: [{ label: 'Plays', value: '3' }] },
      { type: 'text', text: '<b>not markup</b>' },
      { type: 'list', items: [{ id: 'a', title: 'Song A', actionId: 'open-a' }] },
      { type: 'actions', items: [{ id: 'clear', label: 'Clear', variant: 'primary' }] },
    ]);
    const { container } = render(<PluginPage pluginId={PLUGIN} pageId="log" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Log' })).toBeVisible();
    expect(screen.getByText('Provided by Listening log')).toBeVisible();
    expect(screen.getByText('<b>not markup</b>')).toBeVisible();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('Plays')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Song A' }));
    expect(runtime.action.mock.calls).toEqual([
      [PLUGIN, 'log', 'clear'],
      [PLUGIN, 'log', 'open-a'],
    ]);
  });

  it('tells only the owning plugin when the page mounts and unmounts', () => {
    registerPage();
    const { unmount } = render(<PluginPage pluginId={PLUGIN} pageId="log" />);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for Listening log');
    expect(runtime.visibility).toHaveBeenLastCalledWith(PLUGIN, 'log', true);
    unmount();
    expect(runtime.visibility).toHaveBeenLastCalledWith(PLUGIN, 'log', false);
  });

  it('shows an unavailable state when the plugin no longer provides the page', () => {
    registerPage();
    render(<PluginPage pluginId={PLUGIN} pageId="log" />);
    act(() => clearPluginPageContributions(PLUGIN));
    expect(screen.getByRole('alert')).toHaveTextContent('This plugin page is unavailable');
    expect(runtime.visibility).toHaveBeenLastCalledWith(PLUGIN, 'log', false);
  });
});
