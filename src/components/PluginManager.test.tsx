import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import {
  choosePluginFile,
  pluginHostSafeMode,
  setPluginSafeMode,
} from '../application/plugin-runtime';
import { PluginManager } from './PluginManager';

vi.mock('../application/native-player-runtime', () => ({
  isNativeRuntime: true,
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
    vi.mocked(pluginHostSafeMode).mockResolvedValue(false);
    vi.mocked(choosePluginFile).mockReset();
    vi.mocked(setPluginSafeMode).mockReset();
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
      screen.getByText('Safe Mode is on. Third-party styles, scenes, and scripts are unloaded.'),
    ).toBeInTheDocument();
    expect(setPluginSafeMode).toHaveBeenCalledWith(true);
  });

  it('restores Safe Mode from the host when the list is empty', async () => {
    vi.mocked(pluginHostSafeMode).mockResolvedValue(true);
    render(<PluginManager />);
    expect(await screen.findByRole('button', { name: /leave safe mode/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByText('Safe Mode is on. Third-party styles, scenes, and scripts are unloaded.'),
      ).toBeInTheDocument();
    });
  });
});
