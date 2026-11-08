import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { PluginsPage } from './PluginsPage';

vi.mock('../components/PluginManager', () => ({
  PluginManager: () => <p>manager panel</p>,
}));
vi.mock('../components/PluginStore', () => ({
  PluginStore: () => <p>store panel</p>,
}));
vi.mock('../application/plugin-pages', () => ({
  usePluginNavigation: () => [
    {
      pluginId: 'dev.page',
      pluginName: 'Page plugin',
      id: 'nav',
      label: 'Charts',
      pageId: 'charts',
    },
  ],
}));
vi.mock('../application/plugin-ui', () => ({ usePluginUiSnapshot: () => ({ sidebar: [] }) }));
vi.mock('../application/plugin-runtime', () => ({ dispatchPluginUiAction: vi.fn() }));

describe('PluginsPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('defaults to management and switches tabs through route navigation', () => {
    const onNavigate = vi.fn();
    const view = render(<PluginsPage tab="manage" onNavigate={onNavigate} />);
    expect(screen.getByRole('heading', { name: '插件' })).toBeInTheDocument();
    const manage = screen.getByRole('tab', { name: '插件管理' });
    expect(manage).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('manager panel')).toBeVisible();
    fireEvent.keyDown(manage, { key: 'ArrowRight' });
    expect(onNavigate).toHaveBeenCalledWith({ page: 'plugins', tab: 'store' });
    view.rerender(<PluginsPage tab="store" onNavigate={onNavigate} />);
    expect(screen.getByRole('tab', { name: '插件商店' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('store panel')).toBeVisible();
    // The management panel stays mounted (hidden) so its search and filters survive.
    expect(screen.getByText('manager panel')).not.toBeVisible();
  });

  it('keeps plugin-defined pages reachable from the plugin center', () => {
    const onNavigate = vi.fn();
    render(<PluginsPage tab="manage" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /Charts/ }));
    expect(onNavigate).toHaveBeenCalledWith({
      page: 'plugin-page',
      pluginId: 'dev.page',
      pageId: 'charts',
    });
  });
});
