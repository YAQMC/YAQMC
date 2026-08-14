import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { PluginManager } from './PluginManager';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

vi.mock('../application/native-player-runtime', () => ({
  isNativeRuntime: true,
}));

vi.mock('../application/plugin-runtime', () => ({
  listPlugins: vi.fn(async () => []),
  choosePluginFile: vi.fn(),
  inspectPluginPath: vi.fn(),
  installPlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  setPluginSafeMode: vi.fn(),
  uninstallPlugin: vi.fn(),
  pluginDiagnosticsText: () => '',
}));

describe('PluginManager', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('renders the empty plugin list and install control', async () => {
    render(<PluginManager />);
    expect(await screen.findByText('No plugins are installed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose file/i })).toBeInTheDocument();
  });
});
