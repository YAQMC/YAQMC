import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import {
  choosePluginFile,
  listPlugins,
  pluginHostSafeMode,
  pluginHostDeveloperMode,
  reloadPlugin,
  setPluginEnabled,
  setPluginSafeMode,
  type PluginRecord,
} from '../application/plugin-runtime';
import { PluginManager } from './PluginManager';

vi.mock('../application/host-capabilities', () => ({
  hasHostCapability: (capability: string) => capability === 'plugins',
}));

vi.mock('../application/plugin-runtime', () => ({
  listPlugins: vi.fn(async () => []),
  pluginHostSafeMode: vi.fn(async () => false),
  pluginHostDeveloperMode: vi.fn(async () => false),
  choosePluginFile: vi.fn(),
  choosePluginDirectory: vi.fn(),
  inspectPluginPath: vi.fn(),
  installPlugin: vi.fn(),
  installUnpackedPlugin: vi.fn(),
  reloadPlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  setPluginSafeMode: vi.fn(),
  setPluginDeveloperMode: vi.fn(),
  uninstallPlugin: vi.fn(),
  pluginDiagnosticsText: () => '',
}));

describe('PluginManager', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    vi.mocked(listPlugins).mockResolvedValue([]);
    vi.mocked(pluginHostSafeMode).mockResolvedValue(false);
    vi.mocked(choosePluginFile).mockReset();
    vi.mocked(setPluginSafeMode).mockReset();
    vi.mocked(setPluginEnabled).mockReset();
    vi.mocked(pluginHostDeveloperMode).mockResolvedValue(false);
    vi.mocked(reloadPlugin).mockReset();
  });

  it('renders the empty plugin list and install control', async () => {
    render(<PluginManager />);
    expect(await screen.findByText('No plugins are installed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose file/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enter safe mode/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('shows choose-file errors instead of failing silently', async () => {
    vi.mocked(choosePluginFile).mockRejectedValueOnce(new Error('dialog denied'));
    render(<PluginManager />);
    fireEvent.click(await screen.findByRole('button', { name: /choose file/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('dialog denied');
  });

  it('toggles Safe Mode from host state even when no plugins are installed', async () => {
    vi.mocked(setPluginSafeMode).mockImplementation(async (enabled) => {
      vi.mocked(pluginHostSafeMode).mockResolvedValue(enabled);
      return enabled;
    });
    render(<PluginManager />);
    fireEvent.click(await screen.findByRole('button', { name: /enter safe mode/i }));
    expect(await screen.findByRole('button', { name: /leave safe mode/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getByText(
        'Safe Mode is on. Third-party styles, scenes, scripts, and providers are unloaded.',
      ),
    ).toBeInTheDocument();
    expect(setPluginSafeMode).toHaveBeenCalledWith(true);
  });

  it('restores Safe Mode from the host when the list is empty', async () => {
    vi.mocked(pluginHostSafeMode).mockResolvedValue(true);
    render(<PluginManager />);
    expect(await screen.findByRole('button', { name: /leave safe mode/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByText(
          'Safe Mode is on. Third-party styles, scenes, scripts, and providers are unloaded.',
        ),
      ).toBeInTheDocument();
    });
  });

  it('presents installed plugins as a localized status list with stable actions', async () => {
    const plugin: PluginRecord = {
      id: 'dev.yaqmc.lyrics-scenes',
      name: 'Lyrics scenes',
      version: '1.0.0',
      description: 'Synthetic fixture',
      authors: ['YAQMC'],
      enabled: false,
      status: 'disabled',
      apiVersion: 1,
      packageSha256: 'a'.repeat(64),
      source: 'local',
      unsigned: true,
      entrypoints: { styles: 1, scenes: 1, script: false },
      permissions: [],
      grantedPermissions: [],
      riskRating: 'low',
      styleScan: { severity: null, findings: [] },
      scriptScan: { severity: null, findings: [] },
      compatible: true,
      platforms: ['win32'],
    };
    vi.mocked(listPlugins).mockResolvedValue([plugin]);
    vi.mocked(setPluginEnabled).mockResolvedValue({ ...plugin, enabled: true, status: 'active' });

    render(<PluginManager />);

    expect(await screen.findByRole('heading', { name: 'Installed plugins' })).toBeInTheDocument();
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText('Styles')).toBeInTheDocument();
    expect(screen.getByText('Scenes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Lyrics scenes details' })).toBeInTheDocument();
    const enable = screen.getByRole('button', { name: 'Enable' });
    expect(enable).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(enable);
    await waitFor(() => expect(setPluginEnabled).toHaveBeenCalledWith(plugin.id, true, []));
  });

  const providerPlugin: PluginRecord = {
    id: 'dev.yaqmc.test-provider',
    name: 'Test provider',
    version: '1.0.0',
    description: 'Test description',
    authors: ['Test'],
    enabled: false,
    status: 'disabled',
    apiVersion: 3,
    packageSha256: 'a'.repeat(64),
    source: 'local',
    unsigned: true,
    entrypoints: { styles: 0, scenes: 0, script: false, component: true },
    permissions: ['provider.catalog', 'provider.account', 'network:https://example.com'],
    grantedPermissions: ['provider.catalog'],
    riskRating: 'high',
    styleScan: { severity: null, findings: [] },
    scriptScan: { severity: null, findings: [] },
    compatible: true,
    platforms: ['win32'],
    unpackedPath: '/test/provider',
  };

  it('never grants previously denied sensitive permissions when enabling a plugin', async () => {
    vi.mocked(listPlugins).mockResolvedValue([providerPlugin]);
    render(<PluginManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    const review = screen.getByRole('region', { name: 'Review plugin permissions' });
    expect(setPluginEnabled).not.toHaveBeenCalled();
    expect(within(review).getByRole('button', { name: 'Enable' })).toBeDisabled();
    for (const checkbox of within(review).getAllByRole('checkbox')) {
      expect(checkbox).not.toBeChecked();
      fireEvent.click(checkbox);
    }
    fireEvent.click(within(review).getByRole('button', { name: 'Enable' }));
    await waitFor(() =>
      expect(setPluginEnabled).toHaveBeenCalledWith(
        providerPlugin.id,
        true,
        providerPlugin.permissions,
      ),
    );
  });

  it('preserves existing grants without prompting again and allows cancelling new grants', async () => {
    vi.mocked(listPlugins).mockResolvedValue([providerPlugin]);
    const view = render(<PluginManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.queryByRole('region', { name: 'Review plugin permissions' }),
    ).not.toBeInTheDocument();
    expect(setPluginEnabled).not.toHaveBeenCalled();
    view.unmount();
    vi.mocked(listPlugins).mockResolvedValue([
      { ...providerPlugin, grantedPermissions: providerPlugin.permissions },
    ]);
    render(<PluginManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    await waitFor(() =>
      expect(setPluginEnabled).toHaveBeenCalledWith(
        providerPlugin.id,
        true,
        providerPlugin.permissions,
      ),
    );
    expect(
      screen.queryByRole('region', { name: 'Review plugin permissions' }),
    ).not.toBeInTheDocument();
  });

  it('prevents enabling plugins while safe mode is active', async () => {
    vi.mocked(listPlugins).mockResolvedValue([providerPlugin]);
    vi.mocked(pluginHostSafeMode).mockResolvedValue(true);
    render(<PluginManager />);
    const enable = await screen.findByRole('button', { name: 'Enable' });
    expect(enable).toBeDisabled();
    fireEvent.click(enable);
    expect(setPluginEnabled).not.toHaveBeenCalled();
  });

  it('reports reload failures and prevents concurrent detail mutations', async () => {
    vi.mocked(listPlugins).mockResolvedValue([providerPlugin]);
    vi.mocked(pluginHostDeveloperMode).mockResolvedValue(true);
    let rejectReload!: (error: Error) => void;
    vi.mocked(reloadPlugin).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectReload = reject;
        }),
    );
    render(<PluginManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Test provider details' }));
    const dialog = screen.getByRole('dialog', { name: providerPlugin.name });
    fireEvent.click(within(dialog).getByRole('button', { name: /reload/i }));
    expect(within(dialog).getByRole('button', { name: /reload/i })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^uninstall$/i })).toBeDisabled();
    await act(async () => rejectReload(new Error('Component validation failed')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Component validation failed');
    expect(within(dialog).getByRole('button', { name: /reload/i })).toBeEnabled();
  });

  it('refreshes open details after a successful reload', async () => {
    vi.mocked(listPlugins).mockResolvedValue([providerPlugin]);
    vi.mocked(pluginHostDeveloperMode).mockResolvedValue(true);
    vi.mocked(reloadPlugin).mockImplementation(async () => {
      const next = { ...providerPlugin, description: 'Updated description', version: '1.1.0' };
      vi.mocked(listPlugins).mockResolvedValue([next]);
      return next;
    });
    render(<PluginManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Test provider details' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /reload/i }));
    expect(await screen.findByText('Updated description')).toBeInTheDocument();
    expect(screen.queryByText('Test description')).not.toBeInTheDocument();
  });

  it('reports clipboard failures instead of leaving an unhandled rejection', async () => {
    vi.mocked(listPlugins).mockResolvedValue([providerPlugin]);
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard permission denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<PluginManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Test provider details' }));
    fireEvent.click(screen.getByRole('button', { name: /copy plugin diagnostics/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Clipboard permission denied');
  });
});
